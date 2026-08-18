# scriptorium

A shared, end-to-end-encrypted collaborative editor that pairs like a secret.
Share a code phrase (`lion-42-maple`) and edit a small tree of files together
— live cursors, syntax highlighting, markdown preview — with a server that
can't read a word of it.

Built on [parley](https://github.com/richardwooding/parley) (phrase-paired
E2EE sessions over a blind relay) and
[flyaffinity](https://github.com/richardwooding/flyaffinity) (multi-node
routing). Collaborative editing uses [Yjs](https://yjs.dev) (a CRDT) in the
browser; the Go core relays opaque, encrypted Yjs updates and never sees
document content — the same "core relays opaque blobs, JS owns the hard part"
design as its sibling [confab](https://github.com/richardwooding/confab).

- **No accounts** — a phrase is the workspace link.
- **E2EE** — edits are encrypted client-side; the relay forwards opaque frames.
- **View-only sharing** — hand out a **read-only** link (Invite → *Copy view-only
  link*) and people join as spectators: they watch live edits (and can join the
  huddle) but can't type, upload, rename, delete, or run the assistant.
- **Multi-file** — a tree of files/folders; highlight by extension; live
  markdown preview.
- **Ephemeral by default, optionally persistent** — a workspace lives while
  someone's connected; enable **E2EE-at-rest cloud sync** (Tigris) and the host
  autosaves an encrypted snapshot that's restored on reopen. The store only ever
  holds ciphertext — the key is derived from the phrase in the browser and never
  leaves it (see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)). Dormant until the
  operator configures an object store.
- **Optional AI assistant** — bring your own key (Anthropic Console, or any
  OpenAI-compatible endpoint) and let it read and edit files on your behalf.
  It runs in your browser and talks to your provider directly; content you share
  with it leaves the E2EE session by your choice. See
  [docs/AI-ASSISTANT.md](docs/AI-ASSISTANT.md).
- **Import / Publish with GitHub** — pull a repo in to edit together (public repos
  need no token), then push the workspace back as a real Git commit, straight from
  the browser; **GitHub Actions** then builds and publishes artifacts (Release /
  Pages / npm / container → GHCR). scriptorium builds nothing and the relay is
  never in the loop. See [docs/PUBLISH.md](docs/PUBLISH.md).
- **Installable PWA, offline-first** — install scriptorium as an app (standalone
  window, home-screen icon); the shell works offline, and your workspace is
  persisted locally (IndexedDB) so a reload — or going offline — keeps your edits
  and merges them back (CRDT) on reconnect. The local copy is **plaintext at
  rest** in your browser; it's on by default and toggleable (**⚑ Offline** →
  off deletes it). See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
- **Huddle (voice chat)** — one-click peer-to-peer voice while you edit (WebRTC
  full mesh + STUN). Audio flows P2P and encrypted, never through the server;
  signaling is opaque over parley. See [docs/HUDDLE.md](docs/HUDDLE.md).

## Run it

```sh
make serve   # build the browser core and serve on :8080
```

## Provenance

The session core (parley), the game table it came from
([kibitz](https://github.com/richardwooding/kibitz)), and confab all share the
same extracted E2EE stack. UI in the
[gloam](https://github.com/richardwooding/gloam) design system.

MIT licensed.
