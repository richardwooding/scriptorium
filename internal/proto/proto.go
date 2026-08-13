// Package proto pins scriptorium's wire-protocol domain label and session
// options. Every parley entry point that derives keys or session IDs must
// receive this label — changing it is a protocol version bump.
package proto

import "github.com/richardwooding/parley/session"

// Label is passed via Options to every session.Host / session.Join call.
const Label = "scriptorium/v1"

// Options is the bundle every session.Host / session.Join call must pass:
// scriptorium's protocol label. Roles use parley's defaults (every
// participant an equal member; "host" is the snapshot/migration anchor).
func Options() []session.Option {
	return []session.Option{session.WithProtocol(Label)}
}
