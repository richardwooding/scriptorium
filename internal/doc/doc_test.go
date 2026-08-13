package doc

import (
	"testing"
	"time"

	"github.com/richardwooding/parley/service"
	"github.com/richardwooding/parley/wire"
)

// capture is a fake Sender recording every frame the service emits, so unit
// tests can assert chunking/sizing without a relay.
type capture struct {
	broadcasts [][]byte
	directs    []directFrame
}
type directFrame struct {
	to   wire.ParticipantID
	body []byte
}

func (c *capture) Broadcast(_ string, body []byte) error {
	c.broadcasts = append(c.broadcasts, append([]byte(nil), body...))
	return nil
}
func (c *capture) SendTo(to wire.ParticipantID, _ string, body []byte) error {
	c.directs = append(c.directs, directFrame{to, append([]byte(nil), body...)})
	return nil
}

func attach(t *testing.T, self, host wire.ParticipantID) (*Service, *capture, *[]any) {
	t.Helper()
	s := New()
	cap := &capture{}
	var events []any
	s.Attach(service.Context{Send: cap, Emit: func(e any) { events = append(events, e) }, Self: self, HostID: host})
	return s, cap, &events
}

// THE core safety property: no frame the service ever emits exceeds the parley
// budget, even for a large paste. An oversize send would burn a seq and
// permanently desync (seal() bumps seq before the size check).
func TestEveryFrameWithinBudget(t *testing.T) {
	s, cap, _ := attach(t, 1, 1)
	big := make([]byte, 500*1024) // ~10 chunks
	for i := range big {
		big[i] = byte(i)
	}
	if err := s.SendUpdate("file1", big); err != nil {
		t.Fatal(err)
	}
	if len(cap.broadcasts) < 10 {
		t.Fatalf("expected the update to be split into many chunks, got %d", len(cap.broadcasts))
	}
	for i, f := range cap.broadcasts {
		if len(f) > wire.MaxFrame {
			t.Fatalf("chunk %d body %d exceeds MaxFrame %d", i, len(f), wire.MaxFrame)
		}
		// The doc body must leave room for the outer envelope/nonce/tag too.
		if len(f) > chunkMax+512 {
			t.Fatalf("chunk %d body %d suspiciously large vs chunkMax %d", i, len(f), chunkMax)
		}
	}
}

// A large update chunked by the sender reassembles byte-identically at the
// receiver, and only one Update event is emitted.
func TestChunkRoundTrip(t *testing.T) {
	sender, cap, _ := attach(t, 1, 1)
	blob := make([]byte, 300*1024)
	for i := range blob {
		blob[i] = byte(i * 7)
	}
	if err := sender.SendUpdate("f", blob); err != nil {
		t.Fatal(err)
	}
	recv, _, events := attach(t, 2, 1)
	for _, f := range cap.broadcasts {
		if err := recv.HandleFrame(1, f); err != nil {
			t.Fatal(err)
		}
	}
	var got *Update
	for _, e := range *events {
		if u, ok := e.(Update); ok {
			if got != nil {
				t.Fatal("more than one Update emitted for one logical message")
			}
			cp := u
			got = &cp
		}
	}
	if got == nil {
		t.Fatal("no Update emitted")
	}
	if got.FileID != "f" || got.From != 1 || len(got.Update) != len(blob) {
		t.Fatalf("reassembled wrong: file=%s from=%d len=%d", got.FileID, got.From, len(got.Update))
	}
	for i := range blob {
		if got.Update[i] != blob[i] {
			t.Fatalf("byte %d mismatch after reassembly", i)
		}
	}
}

// A single-chunk update is a fast path: emitted immediately, no buffering.
func TestSingleChunkImmediate(t *testing.T) {
	s, _, events := attach(t, 2, 1)
	body, _ := wire.Marshal(docMsg{Kind: kindChunk, FileID: "f", MsgID: 1, Index: 0, Total: 1, Data: []byte("hello")})
	if err := s.HandleFrame(1, body); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(*events))
	}
	if u := (*events)[0].(Update); string(u.Update) != "hello" {
		t.Fatalf("got %q", u.Update)
	}
}

// Duplicate chunks are ignored; reassembly still completes exactly once.
func TestDuplicateChunksIgnored(t *testing.T) {
	s, _, events := attach(t, 2, 1)
	mk := func(idx uint32, data string) []byte {
		b, _ := wire.Marshal(docMsg{Kind: kindChunk, FileID: "f", MsgID: 9, Index: idx, Total: 2, Data: []byte(data)})
		return b
	}
	_ = s.HandleFrame(1, mk(0, "AA"))
	_ = s.HandleFrame(1, mk(0, "AA")) // dup
	if len(*events) != 0 {
		t.Fatal("emitted before complete")
	}
	_ = s.HandleFrame(1, mk(1, "BB"))
	if len(*events) != 1 {
		t.Fatalf("expected 1 Update, got %d", len(*events))
	}
	if u := (*events)[0].(Update); string(u.Update) != "AABB" {
		t.Fatalf("got %q", u.Update)
	}
}

// Awareness is broadcast opaque; oversize presence is dropped, never chunked.
func TestAwareness(t *testing.T) {
	s, cap, events := attach(t, 1, 1)
	if err := s.SendAwareness([]byte("cursor@5")); err != nil {
		t.Fatal(err)
	}
	if len(cap.broadcasts) != 1 {
		t.Fatalf("expected 1 awareness broadcast, got %d", len(cap.broadcasts))
	}
	if err := s.SendAwareness(make([]byte, chunkMax+1)); err != nil {
		t.Fatal(err)
	}
	if len(cap.broadcasts) != 1 {
		t.Fatal("oversize awareness should be dropped, not sent")
	}
	_ = events // sender emits nothing for its own broadcast
	// inbound awareness → an Awareness event on the receiver
	recv, _, rev := attach(t, 2, 1)
	_ = recv.HandleFrame(1, cap.broadcasts[0])
	if len(*rev) != 1 {
		t.Fatalf("expected 1 Awareness event, got %d", len(*rev))
	}
	if a, ok := (*rev)[0].(Awareness); !ok || string(a.Update) != "cursor@5" || a.From != 1 {
		t.Fatalf("got %+v", (*rev)[0])
	}
}

// Catch-up: joiner requests, host provides per file (chunked SendTo) + end.
func TestCatchupFlow(t *testing.T) {
	joiner, jcap, _ := attach(t, 3, 1)
	if err := joiner.RequestCatchup(); err != nil {
		t.Fatal(err)
	}
	if len(jcap.directs) != 1 || jcap.directs[0].to != 1 {
		t.Fatalf("catchup req should SendTo host(1), got %+v", jcap.directs)
	}
	// host sees the request
	host, hcap, hev := attach(t, 1, 1)
	_ = host.HandleFrame(3, jcap.directs[0].body)
	if len(*hev) != 1 {
		t.Fatal("host should emit CatchupReq")
	}
	if r, ok := (*hev)[0].(CatchupReq); !ok || r.From != 3 {
		t.Fatalf("got %+v", (*hev)[0])
	}
	// host provides one file's state + end marker, all SendTo the joiner
	if err := host.ProvideCatchup(3, "@tree", []byte("treestate")); err != nil {
		t.Fatal(err)
	}
	if err := host.EndCatchup(3); err != nil {
		t.Fatal(err)
	}
	for _, d := range hcap.directs {
		if d.to != 3 {
			t.Fatalf("catchup should target the joiner(3), got to=%d", d.to)
		}
	}
	// joiner applies them
	recv, _, rev := attach(t, 3, 1)
	for _, d := range hcap.directs {
		_ = recv.HandleFrame(1, d.body)
	}
	var gotUpdate, gotEnd bool
	for _, e := range *rev {
		switch ev := e.(type) {
		case Update:
			if ev.FileID == "@tree" && string(ev.Update) == "treestate" {
				gotUpdate = true
			}
		case CatchupEnd:
			gotEnd = true
		}
	}
	if !gotUpdate || !gotEnd {
		t.Fatalf("joiner missing catch-up: update=%v end=%v", gotUpdate, gotEnd)
	}
}

// A partial that never completes is dropped after its TTL (no leak, no emit).
func TestReassemblyTTL(t *testing.T) {
	s, _, events := attach(t, 2, 1)
	now := time.Unix(0, 0)
	s.now = func() time.Time { return now }
	half, _ := wire.Marshal(docMsg{Kind: kindChunk, FileID: "f", MsgID: 1, Index: 0, Total: 2, Data: []byte("X")})
	_ = s.HandleFrame(1, half)
	if len(s.reasm) != 1 {
		t.Fatal("expected a buffered partial")
	}
	now = now.Add(2 * reasmTTL)
	// any subsequent chunk triggers expire()
	other, _ := wire.Marshal(docMsg{Kind: kindChunk, FileID: "g", MsgID: 2, Index: 0, Total: 1, Data: []byte("Y")})
	_ = s.HandleFrame(1, other)
	if _, stale := s.reasm[reasmKey{from: 1, file: "f", msg: 1}]; stale {
		t.Fatal("stale partial not expired")
	}
	// the single-chunk 'g' still emitted fine
	found := false
	for _, e := range *events {
		if u, ok := e.(Update); ok && u.FileID == "g" {
			found = true
		}
	}
	if !found {
		t.Fatal("live update after expiry not delivered")
	}
}
