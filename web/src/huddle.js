// huddle.js — voice chat (window.Huddle). A WebRTC full mesh: one
// RTCPeerConnection per peer who has JOINED the huddle, audio-only, using the
// MDN perfect-negotiation pattern. Ported from confab's call.js.
//
// Zero protocol here: signaling (SDP/ICE) travels opaquely through the WASM
// core — app.js routes `huddle.signal` events in and sends ours back out — so
// the relay never hears audio, and the audio itself flows peer-to-peer
// (DTLS-SRTP encrypted), never through the server.
//
// Membership is discovered via the awareness "huddle" field (workspace.js): a
// peer meshes ONLY with those who opted in, so a collaborator merely editing is
// never pulled into audio. Pairing rule: for a pair (A,B) with A<B, the higher
// id (B) initiates; the higher id is also the "polite" peer that yields on glare.
(() => {
  "use strict";

  const ICE = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ];
  const el = (id) => document.getElementById(id);

  let send = () => {};       // set by init: (to, kind, payload)
  let selfId = 0;
  let selfName = "you";
  let joined = false;
  let muted = false;
  let local = null;          // MediaStream or null (listen-only)
  const peers = new Map();   // pid -> { pc, polite, makingOffer, ignoreOffer, settingRemoteAnswer, analyser, audioEl }
  let members = [];          // [{pid,name,muted}] currently in the huddle (from awareness)

  // active-speaker metering
  let audioCtx = null;
  let localAnalyser = null;
  let meterTimer = null;
  const speaking = new Set();      // pids currently speaking
  const releaseUntil = new Map();  // pid -> ms timestamp speaking holds until
  const SPEAK_RMS = 0.05;          // threshold
  const SPEAK_HOLD = 350;          // ms release debounce

  // ---- media -------------------------------------------------------------
  async function acquireMic() {
    try {
      local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return true;
    } catch (_) { local = null; return false; } // denied → listen-only
  }
  function stopLocal() { if (local) for (const t of local.getTracks()) t.stop(); local = null; }

  // ---- audio metering ----------------------------------------------------
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function analyserFor(stream) {
    try {
      const src = ctx().createMediaStreamSource(stream);
      const an = ctx().createAnalyser();
      an.fftSize = 512;
      src.connect(an); // metering only — never connected to destination
      return an;
    } catch (_) { return null; }
  }
  function rms(an) {
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }
  function mark(pid, level) {
    const now = performance.now();
    if (level > SPEAK_RMS) releaseUntil.set(pid, now + SPEAK_HOLD);
    if ((releaseUntil.get(pid) || 0) > now) speaking.add(pid); else speaking.delete(pid);
  }
  function meterTick() {
    mark(selfId, local && !muted ? rms(localAnalyser) : 0);
    for (const [pid, p] of peers) mark(pid, rms(p.analyser));
    renderList();
  }
  function startMeter() {
    if (meterTimer) return;
    if (local) localAnalyser = analyserFor(local);
    meterTimer = setInterval(meterTick, 150);
  }
  function stopMeter() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    localAnalyser = null; speaking.clear(); releaseUntil.clear();
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

  // ---- peers (perfect negotiation, MDN pattern) --------------------------
  function newPeer(pid, name) {
    const p = {
      pc: new RTCPeerConnection({ iceServers: ICE }),
      polite: selfId > pid, // the higher id yields on glare
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      analyser: null,
      audioEl: null,
      name: name || ("#" + pid),
    };
    const pc = p.pc;
    if (local) for (const t of local.getTracks()) pc.addTrack(t, local);
    else pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      if (!p.audioEl) {
        p.audioEl = document.createElement("audio");
        p.audioEl.autoplay = true;
        p.audioEl.playsInline = true;
        (el("huddle-audio") || document.body).appendChild(p.audioEl);
      }
      if (p.audioEl.srcObject !== stream) p.audioEl.srcObject = stream;
      p.analyser = analyserFor(stream);
    };
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        send(pid, "offer", JSON.stringify(pc.localDescription));
      } catch (_) { /* peer gone mid-negotiation */ } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => send(pid, "ice", JSON.stringify(candidate));
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed") retryPeer(pid, p.name);
      renderList();
    };
    peers.set(pid, p);
    renderList();
    return p;
  }

  function retryPeer(pid, name) {
    const p = peers.get(pid);
    if (!p) return;
    p.pc.restartIce();
    setTimeout(() => {
      const cur = peers.get(pid);
      if (!cur || cur.pc.connectionState !== "failed") return;
      send(pid, "bye", "");
      dropPeer(pid);
      if (joined && members.some((m) => m.pid === pid)) newPeer(pid, name);
    }, 10_000);
  }

  function dropPeer(pid) {
    const p = peers.get(pid);
    if (!p) return;
    try { p.pc.close(); } catch (_) { /* already closed */ }
    if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
    peers.delete(pid);
    speaking.delete(pid);
    renderList();
  }

  async function onSignalMsg(from, kind, payload, name) {
    if (kind === "bye") { dropPeer(from); return; }
    if (!joined) return; // not in the huddle → ignore stray signaling
    const p = peers.get(from) || newPeer(from, name); // elder side: lazy create
    const pc = p.pc;
    try {
      if (kind === "ice") {
        const cand = JSON.parse(payload);
        try { await pc.addIceCandidate(cand); } catch (err) { if (!p.ignoreOffer) throw err; }
        return;
      }
      const desc = JSON.parse(payload);
      const readyForOffer = !p.makingOffer && (pc.signalingState === "stable" || p.settingRemoteAnswer);
      const collision = desc.type === "offer" && !readyForOffer;
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      p.settingRemoteAnswer = desc.type === "answer";
      await pc.setRemoteDescription(desc); // implicit rollback for the polite peer
      p.settingRemoteAnswer = false;
      if (desc.type === "offer") {
        await pc.setLocalDescription();
        send(from, "answer", JSON.stringify(pc.localDescription));
      }
    } catch (err) { console.warn("huddle: negotiation with", from, "failed:", err); }
  }

  // Reconcile the mesh against the current huddle membership. Only the higher
  // id initiates; lower ids wait for the offer (created lazily in onSignalMsg).
  function syncMesh() {
    if (!joined) return;
    const ids = new Set(members.map((m) => m.pid));
    for (const m of members) {
      if (m.pid === selfId || peers.has(m.pid)) continue;
      if (m.pid < selfId) newPeer(m.pid, m.name); // onnegotiationneeded → offer
    }
    for (const pid of [...peers.keys()]) if (!ids.has(pid)) dropPeer(pid);
  }

  // ---- rendering ---------------------------------------------------------
  function renderList() {
    const list = el("huddle-list");
    if (!list) return;
    list.textContent = "";
    const rows = [];
    if (joined) rows.push({ pid: selfId, name: selfName + " (you)", muted, self: true, state: "connected" });
    for (const m of members) {
      if (m.pid === selfId) continue;
      const p = peers.get(m.pid);
      rows.push({ pid: m.pid, name: m.name, muted: m.muted, self: false, state: p ? p.pc.connectionState : "…" });
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "gl-hint huddle-empty";
      empty.textContent = joined ? "Waiting for others to join…" : "No one's in the huddle yet.";
      list.appendChild(empty);
    }
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "huddle-row" + (speaking.has(r.pid) && !r.muted ? " speaking" : "");
      const mic = document.createElement("span");
      mic.className = "huddle-row-mic";
      mic.textContent = r.muted ? "🔇" : "🎙";
      const nm = document.createElement("span");
      nm.className = "huddle-row-name";
      nm.textContent = r.name; // untrusted peer name — textContent only
      const st = document.createElement("span");
      st.className = "huddle-row-state gl-hint";
      st.textContent = r.self ? "" : (r.state === "connected" ? "" : r.state);
      row.appendChild(mic); row.appendChild(nm); row.appendChild(st);
      list.appendChild(row);
    }
    updateButtons();
  }
  function updateButtons() {
    const j = el("huddle-join");
    if (j) { j.textContent = joined ? "Leave voice" : "Join voice"; j.classList.toggle("on", joined); }
    const m = el("huddle-mute");
    if (m) {
      m.hidden = !joined;
      m.disabled = !local;
      m.textContent = muted ? "🔇 Unmute" : "🎙 Mute";
      m.setAttribute("aria-pressed", muted ? "true" : "false");
    }
    const btn = el("btn-huddle");
    if (btn) btn.classList.toggle("on", joined);
  }

  // ---- lifecycle ---------------------------------------------------------
  async function join() {
    if (joined) return;
    await acquireMic();          // may be null (listen-only) if denied
    muted = false;
    joined = true;
    if (window.Workspace) window.Workspace.setHuddle({ on: true, muted });
    startMeter();
    syncMesh();                  // members already known from the observer
    updateButtons();
  }
  function leave() {
    if (!joined) return;
    joined = false;
    for (const pid of [...peers.keys()]) { send(pid, "bye", ""); dropPeer(pid); }
    stopMeter();
    stopLocal();
    muted = false;
    if (window.Workspace) window.Workspace.setHuddle(null);
    renderList();
  }
  function toggleMute() {
    if (!joined || !local) return;
    muted = !muted;
    for (const t of local.getAudioTracks()) t.enabled = !muted;
    if (window.Workspace) window.Workspace.setHuddle({ on: true, muted });
    updateButtons();
  }
  function resumed() {
    for (const p of peers.values()) {
      const st = p.pc.connectionState;
      if (st === "failed" || st === "disconnected") p.pc.restartIce();
    }
  }

  // ---- inbound (from app.js / workspace.js) ------------------------------
  function onSignal(ev) { onSignalMsg(ev.from >>> 0, ev.kind, ev.payload, nameOf(ev.from >>> 0)); }
  function onMemberLeft(id) { dropPeer(id >>> 0); }
  function setMembers(list) { members = Array.isArray(list) ? list : []; syncMesh(); renderList(); }
  function nameOf(pid) { const m = members.find((x) => x.pid === pid); return m ? m.name : ("#" + pid); }

  // ---- pane visibility ---------------------------------------------------
  function isOpen() { const p = el("huddle-pane"); return p && !p.hidden; }
  function open() {
    const p = el("huddle-pane"); if (p) p.hidden = false;
    const btn = el("btn-huddle"); if (btn) btn.setAttribute("aria-expanded", "true");
    renderList();
  }
  function close() {
    const p = el("huddle-pane"); if (p) p.hidden = true;
    const btn = el("btn-huddle"); if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function toggle() { if (isOpen()) close(); else open(); }

  // ---- init --------------------------------------------------------------
  function init(opts) {
    // leave any prior session's huddle before rebinding to the new one
    if (joined) leave();
    send = (opts && opts.send) || (() => {});
    selfId = ((opts && opts.self && opts.self.id) || 0) >>> 0;
    selfName = (opts && opts.self && opts.self.name) || "you";
    joined = false; muted = false; members = [];
    if (window.Workspace && window.Workspace.registerHuddleObserver) {
      window.Workspace.registerHuddleObserver(setMembers);
    }
    wireOnce("btn-huddle", "click", toggle);
    wireOnce("btn-huddle-close", "click", close);
    wireOnce("huddle-join", "click", () => (joined ? leave() : join()));
    wireOnce("huddle-mute", "click", toggleMute);
    renderList();
  }
  function wireOnce(id, ev, fn) {
    const node = el(id);
    if (node && !node["_w_" + ev]) { node.addEventListener(ev, fn); node["_w_" + ev] = true; }
  }

  window.Huddle = { init, onSignal, onMemberLeft, join, leave, toggleMute, resumed, open, close, toggle };
})();
