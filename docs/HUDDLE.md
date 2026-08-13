# Huddle — voice chat while you edit

Click **🎙 Huddle → Join voice** and you're in a peer-to-peer voice call with the
others in the workspace, without leaving the editor. It's a WebRTC **full mesh**
(each participant connects directly to every other), with **STUN** for NAT
traversal.

## How it fits scriptorium's privacy model

- **Audio is peer-to-peer and encrypted.** Voice flows directly between browsers
  over WebRTC (DTLS-SRTP), **never through the scriptorium server**.
- **Signaling is opaque.** The SDP/ICE messages that set up each connection ride
  the same end-to-end-encrypted parley session as your edits; the relay forwards
  them without being able to read them (it never sees who's talking to whom or
  the media). The Go core never parses SDP either — it's a blind router
  (`internal/huddle`).
- **Opt-in.** A peer only meshes with people who have **joined** the huddle
  (published via the awareness channel). Someone merely editing is never pulled
  into audio. A 🎙 badge on a presence chip shows who's in voice.

## What it does

- Join / leave voice, mute / unmute (mic on/off, no renegotiation).
- A participant list with an **active-speaker highlight** (Web Audio level
  metering, computed locally).
- Peers joining or leaving mid-huddle are added/torn down automatically; a
  dropped relay connection pauses signaling but not the live audio, and ICE
  restarts on reconnect.

## Limitations

- **STUN only, no TURN.** Most home/office networks connect fine, but some
  **symmetric-NAT** networks (parts of corporate/cellular) can't establish a
  direct P2P path and **won't connect** — there's no relay fallback. Adding a
  TURN server is the fix if that becomes a problem.
- **Mesh scale.** Each participant sends its audio to every other, so this suits
  a **handful** of people; it degrades past ~8. The workspace cap is 12.
- **Voice only.** No video or screen-share (a possible follow-up).

## STUN servers used

`stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302` (public).
