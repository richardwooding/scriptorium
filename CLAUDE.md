# CLAUDE.md

## What this is

scriptorium is croc-style pairing for a shared collaborative editor: a host
gets a code phrase, others join with it. Built on parley — the phrase seeds a
PAKE handshake and ALL document traffic is end-to-end encrypted through a blind
relay. Collaborative convergence is Yjs (a CRDT) running in the browser; the Go
core is a blind relay of OPAQUE Yjs update blobs (like confab relays opaque
SDP). Multi-file tree, syntax highlighting, markdown preview. Ephemeral base with
optional **E2EE-at-rest cloud sync**: `internal/cloudsign` (env-gated, dormant
unless Tigris/S3 creds are set) presigns short-TTL PUT/GET URLs; the browser
derives `cloudKey = HKDF(phrase)` in the WASM core, encrypts the Y.Doc snapshot
with XChaCha20-Poly1305 (`web/src/cloud.js` + the `cloudcrypto` bundle), and the
host autosaves/restores it. The store holds only ciphertext; the object key is
`HMAC(s3-secret, sid)` so callers can't name arbitrary keys. See
docs/THREAT-MODEL.md.

## Commands

```sh
make test        # go test -race ./...
make wasm        # build browser core into web/dist (+ vendored JS + gloam + wasm_exec.js)
make serve       # make wasm && go run ./cmd/scriptorium
make lint        # go vet + golangci-lint
make vendor-js   # regenerate committed JS bundles (Yjs/editor/markdown) via esbuild — on version bump only
GOOS=js GOARCH=wasm go build -o /dev/null ./cmd/scriptorium-wasm   # WASM check (CI runs this)
```

## Architecture and invariants

- **The relay is blind** (parley/relay at /ws) and in-memory only. Document
  content is E2EE between browsers; the server never sees plaintext.
- **Zero `syscall/js` outside `cmd/scriptorium-wasm`.** internal/{proto,doc}
  compile natively AND to WASM; internal/integration exercises the exact code
  the browser runs against a real relay.
- **Protocol label**: every session.Host/Join passes `proto.Options()`
  (label "scriptorium/v1"); internal/proto's golden test pins the session-ID
  derivation.
- **doc service** (internal/doc): an opaque, chunked relay of Yjs updates.
  Snapshot()→nil (parley's aggregate ctl snapshot is a single ≤64 KiB frame —
  too small for documents; we use our own chunked catch-up). The tree is a Yjs
  doc (reserved fileID "@tree"). THE hard rule: never hand an oversize body to
  Broadcast/SendTo — seal() bumps the per-service seq before the size check, so
  one oversize send = permanent Desync. Chunk everything to ≤48 KiB.
- **JS owns the CRDT**: cmd/scriptorium-wasm bridges exactly two functions
  (scriptorium_send / scriptoriumOnEvent, JSON at the bridge). web/src owns
  Yjs, CodeMirror, markdown preview; the core relays opaque base64 blobs.
- **Vendored JS** (Yjs/CodeMirror/markdown) are committed esbuild bundles
  refreshed by `make vendor-js`; never hand-edit them. gloam.css/gloam.js are
  vendored + synced by .github/workflows/gloam-sync.yml.
- **Multi-node**: flyaffinity pins a workspace's clients to one machine (in the
  relay Router); reconnect=rejoin recovers a machine loss.

## Releasing and deploy

Tag push (vX.Y.Z) → goreleaser → ghcr.io/richardwooding/scriptorium image (ko).
Hosted on Fly. Deploy the explicit version image (`fly deploy --image
ghcr.io/richardwooding/scriptorium:X.Y.Z`) to avoid stale `:latest`. Multi-node
via `fly scale count N` (keep auto_stop off, min_machines_running = N).
