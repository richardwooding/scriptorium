# AI assistant — how it works and what leaves your browser

scriptorium has an optional **AI assistant**: open the **✦ Assistant** panel,
add your own API key, and ask it to read or edit the workspace's files. It edits
through the same Yjs CRDT you type into, so its changes appear live for every
collaborator, and each turn is a single **undo checkpoint** ("↩ Undo this turn").

This document is deliberately blunt about the **trust boundary**, because
scriptorium's whole promise is that *the server can't read a word*.

## Bring your own credentials

The assistant is **local to your browser**. It calls your AI provider **directly**
— the scriptorium relay is never in the loop.

- **Anthropic (Claude):** needs an **Anthropic Console API key**
  (`console.anthropic.com`), which is **usage-billed**. A **Claude Pro/Max
  subscription does *not* work here** — those cover the Claude.ai apps and Claude
  Code, not raw browser API calls.
- **OpenAI-compatible:** any endpoint that speaks the OpenAI `chat/completions`
  shape — OpenAI, OpenRouter, a local model via Ollama, etc. Set the **Base URL**
  in settings (e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`,
  or `http://localhost:11434/v1`).

You set the provider, key, base URL, and model in **✦ Assistant → ⚙ Settings**.

## What leaves the end-to-end-encrypted session

The relay only ever sees opaque, encrypted frames — that is unchanged. But when
**you** use the assistant, the content you give it (your messages, and any file
text it reads to answer you) is sent **to the AI provider you configured**. That
is a deliberate egress **outside** scriptorium's E2EE boundary, and it happens
only because you added a key and asked.

- Your **API key** is stored only in your browser (`localStorage`) and is sent
  only to your provider — never to the scriptorium server, never to other
  participants.
- Because it's in `localStorage`, a successful XSS against the page could read it.
  Use **⚙ Settings → Forget key** to remove it; it is also easy to use a scoped,
  low-limit key.
- Collaborators are **not** shown your key or your chat, but they **do** see the
  assistant's file edits (they're normal edits) and a subtle **✦** indicator on
  your presence chip while it's editing.

## What the assistant can do

Full file management, via tools: `list_files`, `read_file`, `edit_file`
(exact find/replace, preferred), `write_file`, `create_file`, `rename_file`,
`delete_file`, `open_file`. Edits are applied as minimal CRDT operations so they
merge with concurrent human edits instead of clobbering them; if a find/replace
no longer matches (a collaborator changed the text), the assistant is told and
re-reads. A per-turn **Undo** reverts only that turn's assistant edits — never
your or your collaborators' edits.

## What the assistant cannot do

- It cannot reach the scriptorium server or relay, run code, or access anything
  outside the current workspace's files.
- It cannot see other participants' keys or chats.
- It cannot bypass the provider's own limits, billing, or CORS policy (a local
  endpoint like Ollama may need CORS enabled, e.g. `OLLAMA_ORIGINS`).
