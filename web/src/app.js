// app.js — the session shell. Owns the home/workspace views, the invite modal,
// History-API navigation, and the pump that turns core (WASM) events into
// Workspace calls. The document/editor logic all lives in workspace.js; this
// file never touches Yjs. Bridge seam: scriptorium_send(json) out,
// scriptoriumOnEvent(json) in.
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const send = (obj) => window.scriptorium_send(JSON.stringify(obj));

  let coreReady = false;
  let selfId = 0;
  let hostId = -1;
  let phrase = "";
  let shareLink = "";

  // A stable, pleasant colour per participant id (for cursors/presence).
  function colorFor(id) {
    const hues = [265, 200, 150, 20, 330, 45, 100, 300];
    return `hsl(${hues[id % hues.length]} 70% 62%)`;
  }
  function nameInput() { return (el("name").value || "").trim(); }

  // ---- views -------------------------------------------------------------
  function showHome() {
    el("view-home").classList.remove("hidden");
    el("view-workspace").classList.add("hidden");
  }
  function showWorkspace() {
    el("view-home").classList.add("hidden");
    el("view-workspace").classList.remove("hidden");
  }

  function toast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---- home actions ------------------------------------------------------
  function refreshAction() {
    const btn = el("btn-action");
    const has = (el("join-phrase").value || "").trim().length > 0;
    btn.textContent = has ? "→ Join workspace" : "▶ New workspace";
    btn.disabled = !coreReady;
  }
  function doAction() {
    if (!coreReady) return;
    const p = (el("join-phrase").value || "").trim();
    const name = nameInput();
    Workspace.setSend(send);
    if (p) send({ type: "join", phrase: p, name });
    else send({ type: "create", name });
    el("btn-action").disabled = true;
    el("home-status").textContent = p ? "joining…" : "starting an encrypted workspace…";
  }

  // ---- session lifecycle -------------------------------------------------
  function enterWorkspace(isHost) {
    Workspace.reset();
    Workspace.setSend(send);
    Workspace.setSelf({ name: nameInput() || "anon", color: colorFor(selfId) });
    Workspace.setHost(isHost);
    showWorkspace();
    if (isHost) Workspace.seedIfEmpty();
    else el("home-status").textContent = "";
  }

  function onCreated(e) {
    selfId = e.self >>> 0;
    hostId = selfId;
    phrase = e.phrase;
    shareLink = e.url;
    enterWorkspace(true);
    setInvite(e.phrase, e.url, e.qr);
    history.replaceState({ phrase }, "", "#" + phrase);
    openInvite(); // first-run nudge to share
  }
  function onJoined(e) {
    selfId = e.self >>> 0;
    enterWorkspace(false);
    if (!location.hash) history.replaceState({ phrase: joinedPhrase() }, "", "#" + joinedPhrase());
    el("home-status").textContent = "catching up…";
  }
  function joinedPhrase() { return (el("join-phrase").value || "").trim(); }

  function onRoster(e) {
    hostId = e.host >>> 0;
    Workspace.setHost(hostId === selfId);
  }

  function onClosed(reason) {
    toast(reason ? "session ended: " + reason : "session ended");
    showHome();
    el("reconnect-banner").hidden = true;
    el("btn-action").disabled = !coreReady;
    el("home-status").textContent = "";
    history.replaceState({}, "", location.pathname);
  }

  // ---- the pump ----------------------------------------------------------
  const handlers = {
    "core.ready": () => { coreReady = true; refreshAction(); el("home-status").textContent = "ready — start or join a workspace."; },
    "session.created": onCreated,
    "session.joined": onJoined,
    "roster": onRoster,
    "doc.update": (e) => Workspace.applyUpdate(e.fileID, e.update),
    "doc.awareness": (e) => Workspace.applyAwareness(e.from, e.update),
    "doc.catchup.request": (e) => Workspace.onCatchupRequest(e.from >>> 0),
    "doc.catchup.end": (e) => Workspace.onCatchupEnd(e.from >>> 0),
    "member.left": () => Workspace.renderPresence(),
    "session.promoted": (e) => { selfId = e.self >>> 0; hostId = selfId; Workspace.setHost(true); toast("you're the host now"); },
    "session.reconnecting": () => { el("reconnect-banner").hidden = false; },
    "session.resumed": () => { el("reconnect-banner").hidden = true; toast("reconnected"); },
    "session.closed": (e) => onClosed(e.reason),
    "error": (e) => { toast(e.message || "something went wrong"); el("btn-action").disabled = !coreReady; },
  };

  window.scriptoriumOnEvent = function (raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch (_) { return; }
    const h = handlers[ev.type];
    if (h) h(ev);
  };

  // ---- invite ------------------------------------------------------------
  function setInvite(p, url, qrB64) {
    el("invite-phrase").textContent = p;
    if (qrB64) el("invite-qr").src = "data:image/png;base64," + qrB64;
    shareLink = url;
  }
  function openInvite() { el("invite-modal").hidden = false; }
  function closeInvite() { el("invite-modal").hidden = true; }

  // ---- History-API navigation -------------------------------------------
  // A phrase in the URL hash means "join this workspace"; back/forward or
  // closing the tab tears the session down (reconnect = re-enter the phrase).
  function wireNav() {
    window.addEventListener("hashchange", () => {
      const p = location.hash.replace(/^#/, "");
      if (p && !isInWorkspace()) {
        el("join-phrase").value = p;
        refreshAction();
        doAction();
      }
    });
    window.addEventListener("pagehide", () => { if (isInWorkspace()) send({ type: "leave" }); });
    // Deep-link on first load.
    if (location.hash.length > 1) {
      el("join-phrase").value = location.hash.slice(1);
    }
  }
  function isInWorkspace() { return !el("view-workspace").classList.contains("hidden"); }

  // ---- wiring ------------------------------------------------------------
  function boot() {
    Workspace.wireControls();
    el("join-phrase").addEventListener("input", refreshAction);
    el("btn-action").addEventListener("click", doAction);
    el("btn-invite").addEventListener("click", openInvite);
    el("btn-close-invite").addEventListener("click", closeInvite);
    el("btn-copy-link").addEventListener("click", () => copy(shareLink, "link copied"));
    el("btn-copy-phrase").addEventListener("click", () => copy(phrase, "phrase copied"));
    el("btn-leave").addEventListener("click", () => { send({ type: "leave" }); });
    // Chat is a fast-follow (needs the parley chat service wired into the core);
    // hide its controls until then rather than show dead UI.
    if (el("btn-chat")) el("btn-chat").hidden = true;

    fetch("/version").then((r) => (r.ok ? r.text() : "")).then((v) => {
      if (v) el("version-badge").textContent = "scriptorium " + v.trim();
    }).catch(() => {});

    wireNav();
    refreshAction();
  }

  function copy(text, ok) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => toast(ok)).catch(() => toast("couldn't copy"));
  }

  // ---- WASM load ---------------------------------------------------------
  function loadCore() {
    const go = new Go();
    const url = "scriptorium.wasm";
    const run = (result) => go.run(result.instance);
    if (WebAssembly.instantiateStreaming) {
      WebAssembly.instantiateStreaming(fetch(url), go.importObject).then(run).catch(fallback);
    } else { fallback(); }
    function fallback() {
      fetch(url).then((r) => r.arrayBuffer())
        .then((b) => WebAssembly.instantiate(b, go.importObject)).then(run)
        .catch((e) => { el("home-status").textContent = "failed to load the core: " + e; });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); loadCore(); });
  } else { boot(); loadCore(); }
})();
