// Package doc is scriptorium's collaborative-document transport: an opaque,
// chunked relay of Yjs updates over the encrypted parley session. The Go side
// never parses document content — the CRDT (Yjs) lives entirely in the browser;
// this service only guarantees updates travel end-to-end encrypted, chunked to
// fit parley's frame budget, and arrive attributed to an authenticated peer.
//
// Everything opaque flows through ONE chunk envelope (kindChunk): a keystroke
// is Total=1; a large paste or a full-document catch-up state is Total=N. The
// receiver reassembles per (from, fileID, msgID) and hands the whole blob to
// JS, which applies it with Y.applyUpdate. Yjs updates are commutative and
// idempotent, so duplicate/interleaved/out-of-order delivery is safe.
//
// The file TREE is itself a Yjs document under the reserved fileID "@tree";
// the Go side treats every fileID as an opaque string.
package doc

import (
	"errors"
	"fmt"
	"time"

	"github.com/richardwooding/parley/service"
	"github.com/richardwooding/parley/wire"
)

// ID is the service identifier on the wire.
const ID = "doc"

// TreeFileID is the reserved fileID of the workspace tree Y.Doc. JS uses the
// same constant; the Go side treats it as any other opaque fileID.
const TreeFileID = "@tree"

// chunkMax is the opaque payload bytes per frame. parley's MaxFrame is 64KiB
// with ~90-150B of framing/nonce/tag/CBOR overhead; 48KiB leaves ample
// headroom so a chunk frame can NEVER exceed MaxFrame — which is essential:
// seal() increments the per-service seq BEFORE the oversize check, so a single
// oversize send would burn a seq and desync every receiver permanently. Every
// send path here is ≤ chunkMax by construction.
const chunkMax = 48 * 1024

// Reassembly safety caps (defend a joiner against a malicious/buggy peer).
const (
	maxChunks     = 4096             // cap Total: 4096 * 48KiB = 192MiB ceiling per logical message
	maxReasmBytes = 32 * 1024 * 1024 // cap buffered bytes per (from,fileID) in flight
	reasmTTL      = 60 * time.Second // drop a partial that never completes
)

// Wire kinds.
const (
	kindChunk      uint8 = 1 // one (of Total) piece of a Yjs update for FileID
	kindAwareness  uint8 = 2 // ephemeral presence (cursors/selection); never persisted/caught-up
	kindCatchupReq uint8 = 3 // joiner -> host: "I'm new, send current state"
	kindCatchupEnd uint8 = 4 // host -> joiner: enumeration complete
)

type docMsg struct {
	Kind   uint8  `cbor:"1,keyasint"`
	FileID string `cbor:"2,keyasint,omitempty"`
	MsgID  uint64 `cbor:"3,keyasint,omitempty"` // per-sender: groups chunks of one logical update
	Index  uint32 `cbor:"4,keyasint,omitempty"`
	Total  uint32 `cbor:"5,keyasint,omitempty"`
	Data   []byte `cbor:"6,keyasint,omitempty"` // opaque Yjs bytes, <= chunkMax
}

// Events emitted to the UI layer (via ctx.Emit). Update.Update is opaque Yjs
// bytes for JS to apply; never interpreted here.
type (
	// Update is a fully-reassembled Yjs update for a file (live edit or catch-up).
	Update struct {
		From   wire.ParticipantID
		FileID string
		Update []byte
	}
	// Awareness is an opaque Yjs awareness (presence) update.
	Awareness struct {
		From   wire.ParticipantID
		Update []byte
	}
	// CatchupReq fires on the host when a late joiner needs current state.
	CatchupReq struct{ From wire.ParticipantID }
	// CatchupEnd fires on a joiner when the host has sent all state.
	CatchupEnd struct{ From wire.ParticipantID }
)

// ErrTooLarge is returned if a caller hands in an update so large its chunk
// count would exceed maxChunks. Callers should never hit this for text.
var ErrTooLarge = errors.New("doc: update exceeds maximum chunk count")

type reasmKey struct {
	from wire.ParticipantID
	file string
	msg  uint64
}

type reassembly struct {
	total    uint32
	got      uint32
	bytes    int
	parts    [][]byte // indexed 0..total-1; nil until received
	deadline time.Time
}

// Service implements service.Service. All state is touched only on the mux
// goroutine (HandleFrame/Snapshot/Restore/the Send* helpers called from the
// bridge run there), so no locking is needed.
type Service struct {
	service.Base
	nextMsgID uint64
	reasm     map[reasmKey]*reassembly
	now       func() time.Time // injectable for tests
}

// New constructs the doc service.
func New() *Service {
	return &Service{reasm: map[reasmKey]*reassembly{}, now: time.Now}
}

func (s *Service) ID() string   { return ID }
func (s *Service) Version() int { return 1 }

func (s *Service) Attach(ctx service.Context) { s.SetContext(ctx) }

// Snapshot opts OUT of parley's aggregate ctl snapshot: that is a single
// Direct frame carrying every service's snapshot, capped at MaxFrame and
// silently failing on anything document-sized. Documents catch up via this
// service's own chunked protocol (see RequestCatchup/ProvideCatchup).
func (s *Service) Snapshot() ([]byte, error) { return nil, nil }

// Restore is a no-op for the same reason.
func (s *Service) Restore([]byte) error { return nil }

// SendUpdate broadcasts a local Yjs update for fileID to all peers, chunked.
func (s *Service) SendUpdate(fileID string, update []byte) error {
	return s.sendChunked(true, 0, fileID, update)
}

// ProvideCatchup sends one file's full Yjs state to a specific late joiner,
// chunked. Called by the host in response to a CatchupReq.
func (s *Service) ProvideCatchup(to wire.ParticipantID, fileID string, state []byte) error {
	return s.sendChunked(false, to, fileID, state)
}

// EndCatchup tells a joiner the host has finished sending state.
func (s *Service) EndCatchup(to wire.ParticipantID) error {
	body, err := wire.Marshal(docMsg{Kind: kindCatchupEnd})
	if err != nil {
		return err
	}
	return s.Ctx().Send.SendTo(to, ID, body)
}

// RequestCatchup asks the host for current state (called by a fresh joiner).
func (s *Service) RequestCatchup() error {
	body, err := wire.Marshal(docMsg{Kind: kindCatchupReq})
	if err != nil {
		return err
	}
	return s.Ctx().Send.SendTo(s.Ctx().HostID, ID, body)
}

// SendAwareness broadcasts an opaque presence update. Presence is ephemeral;
// if it ever exceeds the budget it is dropped (never chunked, never persisted)
// so it can never trip the seq hazard.
func (s *Service) SendAwareness(update []byte) error {
	body, err := wire.Marshal(docMsg{Kind: kindAwareness, Data: update})
	if err != nil {
		return err
	}
	if len(body) > chunkMax {
		return nil // drop oversize presence rather than risk an oversize send
	}
	return s.Ctx().Send.Broadcast(ID, body)
}

// sendChunked splits blob into <=chunkMax pieces and Broadcasts (or SendTo's)
// each as a kindChunk. Every frame is within budget by construction.
func (s *Service) sendChunked(broadcast bool, to wire.ParticipantID, fileID string, blob []byte) error {
	total := (len(blob) + chunkMax - 1) / chunkMax
	if total == 0 {
		total = 1 // allow a zero-length update (e.g. an empty new file)
	}
	if total > maxChunks {
		return ErrTooLarge
	}
	s.nextMsgID++
	id := s.nextMsgID
	for i := 0; i < total; i++ {
		lo := i * chunkMax
		hi := min(lo+chunkMax, len(blob))
		var part []byte
		if lo < len(blob) {
			part = blob[lo:hi]
		}
		body, err := wire.Marshal(docMsg{
			Kind: kindChunk, FileID: fileID, MsgID: id,
			Index: uint32(i), Total: uint32(total), Data: part,
		})
		if err != nil {
			return err
		}
		if broadcast {
			err = s.Ctx().Send.Broadcast(ID, body)
		} else {
			err = s.Ctx().Send.SendTo(to, ID, body)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// HandleFrame runs on the mux goroutine.
func (s *Service) HandleFrame(from wire.ParticipantID, body []byte) error {
	m, err := wire.Body[docMsg](body)
	if err != nil {
		return fmt.Errorf("doc: %w", err)
	}
	switch m.Kind {
	case kindChunk:
		s.handleChunk(from, m)
	case kindAwareness:
		s.Ctx().Emit(Awareness{From: from, Update: m.Data})
	case kindCatchupReq:
		s.Ctx().Emit(CatchupReq{From: from})
	case kindCatchupEnd:
		s.Ctx().Emit(CatchupEnd{From: from})
	}
	// Unknown kinds are ignored (forward compatibility).
	return nil
}

func (s *Service) handleChunk(from wire.ParticipantID, m docMsg) {
	s.expire()
	// Fast path: a single-chunk message needs no buffering.
	if m.Total <= 1 {
		s.Ctx().Emit(Update{From: from, FileID: m.FileID, Update: m.Data})
		return
	}
	if m.Total > maxChunks || m.Index >= m.Total {
		return // malformed; drop
	}
	key := reasmKey{from: from, file: m.FileID, msg: m.MsgID}
	r := s.reasm[key]
	if r == nil {
		r = &reassembly{total: m.Total, parts: make([][]byte, m.Total), deadline: s.now().Add(reasmTTL)}
		s.reasm[key] = r
	}
	if m.Index >= uint32(len(r.parts)) || r.parts[m.Index] != nil {
		return // out of range or duplicate index
	}
	if r.bytes+len(m.Data) > maxReasmBytes {
		delete(s.reasm, key) // overrun: drop the whole partial
		return
	}
	r.parts[m.Index] = append([]byte(nil), m.Data...)
	r.bytes += len(m.Data)
	r.got++
	if r.got != r.total {
		return
	}
	full := make([]byte, 0, r.bytes)
	for _, p := range r.parts {
		full = append(full, p...)
	}
	delete(s.reasm, key)
	s.Ctx().Emit(Update{From: from, FileID: m.FileID, Update: full})
}

// expire drops partials that never completed within reasmTTL.
func (s *Service) expire() {
	now := s.now()
	for k, r := range s.reasm {
		if now.After(r.deadline) {
			delete(s.reasm, k)
		}
	}
}
