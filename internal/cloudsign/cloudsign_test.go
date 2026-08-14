package cloudsign

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/richardwooding/parley/wire"
	"golang.org/x/time/rate"
)

func testHandler(t *testing.T) *Handler {
	t.Helper()
	h, err := New(Config{
		Endpoint:  "https://s3.example.com",
		Bucket:    "workspaces",
		Region:    "auto",
		AccessKey: "AKIAEXAMPLE",
		SecretKey: "secret-key-value",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return h
}

func mustSID(t *testing.T, hexstr string) wire.SessionID {
	t.Helper()
	sid, err := wire.ParseSessionID(hexstr)
	if err != nil {
		t.Fatalf("ParseSessionID(%q): %v", hexstr, err)
	}
	return sid
}

func post(t *testing.T, h *Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/cloud/presign", strings.NewReader(body))
	req.RemoteAddr = "203.0.113.7:5555"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestConfigFromEnvDormantWhenUnset(t *testing.T) {
	// Clear all inputs; must report dormant.
	for _, k := range []string{"AWS_ENDPOINT_URL_S3", "BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"} {
		t.Setenv(k, "")
	}
	if _, ok := ConfigFromEnv(); ok {
		t.Fatal("expected dormant (ok=false) with no env set")
	}
	// Missing just the bucket is still dormant.
	t.Setenv("AWS_ENDPOINT_URL_S3", "https://fly.storage.tigris.dev")
	t.Setenv("AWS_ACCESS_KEY_ID", "AK")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SK")
	if _, ok := ConfigFromEnv(); ok {
		t.Fatal("expected dormant with BUCKET_NAME missing")
	}
	// Fully configured → enabled, region defaults to auto.
	t.Setenv("BUCKET_NAME", "b")
	cfg, ok := ConfigFromEnv()
	if !ok {
		t.Fatal("expected enabled when fully configured")
	}
	if cfg.Region != "auto" {
		t.Fatalf("region default = %q, want auto", cfg.Region)
	}
}

func TestMethodGuard(t *testing.T) {
	h := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/cloud/presign", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", rr.Code)
	}
}

func TestBadSessionID(t *testing.T) {
	h := testHandler(t)
	for _, body := range []string{
		`{"sid":"not-hex","op":"get"}`,
		`{"sid":"abcd","op":"get"}`, // too short
		`{"op":"get"}`,              // missing
	} {
		rr := post(t, h, body)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("body %s → status %d, want 400", body, rr.Code)
		}
	}
}

func TestBadOp(t *testing.T) {
	h := testHandler(t)
	rr := post(t, h, `{"sid":"0123456789abcdef0123456789abcdef","op":"delete"}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad op → status %d, want 400", rr.Code)
	}
}

func TestOversizedBody(t *testing.T) {
	h := testHandler(t)
	big := `{"sid":"0123456789abcdef0123456789abcdef","op":"get","pad":"` + strings.Repeat("x", maxBody*2) + `"}`
	rr := post(t, h, big)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("oversized body → status %d, want 400", rr.Code)
	}
}

func TestPresignPutAndGet(t *testing.T) {
	h := testHandler(t)
	for _, op := range []string{"put", "get"} {
		rr := post(t, h, `{"sid":"0123456789abcdef0123456789abcdef","op":"`+op+`"}`)
		if rr.Code != http.StatusOK {
			t.Fatalf("op=%s → status %d, want 200 (%s)", op, rr.Code, rr.Body.String())
		}
		var out struct {
			URL string `json:"url"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("op=%s decode: %v", op, err)
		}
		sid := mustSID(t, "0123456789abcdef0123456789abcdef")
		wantKey := ObjectKey(h.cfg.SecretKey, sid)
		if !strings.Contains(out.URL, wantKey) {
			t.Fatalf("op=%s url %q missing object key %q", op, out.URL, wantKey)
		}
		if !strings.Contains(out.URL, "X-Amz-Signature=") {
			t.Fatalf("op=%s url %q not a presigned URL", op, out.URL)
		}
		if !strings.HasPrefix(out.URL, "https://") || !strings.Contains(out.URL, "s3.example.com") {
			t.Fatalf("op=%s url %q not against configured endpoint", op, out.URL)
		}
	}
}

func TestObjectKeyDeterministicAndScoped(t *testing.T) {
	a := mustSID(t, "0123456789abcdef0123456789abcdef")
	b := mustSID(t, "fedcba9876543210fedcba9876543210")
	if k1, k2 := ObjectKey("s", a), ObjectKey("s", a); k1 != k2 {
		t.Fatalf("object key not deterministic: %q vs %q", k1, k2)
	}
	if ObjectKey("s", a) == ObjectKey("s", b) {
		t.Fatal("distinct sids produced the same object key (scoping broken)")
	}
	if ObjectKey("secret1", a) == ObjectKey("secret2", a) {
		t.Fatal("distinct secrets produced the same object key")
	}
	if !strings.HasPrefix(ObjectKey("s", a), objectPrefix) {
		t.Fatalf("object key missing %q prefix", objectPrefix)
	}
}

func TestRateLimited(t *testing.T) {
	h := testHandler(t)
	// A strict limiter: burst 1, then denied.
	h.lim = newIPLimiter(rate.Limit(0.0001), 1)
	first := post(t, h, `{"sid":"0123456789abcdef0123456789abcdef","op":"get"}`)
	if first.Code == http.StatusTooManyRequests {
		t.Fatal("first request should be allowed")
	}
	second := post(t, h, `{"sid":"0123456789abcdef0123456789abcdef","op":"get"}`)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second request status = %d, want 429", second.Code)
	}
}

func TestSplitEndpoint(t *testing.T) {
	cases := map[string]struct {
		host   string
		secure bool
	}{
		"https://fly.storage.tigris.dev":  {"fly.storage.tigris.dev", true},
		"https://s3.example.com/":         {"s3.example.com", true},
		"http://localhost:9000":           {"localhost:9000", false},
		"minio.internal:9000":             {"minio.internal:9000", true},
	}
	for in, want := range cases {
		host, secure := splitEndpoint(in)
		if host != want.host || secure != want.secure {
			t.Fatalf("splitEndpoint(%q) = (%q,%v), want (%q,%v)", in, host, secure, want.host, want.secure)
		}
	}
}
