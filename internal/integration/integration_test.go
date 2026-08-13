// Package integration exercises scriptorium's doc service over a real parley
// relay with native session clients — the exact code the browser core runs.
package integration

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/richardwooding/parley/relay"
	"github.com/richardwooding/parley/service"
	"github.com/richardwooding/parley/session"
	"github.com/richardwooding/parley/wire"
	"golang.org/x/time/rate"

	"github.com/richardwooding/scriptorium/internal/doc"
	"github.com/richardwooding/scriptorium/internal/proto"
)

func startRelay(t *testing.T) string {
	t.Helper()
	// Raised burst: these tests open several connections from one IP quickly.
	s := relay.New(relay.Options{MaxParticipants: 12, ConnRate: rate.Limit(100), ConnBurst: 100})
	t.Cleanup(s.Close)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	return ctx
}

type end struct {
	client *session.Client
	mux    *service.Mux
	doc    *doc.Service
}

func host(t *testing.T, url string) (*end, string) {
	t.Helper()
	c, phrase, err := session.Host(testCtx(t), url, proto.Options()...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	d := doc.New()
	return &end{c, service.NewMux(c, service.WithServices(d)), d}, phrase
}

func join(t *testing.T, url, phrase string) *end {
	t.Helper()
	c, err := session.Join(testCtx(t), url, phrase, proto.Options()...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	d := doc.New()
	return &end{c, service.NewMux(c, service.WithServices(d)), d}
}

func waitUpdate(t *testing.T, e *end, pred func(doc.Update) bool) doc.Update {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-e.mux.Events():
			if !ok {
				t.Fatal("event stream closed")
			}
			if u, isU := ev.(doc.Update); isU && pred(u) {
				return u
			}
			if d, isD := ev.(service.Desync); isD {
				t.Fatalf("DESYNC: %+v", d) // the failure mode the seq-guard prevents
			}
		case <-deadline:
			t.Fatal("timed out waiting for update")
			panic("unreachable")
		}
	}
}

func drain(e *end) {
	go func() {
		for range e.mux.Events() { //nolint:revive
		}
	}()
}

// A small edit broadcasts and applies at a peer.
func TestSmallUpdateRoundTrip(t *testing.T) {
	url := startRelay(t)
	h, phrase := host(t, url)
	j := join(t, url, phrase)
	drain(h)
	if err := h.doc.SendUpdate("f1", []byte("hello yjs")); err != nil {
		t.Fatal(err)
	}
	u := waitUpdate(t, j, func(u doc.Update) bool { return u.FileID == "f1" })
	if string(u.Update) != "hello yjs" || u.From != h.client.Self() {
		t.Fatalf("got %+v", u)
	}
}

// A >64KiB update chunks across the wire, reassembles intact at the peer, and
// — critically — produces NO Desync (the seq-guard proof, end to end).
func TestLargeUpdateChunksNoDesync(t *testing.T) {
	url := startRelay(t)
	h, phrase := host(t, url)
	j := join(t, url, phrase)
	drain(h)

	blob := make([]byte, 250*1024) // ~6 chunks, well over MaxFrame
	for i := range blob {
		blob[i] = byte(i * 13)
	}
	if err := h.doc.SendUpdate("big", blob); err != nil {
		t.Fatal(err)
	}
	u := waitUpdate(t, j, func(u doc.Update) bool { return u.FileID == "big" })
	if len(u.Update) != len(blob) {
		t.Fatalf("reassembled len %d, want %d", len(u.Update), len(blob))
	}
	for i := range blob {
		if u.Update[i] != blob[i] {
			t.Fatalf("byte %d mismatch", i)
		}
	}
	// A following small update must still arrive in order (no seq corruption).
	if err := h.doc.SendUpdate("big", []byte("tail")); err != nil {
		t.Fatal(err)
	}
	waitUpdate(t, j, func(u doc.Update) bool { return u.FileID == "big" && string(u.Update) == "tail" })
}

// The tree rides the same path under the reserved fileID.
func TestTreeUpdateRoundTrip(t *testing.T) {
	url := startRelay(t)
	h, phrase := host(t, url)
	j := join(t, url, phrase)
	drain(h)
	if err := h.doc.SendUpdate(doc.TreeFileID, []byte("tree-op")); err != nil {
		t.Fatal(err)
	}
	waitUpdate(t, j, func(u doc.Update) bool { return u.FileID == doc.TreeFileID && string(u.Update) == "tree-op" })
}

// Host-authoritative catch-up: a late joiner requests state; the host provides
// a (multi-chunk) file plus an end marker; the joiner reassembles and applies.
func TestCatchupEndToEnd(t *testing.T) {
	url := startRelay(t)
	h, phrase := host(t, url)
	j := join(t, url, phrase)

	// host answers a catch-up request by streaming current state.
	go func() {
		for ev := range h.mux.Events() {
			if r, ok := ev.(doc.CatchupReq); ok {
				_ = h.doc.ProvideCatchup(r.From, doc.TreeFileID, []byte("the-tree"))
				big := make([]byte, 120*1024)
				for i := range big {
					big[i] = byte(i)
				}
				_ = h.doc.ProvideCatchup(r.From, "readme.md", big)
				_ = h.doc.EndCatchup(r.From)
			}
		}
	}()

	if err := j.doc.RequestCatchup(); err != nil {
		t.Fatal(err)
	}
	gotTree, gotBig, gotEnd := false, false, false
	deadline := time.After(10 * time.Second)
	for !gotTree || !gotBig || !gotEnd {
		select {
		case ev, ok := <-j.mux.Events():
			if !ok {
				t.Fatal("stream closed")
			}
			switch e := ev.(type) {
			case doc.Update:
				if e.FileID == doc.TreeFileID && string(e.Update) == "the-tree" {
					gotTree = true
				}
				if e.FileID == "readme.md" && len(e.Update) == 120*1024 {
					gotBig = true
				}
			case doc.CatchupEnd:
				gotEnd = true
			case service.Desync:
				t.Fatalf("DESYNC during catch-up: %+v", e)
			}
		case <-deadline:
			t.Fatalf("catch-up incomplete: tree=%v big=%v end=%v", gotTree, gotBig, gotEnd)
		}
	}
}

var _ = wire.ParticipantID(0)
