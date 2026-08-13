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
- **Multi-file** — a tree of files/folders; highlight by extension; live
  markdown preview.
- **Ephemeral by default** — a workspace lives while someone's connected;
  optional encrypted cloud sync (Tigris) is a follow-up so workspaces persist.

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
