package proto

import (
	"encoding/hex"
	"testing"

	"github.com/richardwooding/parley/phrase"
)

// Pin the derivation under scriptorium's label. Changing it knowingly is a
// protocol version bump, not a refactor.
func TestSessionIDGolden(t *testing.T) {
	got := phrase.SessionID(Label, "lion-42-maple")
	if h := hex.EncodeToString(got[:]); h != "4cf70eef65783aeee25599344e8d21b5" {
		t.Fatalf("session-ID derivation changed: %s", h)
	}
}
