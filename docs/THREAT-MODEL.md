# scriptorium threat model

**The relay is blind, and so is the cloud store.** scriptorium relays only
opaque encrypted frames between browsers; document content is end-to-end
encrypted client-side and neither the relay nor (with cloud sync enabled) the
object store ever sees plaintext.

## How the session crypto works

scriptorium runs on [parley](https://github.com/richardwooding/parley); the
session pairing/crypto is parley's and covered by its threat model. In short:

- The workspace is identified by a code **phrase** (`lion-42-maple`). The relay
  never sees the phrase — only a **SessionID** derived from it:
  `SHA-256("scriptorium/v1" ∥ "/session-id" ∥ NUL ∥ canonical(phrase))[:16]`.
- A PAKE handshake (schollz/pake, curve `siec`) turns the phrase into pairwise
  keys; the host wraps a random group key to each joiner. All service traffic
  (editor CRDT updates, chat, huddle signaling) is XChaCha20-Poly1305 AEAD.
- Wrong phrase ⇒ the group-key unwrap fails cleanly; you can't join.

## Cloud sync (E2EE-at-rest) — optional, dormant by default

Persistence is off unless the operator configures an object store (Tigris/S3)
via `fly secrets` / `fly storage create`. When off, the `/cloud/presign` route
isn't even mounted and the client treats it as disabled. When on:

### Key derivation (never leaves the browser)

The at-rest key is derived in the WASM core from the same phrase, independently
of the session keys:

```
cloudKey = HKDF-SHA256(canonical(phrase), info = "scriptorium/v1/cloud")[:32]
```

Deriving from the *canonical* phrase means the host, any joiner, and any
promoted-writer compute the identical key. The key is handed to the page's JS
(which already holds the phrase) and **never sent to the server**.

### What gets stored

The host serializes the whole Y.Doc (`Y.encodeStateAsUpdate`), encrypts it with
`XChaCha20-Poly1305` under `cloudKey` (24-byte random nonce per write, prepended
to the ciphertext), and PUTs the result to a presigned URL. The store therefore
holds **only ciphertext** under a random-looking object name. Only a holder of
the phrase can derive `cloudKey` and decrypt it.

### What the presign endpoint learns / can do / cannot do

`POST /cloud/presign` takes `{sid, op}` and returns a short-TTL (120 s)
presigned PUT or GET URL.

- **Learns:** the SessionID hex (which the relay already learns from the hello
  frame — it leaks nothing new) and the caller's IP. Never the phrase, the key,
  or any plaintext/ciphertext (uploads go browser→store directly, not through
  us).
- **Cannot be told which object to touch.** The server derives the object key
  itself: `snapshots/hex(HMAC-SHA256(s3-secret, "scriptorium/v1/cloud-object" ∥ sid))`.
  Because the HMAC is keyed with the server-only S3 secret, a caller can never
  name an arbitrary key, and session A can only ever presign A's object. There
  is no path traversal, no cross-session read/overwrite.
- **Cannot forge or read content.** It holds the S3 credentials but never the
  encryption key; anything it (or the store operator) reads is ciphertext.

### Presign-abuse controls

- **POST-only**, tiny request-body cap (`http.MaxBytesReader`), strict SessionID
  validation (`wire.ParseSessionID`) — malformed input is rejected before any
  S3 call.
- **Per-IP rate limit** (token bucket, 2/s + small burst) so a party who guesses
  a SessionID still can't cheaply enumerate or hammer the store. Guessing a
  SessionID is exactly as hard as guessing the phrase (~27-bit space, and a
  correct guess yields only ciphertext they still can't decrypt).
- **Short TTL** on every signed URL; **single writer = host** (with host
  migration promoting the new writer) so concurrent overwrites don't fight —
  full-state snapshots are last-writer-wins and CRDT-mergeable on next open.
- The browser↔store transfer is cross-origin and requires the bucket's CORS
  policy to allow the app origin (operator-configured); it bypasses the service
  worker (non-same-origin) and is never cached.

### At-rest boundary — trust assumptions

- The **store operator (Tigris) and our relay see only ciphertext.** The
  security of a persisted workspace reduces to the phrase, exactly like a live
  session. Delete the object (or never enable cloud sync) and scriptorium is
  fully ephemeral again.
- Availability caveats the relay/presign endpoint *can* mount (they're a
  network service): refuse to sign, or the store could drop/serve-stale an
  object. None of these reveal plaintext.

## Non-goals

- No server-side access control beyond phrase possession — anyone with the
  phrase is a full participant and can read/write the workspace and its snapshot.
- No protection against a malicious *participant* (they hold the group key by
  design). No per-file ACLs.
- No plaintext-at-rest anywhere: if you need server-readable persistence, this
  isn't it.
