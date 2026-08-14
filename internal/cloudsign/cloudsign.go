// Package cloudsign issues short-TTL presigned URLs so the browser can PUT/GET
// an encrypted Y.Doc snapshot to object storage (Tigris/S3) for optional
// persistence. It is the server half of scriptorium's E2EE-at-rest cloud sync.
//
// It holds the S3 credentials but never the plaintext or the encryption key:
// the browser derives the at-rest key from the code phrase and encrypts the
// snapshot before upload (see web/src/cloud.js, cmd/scriptorium-wasm), so the
// store only ever holds ciphertext. The endpoint derives the object key ITSELF
// from the caller's SessionID (HMAC under the S3 secret), so a caller can only
// ever presign its own session's object — it can never name an arbitrary key.
// POST-only, per-IP rate-limited, tiny-body-capped. Dormant unless the Tigris
// creds are configured (ConfigFromEnv). See docs/THREAT-MODEL.md.
package cloudsign

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/richardwooding/parley/wire"
	"golang.org/x/time/rate"
)

const (
	// maxBody bounds the presign request: {sid: 32 hex, op: "put"|"get"} is tiny.
	maxBody = 1 << 10
	// presignTTL is how long a signed URL is valid — short, since the client uses
	// it immediately after receiving it.
	presignTTL = 120 * time.Second
	// objectPrefix namespaces snapshot objects within the bucket.
	objectPrefix = "snapshots/"
	// keyLabel domain-separates the object-key HMAC (labeled-hash convention,
	// mirroring parley's SessionID derivation).
	keyLabel = "scriptorium/v1/cloud-object"
)

// Config holds the S3/Tigris connection details, read from the environment.
type Config struct {
	Endpoint  string // e.g. https://fly.storage.tigris.dev (AWS_ENDPOINT_URL_S3)
	Bucket    string // BUCKET_NAME
	Region    string // AWS_REGION (default "auto")
	AccessKey string // AWS_ACCESS_KEY_ID
	SecretKey string // AWS_SECRET_ACCESS_KEY
}

// ConfigFromEnv reads the Tigris/S3 config from the environment (Fly secrets;
// `fly storage create` sets these automatically). It returns ok=false when any
// required value is missing, so cloud sync stays DORMANT unless fully
// configured — the repo and local builds carry no secrets and expose nothing.
func ConfigFromEnv() (Config, bool) {
	c := Config{
		Endpoint:  os.Getenv("AWS_ENDPOINT_URL_S3"),
		Bucket:    os.Getenv("BUCKET_NAME"),
		Region:    os.Getenv("AWS_REGION"),
		AccessKey: os.Getenv("AWS_ACCESS_KEY_ID"),
		SecretKey: os.Getenv("AWS_SECRET_ACCESS_KEY"),
	}
	if c.Region == "" {
		c.Region = "auto"
	}
	if c.Endpoint == "" || c.Bucket == "" || c.AccessKey == "" || c.SecretKey == "" {
		return Config{}, false
	}
	return c, true
}

// Handler serves POST /cloud/presign.
type Handler struct {
	cfg Config
	mc  *minio.Client
	lim *ipLimiter
}

// New builds a Handler with an S3 client pointed at the configured endpoint.
func New(cfg Config) (*Handler, error) {
	host, secure := splitEndpoint(cfg.Endpoint)
	mc, err := minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: secure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, err
	}
	// Presign is cheap, but a guessed SessionID must not let anyone hammer the
	// store; 2/s sustained with a small burst is ample for a debounced autosave.
	return &Handler{cfg: cfg, mc: mc, lim: newIPLimiter(rate.Limit(2), 30)}, nil
}

// Register mounts the presign route.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.Handle("/cloud/presign", h)
}

type presignReq struct {
	Sid string `json:"sid"`
	Op  string `json:"op"` // "put" | "get"
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !h.lim.allow(r.RemoteAddr) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req presignReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sid, err := wire.ParseSessionID(strings.TrimSpace(req.Sid))
	if err != nil {
		http.Error(w, "bad session id", http.StatusBadRequest)
		return
	}
	key := ObjectKey(h.cfg.SecretKey, sid)

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var signed string
	switch req.Op {
	case "put":
		u, e := h.mc.PresignedPutObject(ctx, h.cfg.Bucket, key, presignTTL)
		if e != nil {
			http.Error(w, "presign failed", http.StatusBadGateway)
			return
		}
		signed = u.String()
	case "get":
		u, e := h.mc.PresignedGetObject(ctx, h.cfg.Bucket, key, presignTTL, nil)
		if e != nil {
			http.Error(w, "presign failed", http.StatusBadGateway)
			return
		}
		signed = u.String()
	default:
		http.Error(w, "bad op", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"url": signed})
}

// ObjectKey derives the storage key for a session's snapshot:
//
//	snapshots/hex(HMAC-SHA256(secret, keyLabel ∥ sid))
//
// Keying the HMAC with the S3 secret (server-only) means only the server can
// name objects, so a caller can never presign an arbitrary key and session A
// can only ever touch A's object. Exported for tests.
func ObjectKey(secret string, sid wire.SessionID) string {
	m := hmac.New(sha256.New, []byte(secret))
	_, _ = m.Write([]byte(keyLabel))
	_, _ = m.Write(sid[:])
	return objectPrefix + hex.EncodeToString(m.Sum(nil))
}

// splitEndpoint turns an endpoint URL (with or without scheme) into the host
// minio.New expects plus whether TLS is used.
func splitEndpoint(ep string) (host string, secure bool) {
	secure = true
	switch {
	case strings.HasPrefix(ep, "https://"):
		host = ep[len("https://"):]
	case strings.HasPrefix(ep, "http://"):
		host = ep[len("http://"):]
		secure = false
	default:
		host = ep
	}
	return strings.TrimSuffix(host, "/"), secure
}
