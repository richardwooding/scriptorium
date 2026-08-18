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
  let pendingView = false; // next join should be view-only (came from a ?view link)

  // A view-only share link keeps the phrase in the fragment (never sent to the
  // server) and marks the mode with `?view`: `#<phrase>?view`. Parse both out.
  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    const q = raw.indexOf("?");
    if (q < 0) return { phrase: raw, view: false };
    return { phrase: raw.slice(0, q), view: new URLSearchParams(raw.slice(q + 1)).has("view") };
  }

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
    btn.textContent = has ? (pendingView ? "→ View (read-only)" : "→ Join workspace") : "▶ New workspace";
    btn.disabled = !coreReady;
  }
  function doAction() {
    if (!coreReady) return;
    const p = (el("join-phrase").value || "").trim();
    const name = nameInput();
    Workspace.setSend(send);
    if (p) send({ type: "join", phrase: p, name, observer: pendingView });
    else send({ type: "create", name });
    el("btn-action").disabled = true;
    el("home-status").textContent = p ? (pendingView ? "opening view-only…" : "joining…") : "starting an encrypted workspace…";
  }

  // ---- session lifecycle -------------------------------------------------
  function enterWorkspace(isHost, observer) {
    Workspace.reset();
    Workspace.setSend(send);
    Workspace.setSelf({ name: nameInput() || "anon", color: colorFor(selfId), pid: selfId });
    Workspace.setHost(isHost);
    Workspace.setReadOnly(!!observer);
    showWorkspace();
    if (isHost) {
      // Host restores an encrypted cloud snapshot (if any) before seeding /
      // serving catch-up, so peers catch up on the persisted state. seedIfEmpty
      // is a no-op when the restore populated the doc; it runs when there was
      // nothing stored (or cloud is dormant).
      // Wait for the offline store to replay (whenReady) AND the cloud restore
      // before deciding to seed — otherwise seedIfEmpty (guards only on a sync
      // meta.size check) would plant a second README on top of a store still
      // loading from IndexedDB.
      Workspace.whenReady()
        .then(function () { return Workspace.cloudRestore(); })
        .then(function (restored) { if (!restored) Workspace.seedIfEmpty(); });
    } else {
      el("home-status").textContent = "";
    }
    // The AI assistant is a local, browser-only feature: it talks to the user's
    // own provider directly and edits files via Workspace. Fresh per session.
    // Observers are view-only — skip write features entirely (their buttons are
    // also hidden by the .read-only CSS).
    if (window.Assistant && !observer) {
      Assistant.init({ workspace: Workspace, self: { name: nameInput() || "anon", pid: selfId } });
    }
    // Publish is a local, browser-only feature: it pushes the workspace straight
    // to GitHub with the user's own token (relay never in the loop), then Actions
    // builds & publishes. Fresh per session.
    if (window.Publish && !observer) Publish.init({ workspace: Workspace });
    // The huddle (WebRTC voice) meshes peers over the same session; signaling
    // rides the core, audio is P2P. Fresh per session. The send wrapper adapts
    // huddle.js's (to,kind,payload) calls to the bridge's huddle.signal command.
    if (window.Huddle) {
      Huddle.init({
        send: (to, kind, payload) => send({ type: "huddle.signal", to, kind, payload }),
        self: { id: selfId, name: nameInput() || "anon" },
      });
    }
  }

  function onCreated(e) {
    selfId = e.self >>> 0;
    hostId = selfId;
    phrase = e.phrase;
    shareLink = e.url;
    if (window.Cloud) Cloud.configure(e.sid, e.cloudKey);
    Workspace.setSession(e.sid); // scope the offline store before reset() attaches it
    enterWorkspace(true);
    setInvite(e.phrase, e.url, e.qr);
    history.replaceState({ phrase }, "", "#" + phrase);
    // Fresh workspace → nudge to share. Reopened (re-hosted a known phrase) →
    // the user already has the phrase; just confirm, and cloud restore runs.
    if (e.reopened) toast("workspace reopened"); else openInvite();
  }
  function onJoined(e) {
    selfId = e.self >>> 0;
    if (window.Cloud && !e.observer) Cloud.configure(e.sid, e.cloudKey);
    Workspace.setSession(e.sid); // scope the offline store before reset() attaches it
    enterWorkspace(false, !!e.observer);
    if (!location.hash) history.replaceState({ phrase: joinedPhrase() }, "", "#" + joinedPhrase());
    el("home-status").textContent = e.observer ? "viewing (read-only)…" : "catching up…";
  }
  function joinedPhrase() { return (el("join-phrase").value || "").trim(); }

  function onRoster(e) {
    hostId = e.host >>> 0;
    Workspace.setHost(hostId === selfId);
    Workspace.setObservers(e.observers || []);
  }

  function onClosed(reason) {
    if (window.Huddle) Huddle.leave();
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
    "doc.update": (e) => Workspace.applyUpdate(e.fileID, e.update, e.from >>> 0),
    "doc.awareness": (e) => Workspace.applyAwareness(e.from, e.update),
    "doc.catchup.request": (e) => Workspace.onCatchupRequest(e.from >>> 0),
    "doc.catchup.end": (e) => Workspace.onCatchupEnd(e.from >>> 0),
    "huddle.signal": (e) => { if (window.Huddle) Huddle.onSignal(e); },
    "member.left": (e) => { Workspace.removePeer(e.id >>> 0); if (window.Huddle) Huddle.onMemberLeft(e.id >>> 0); },
    "session.promoted": (e) => { selfId = e.self >>> 0; hostId = selfId; Workspace.setHost(true); toast("you're the host now"); },
    "session.reconnecting": () => { el("reconnect-banner").hidden = false; },
    "session.resumed": () => { el("reconnect-banner").hidden = true; toast("reconnected"); if (window.Huddle) Huddle.resumed(); },
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
      const { phrase: p, view } = parseHash();
      if (p && !isInWorkspace()) {
        el("join-phrase").value = p;
        pendingView = view;
        refreshAction();
        doAction();
      }
    });
    window.addEventListener("pagehide", () => { if (isInWorkspace()) { if (window.Huddle) Huddle.leave(); send({ type: "leave" }); } });
    // Deep-link on first load (pre-fills; the user clicks to join/view).
    if (location.hash.length > 1) {
      const { phrase: p, view } = parseHash();
      el("join-phrase").value = p;
      pendingView = view;
    }
  }
  function isInWorkspace() { return !el("view-workspace").classList.contains("hidden"); }

  // ---- wiring ------------------------------------------------------------
  function boot() {
    Workspace.wireControls();
    // Typing a phrase by hand is an edit-join; clear any view-only intent that a
    // ?view link set so the manual join isn't silently downgraded to read-only.
    el("join-phrase").addEventListener("input", () => { pendingView = false; refreshAction(); });
    el("btn-action").addEventListener("click", doAction);
    el("btn-invite").addEventListener("click", openInvite);
    el("btn-download").addEventListener("click", async () => {
      if (!window.Download) { toast("download unavailable — reload the page (Ctrl/Cmd+Shift+R)"); return; }
      try {
        const r = await Download.saveZip();
        toast(r.fileCount ? "downloaded " + r.name : "nothing to download yet");
      } catch (e) { toast("download failed: " + (e && e.message ? e.message : e)); }
    });
    el("btn-close-invite").addEventListener("click", closeInvite);
    el("btn-copy-link").addEventListener("click", () => copy(shareLink, "link copied"));
    el("btn-copy-phrase").addEventListener("click", () => copy(phrase, "phrase copied"));
    // A view-only link is the same fragment with a ?view marker — joiners open it
    // as read-only spectators (they can watch and hear, but never edit).
    if (el("btn-copy-view-link")) {
      el("btn-copy-view-link").addEventListener("click", () => copy(shareLink ? shareLink + "?view" : "", "view-only link copied"));
    }
    el("btn-leave").addEventListener("click", () => { if (window.Huddle) Huddle.leave(); send({ type: "leave" }); });
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

  // Register the service worker for fast repeat loads / offline shell. It never
  // intercepts /ws and is network-first for navigations and the wasm, so a
  // deploy is never served stale.
  function registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    }
  }

  // PWA install: Chrome/Android fire beforeinstallprompt when the app is
  // installable — stash it and reveal an "Install app" button on the home view.
  // Already-installed / standalone → stay hidden. iOS Safari doesn't fire this
  // (users use Share → Add to Home Screen), so the button simply never appears.
  function setupInstall() {
    const btn = el("btn-install");
    if (!btn) return;
    const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
    if (standalone) return;
    let deferred = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferred = e;
      btn.hidden = false;
    });
    btn.addEventListener("click", async () => {
      if (!deferred) return;
      btn.disabled = true;
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) { /* dismissed */ }
      deferred = null;
      btn.hidden = true;
      btn.disabled = false;
    });
    window.addEventListener("appinstalled", () => { deferred = null; btn.hidden = true; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); loadCore(); registerSW(); setupInstall(); });
  } else { boot(); loadCore(); registerSW(); setupInstall(); }
})();
