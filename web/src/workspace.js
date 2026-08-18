// workspace.js — the collaborative document layer.
//
// One Y.Doc holds the whole workspace: `meta` (a Y.Map of tree nodes) and
// `contents` (a Y.Map of fileId → Y.Text). All of it rides a single opaque
// Yjs update stream to the Go `doc` service, which chunks anything over one
// parley frame and relays it end-to-end-encrypted. This file owns the editor
// (CodeMirror 6 via window.CMEditor), the file tree, tabs, and markdown
// preview; app.js owns the session and pumps bridge events into here.
//
// Invariant that keeps the network loop from spinning: every update we *apply*
// from a peer is tagged with the REMOTE origin, and our own update handler
// ignores REMOTE-origin transactions — so we only broadcast local keystrokes.
(function () {
  "use strict";

  const Y = window.Y;
  const { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } = window.YProto;
  const REMOTE = "remote"; // transaction origin tag for peer-applied updates
  const WS = "@ws";        // single fileID for the whole-workspace update stream

  const el = (id) => document.getElementById(id);
  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "f-" + Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");

  const b64encode = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const b64decode = (s) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  // ---- state -------------------------------------------------------------
  let doc = null;          // the Y.Doc
  let meta = null;         // Y.Map: fileId → {name, parent, kind, order, bin?, mime?}
  let contents = null;     // Y.Map: fileId → Y.Text (text files)
  let blobs = null;        // Y.Map: fileId → Uint8Array (binary files)
  let settings = null;     // Y.Map: workspace-level shared values (e.g. "name")
  let awareness = null;
  let send = () => {};     // bridge send, injected by app.js
  let self = { name: "anon", color: "#a371f7", host: false };
  let openTabs = [];       // [fileId]
  let activeId = null;
  let editor = null;       // { view, setLanguage, destroy } from CMEditor
  let previewObserver = null;
  let previewText = null;
  let enrichTimer = null;
  let aiUndo = null;       // Y.UndoManager scoped to origin "ai" (assistant edits)
  let previewEnabled = true; // user toggle for the preview pane (persisted)
  let huddleObserver = null; // huddle.js callback: who's in the voice huddle
  let binURL = null;         // object URL of the currently-shown binary viewer
  // Offline-first: persist the Y.Doc to IndexedDB so a reload — or going
  // offline — keeps local state and merges back (CRDT) on reconnect. The local
  // copy is PLAINTEXT at rest (unlike the phrase-encrypted cloud snapshot), so
  // it's user-toggleable; turning it off deletes the store. Default on.
  let persistence = null;        // IndexeddbPersistence for the current doc
  let persistenceReady = Promise.resolve(); // resolves once IndexedDB has replayed
  let sessionKey = null;         // per-session store key (SessionID hex)
  let offlineEnabled = true;     // user toggle (persisted: scriptorium-offline)
  // View-only (observer) mode: this client joined via a read-only share link, so
  // it may watch and hear but never write. Enforcement is layered — read-only
  // editor + hidden write UI here, the core drops our doc.update on the wire, and
  // receivers drop updates that originate from a known-observer peer (below).
  let readOnly = false;          // are WE a spectator?
  let observerIds = new Set();   // parley ids the host seated as observers

  // Broadcast local awareness (cursor/presence) changes to peers. A named
  // handler (not an inline closure) so reset() can detach it from the previous
  // session's awareness before tearing the editor down — otherwise the yCollab
  // unbind removes our local state, which re-enters this on an awareness that's
  // mid-teardown and makes encodeAwarenessUpdate throw on the dropped client.
  // The try/catch is belt-and-suspenders for any other teardown path; dropping a
  // presence frame during shutdown is harmless.
  function awarenessBroadcast({ added, updated, removed }, origin) {
    if (origin === REMOTE || !awareness) return;
    try {
      const changed = added.concat(updated, removed);
      const payload = encodeAwarenessUpdate(awareness, changed);
      send({ type: "doc.awareness", update: b64encode(payload) });
    } catch (_) { /* awareness mid-teardown: nothing to broadcast */ }
  }

  // ---- lifecycle ---------------------------------------------------------
  function reset() {
    // Detach the previous session's presence broadcaster before destroying its
    // editor, so the yCollab unbind (which removes our local awareness state)
    // can't fire it on a torn-down awareness (issue #23).
    if (awareness) awareness.off("update", awarenessBroadcast);
    if (editor) { editor.destroy(); editor = null; }
    revokeBinURL();
    doc = new Y.Doc();
    meta = doc.getMap("meta");
    contents = doc.getMap("contents");
    blobs = doc.getMap("blobs"); // binary file bytes; rides the same @ws stream
    settings = doc.getMap("settings"); // shared workspace-level values (name, …)
    awareness = new Awareness(doc);
    // Undo scoped to the AI assistant: tracks only "ai"-origin changes to the
    // tree and every file's Y.Text (descendants of `contents`), so "undo this
    // turn" reverts assistant edits without ever touching human/peer edits.
    // captureTimeout:Infinity → edits never auto-split by time; a turn is
    // delimited explicitly by aiCheckpoint()/stopCapturing(), so all of a turn's
    // tool-call transactions (spread across model round-trips) merge into ONE
    // undo item.
    aiUndo = new Y.UndoManager([meta, contents], {
      trackedOrigins: new Set(["ai"]),
      captureTimeout: Infinity,
    });
    openTabs = [];
    activeId = null;
    previewObserver = null;
    previewText = null;

    // Local edits → broadcast; peer-applied (REMOTE) updates are ignored so we
    // don't echo. seq/size safety lives in the Go service, not here.
    doc.on("update", (update, origin) => {
      if (origin === REMOTE || readOnly) return; // observers never broadcast
      send({ type: "doc.update", fileID: WS, update: b64encode(update) });
    });
    // Cloud autosave (host only): the host is the single writer that persists
    // the whole merged doc — so this fires on ANY change, including REMOTE peer
    // edits, so peers' work is saved too. Debounced + gated inside window.Cloud.
    doc.on("update", () => {
      if (self.host && window.Cloud) window.Cloud.scheduleSave(() => Y.encodeStateAsUpdate(doc));
    });
    awareness.on("update", awarenessBroadcast);
    meta.observeDeep(() => renderTree());
    settings.observe(renderWorkspaceName);
    // Offline persistence rides the SAME doc. Its replayed updates carry the
    // provider's own origin (not REMOTE), so the broadcaster above re-sends them
    // once on load — that's how a joiner's offline edits reach the host on
    // reconnect (idempotent CRDT merge); the host serves its own state via
    // catch-up regardless. seedIfEmpty must await whenReady() so we don't seed a
    // second README on top of a store that's still loading.
    attachPersistence();
    renderTree();
    renderTabs();
    updateEmptyHint();
    renderWorkspaceName();
  }

  // ---- offline persistence (y-indexeddb) ---------------------------------
  // Attach a fresh IndexeddbPersistence to the current doc, scoped to the
  // session so different phrases never share a store. Idempotent-ish: it first
  // tears down any prior provider (from the previous session's doc). No-op when
  // the toggle is off, there's no session yet, or IndexedDB / the bundle is
  // unavailable (e.g. private-mode browsers).
  function attachPersistence() {
    detachPersistence(false);
    persistenceReady = Promise.resolve();
    if (!offlineEnabled || !sessionKey || !doc) return;
    if (!window.YIndexeddb || !window.indexedDB) return;
    try {
      persistence = new window.YIndexeddb("scriptorium:" + sessionKey, doc);
      // Swallow load errors so a corrupt store never blocks starting fresh.
      persistenceReady = persistence.whenSynced.then(() => {}, () => {});
    } catch (_) { persistence = null; }
  }
  // Detach the provider. clear=true also DELETES the local store (used when the
  // user turns offline off); clear=false just stops persisting (session change).
  function detachPersistence(clear) {
    if (!persistence) return;
    const p = persistence;
    persistence = null;
    try {
      if (clear && typeof p.clearData === "function") p.clearData().catch(() => {});
      else p.destroy();
    } catch (_) { /* best effort */ }
  }
  // Resolves once the local store has replayed into the doc (or immediately when
  // persistence is off). Host open gates seedIfEmpty on this + cloudRestore.
  function whenReady() { return persistenceReady; }
  // Per-session store key (SessionID hex), set by app.js before reset().
  function setSession(sid) { sessionKey = sid || null; }

  // Toggle offline persistence. Turning it OFF deletes the plaintext local copy
  // (after a confirm, since it's a deliberate data-destroying action). Turning
  // it ON attaches to the live doc immediately, capturing current state.
  function setOffline(on) {
    on = !!on;
    if (on === offlineEnabled) { updateOfflineToggle(); return; }
    if (!on && persistence &&
        !confirm("Turn off the offline copy and delete this workspace's local copy from this browser? Your work stays in the live session.")) {
      updateOfflineToggle();
      return;
    }
    offlineEnabled = on;
    try { localStorage.setItem("scriptorium-offline", on ? "1" : "0"); } catch (_) { /* private mode */ }
    if (on) attachPersistence();
    else detachPersistence(true);
    updateOfflineToggle();
  }
  function toggleOffline() { setOffline(!offlineEnabled); }
  function updateOfflineToggle() {
    const b = el("btn-offline");
    if (!b) return;
    b.setAttribute("aria-pressed", offlineEnabled ? "true" : "false");
    b.classList.toggle("on", offlineEnabled);
    b.title = offlineEnabled
      ? "Offline copy on — this workspace is saved in this browser (plaintext) so reloads and offline work. Click to turn off and delete it."
      : "Offline copy off — nothing is stored in this browser. Click to keep a local copy for reloads and offline editing.";
  }

  // ---- workspace name (shared, synced via the settings map) --------------
  const DEFAULT_TITLE = "scriptorium — shared editing, paired like a secret";
  // Reflect the shared name into the topbar field + browser tab title. Skips
  // the input when it's focused so a peer's update (or our own echo) never
  // clobbers what someone is typing.
  function renderWorkspaceName() {
    const name = (settings && settings.get("name")) || "";
    const input = el("ws-name");
    if (input && document.activeElement !== input) input.value = name;
    document.title = name ? name + " — scriptorium" : DEFAULT_TITLE;
  }
  function setWorkspaceName(str) {
    if (!settings) return;
    settings.set("name", String(str == null ? "" : str));
  }
  function getWorkspaceName() {
    return (settings && settings.get("name")) || "";
  }

  // cloudRestore (host-on-open): fetch+decrypt the stored snapshot via window.Cloud
  // and merge it into the doc with the REMOTE origin (so the broadcaster/autosave
  // don't treat it as a fresh local edit). Returns true if state was applied,
  // false when there's nothing stored / cloud is dormant / Cloud is absent — the
  // caller then falls back to seedIfEmpty. Never throws (persistence is optional).
  async function cloudRestore() {
    if (!window.Cloud) return false;
    try {
      const bytes = await window.Cloud.restore();
      if (bytes && bytes.length) {
        Y.applyUpdate(doc, bytes, REMOTE);
        renderTree(); renderTabs(); updateEmptyHint();
        return true;
      }
    } catch (_) { /* fall back to a fresh/seeded workspace */ }
    return false;
  }

  function setSend(fn) { send = fn; }
  function setSelf(info) {
    self = Object.assign(self, info || {});
    if (awareness) {
      // Stamp our parley participant id into the awareness state so peers can
      // prune it the moment `member.left` fires (awareness is otherwise keyed
      // by Yjs clientID, which the core's leave event can't reference).
      awareness.setLocalStateField("user", { name: self.name, color: self.color, pid: self.pid });
    }
  }

  // A peer left the session: drop any awareness state we're holding for their
  // parley id, so their presence chip disappears at once instead of waiting for
  // Yjs's ~30s awareness timeout. Tagged REMOTE so we don't rebroadcast — every
  // client independently gets the same member.left and prunes its own copy.
  function removePeer(pid) {
    if (!awareness) return;
    const gone = [];
    awareness.getStates().forEach((st, clientID) => {
      if (st && st.user && st.user.pid === pid) gone.push(clientID);
    });
    if (gone.length) removeAwarenessStates(awareness, gone, REMOTE);
    renderPresence();
    refreshViewingAvatars();
  }
  function setHost(isHost) { self.host = !!isHost; }

  // Enter/leave view-only mode. Hides write controls (a `.read-only` class on the
  // workspace view drives the CSS), locks the name field + editor, and shows the
  // "View only" badge. The editor may not be mounted yet (mountEditor reads the
  // flag), so this reconfigures a live editor when present and is idempotent.
  function setReadOnly(on) {
    readOnly = !!on;
    const root = el("view-workspace");
    if (root) root.classList.toggle("read-only", readOnly);
    const nm = el("ws-name");
    if (nm) nm.readOnly = readOnly;
    const badge = el("readonly-badge");
    if (badge) badge.hidden = !readOnly;
    if (editor && editor.setReadOnly) editor.setReadOnly(readOnly);
    renderPresence();
  }
  function isReadOnly() { return readOnly; }
  // The host-assigned roster tells everyone which participants are spectators —
  // authoritative (a peer can't lie its way out of it). Used to badge them in
  // presence AND to drop any doc.update a spectator manages to put on the wire.
  function setObservers(ids) {
    observerIds = new Set((ids || []).map(Number));
    renderPresence();
    scheduleViewingAvatars();
  }

  // A brand-new workspace gets one starter file so there's something to type in.
  function seedIfEmpty() {
    if (meta.size > 0) return;
    const id = createFile("README.md", "");
    const t = contents.get(id);
    if (t && t.length === 0) {
      t.insert(0, "# New workspace\n\nStart typing — everyone with the phrase sees it live.\n");
    }
    openFile(id);
  }

  // ---- inbound from peers (via app.js) -----------------------------------
  function applyUpdate(_fileID, b64, from) {
    // A spectator must not be able to mutate the shared doc even by crafting
    // frames (it holds the group key to view). Drop updates from any peer the
    // host seated as an observer — the read-only guarantee holds for everyone.
    if (from !== undefined && observerIds.has(Number(from))) return;
    try { Y.applyUpdate(doc, b64decode(b64), REMOTE); }
    catch (e) { console.warn("[doc] bad update", e); }
  }
  function applyAwareness(_from, b64) {
    try { applyAwarenessUpdate(awareness, b64decode(b64), REMOTE); }
    catch (e) { console.warn("[doc] bad awareness", e); }
    renderPresence();
    scheduleViewingAvatars();
  }
  // Host answers a late joiner: hand them the full current state, then signal
  // done. Go chunks the (possibly large) state across frames.
  function onCatchupRequest(from) {
    if (!self.host) return;
    const state = Y.encodeStateAsUpdate(doc);
    send({ type: "doc.catchup.provide", to: from, fileID: WS, state: b64encode(state) });
    // also share our awareness so the joiner sees who's here immediately
    const aw = encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys()));
    send({ type: "doc.awareness", update: b64encode(aw) });
    send({ type: "doc.catchup.end", to: from });
  }
  function onCatchupEnd(_from) {
    // State (arriving as doc.update chunks) has been applied; make sure the UI
    // reflects it and, if nothing is open yet, open the first file.
    renderTree();
    if (!activeId) {
      const first = firstFileId();
      if (first) openFile(first);
    }
    setStatus("");
  }

  // ---- tree model --------------------------------------------------------
  function createFile(name, parent) {
    const id = uuid();
    meta.set(id, { name, parent: parent || "", kind: "file", order: meta.size });
    contents.set(id, new Y.Text());
    return id;
  }
  function createDir(name, parent) {
    const id = uuid();
    meta.set(id, { name, parent: parent || "", kind: "dir", order: meta.size });
    return id;
  }
  function renameNode(id, name) {
    const n = meta.get(id);
    if (n) meta.set(id, Object.assign({}, n, { name }));
  }
  function deleteNode(id) {
    const n = meta.get(id);
    if (!n) return;
    if (n.kind === "dir") {
      childrenOf(id).forEach((c) => deleteNode(c));
    } else {
      contents.delete(id);
      blobs.delete(id); // no-op for text files; frees binary bytes
    }
    meta.delete(id);
    closeTab(id);
  }
  const isBinNode = (n) => !!(n && n.bin);
  function childrenOf(parent) {
    const out = [];
    meta.forEach((n, id) => { if (n.parent === parent) out.push(id); });
    out.sort((a, b) => {
      const na = meta.get(a), nb = meta.get(b);
      if (na.kind !== nb.kind) return na.kind === "dir" ? -1 : 1;
      return na.name.localeCompare(nb.name);
    });
    return out;
  }
  function firstFileId() {
    let found = null;
    meta.forEach((n, id) => { if (!found && n.kind === "file") found = id; });
    return found;
  }

  // ---- tree rendering ----------------------------------------------------
  function renderTree() {
    const root = el("tree");
    if (!root) return;
    root.textContent = "";
    const build = (parent, depth) => {
      childrenOf(parent).forEach((id) => {
        const n = meta.get(id);
        const li = document.createElement("li");
        li.className = "tree-node " + n.kind + (id === activeId ? " active" : "");
        li.dataset.id = id;
        li.setAttribute("role", "treeitem");
        li.style.paddingLeft = 8 + depth * 14 + "px";
        li.tabIndex = 0;

        const icon = document.createElement("span");
        icon.className = "tn-icon";
        icon.textContent = n.kind === "dir" ? "📁" : iconFor(n.name);
        const label = document.createElement("span");
        label.className = "tn-name";
        label.textContent = n.name; // untrusted peer content — textContent only

        li.appendChild(icon);
        li.appendChild(label);

        const del = document.createElement("button");
        del.className = "tn-del icon-btn";
        del.title = "Delete";
        del.setAttribute("aria-label", "Delete " + n.name);
        del.textContent = "✕";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteNode(id);
        });
        li.appendChild(del);

        const activate = () => { if (n.kind === "file") openFile(id); };
        li.addEventListener("click", activate);
        li.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
          if (e.key === "F2") { e.preventDefault(); promptRename(id); }
        });
        li.addEventListener("dblclick", () => promptRename(id));

        root.appendChild(li);
        if (n.kind === "dir") build(id, depth + 1);
      });
    };
    build("", 0);
    refreshViewingAvatars();
  }
  // ---- per-file presence (who's viewing which file) ----------------------
  // Peer "mini" avatars on each file's tab + tree row, from the awareness
  // `file` field. Updated IN PLACE (no tree rebuild) and throttled, because
  // cursor moves also flood the awareness channel.
  let viewingTimer = null;
  function scheduleViewingAvatars() {
    if (viewingTimer) return;
    viewingTimer = setTimeout(() => { viewingTimer = null; refreshViewingAvatars(); }, 120);
  }
  function refreshViewingAvatars() {
    document.querySelectorAll(".viewing-avatars").forEach((e) => e.remove());
    if (!awareness) return;
    const byFile = new Map();
    awareness.getStates().forEach((st) => {
      const u = st && st.user;
      const fid = st && st.file;
      if (!u || !fid || u.pid === self.pid) return; // skip self + peers not in a file
      if (!byFile.has(fid)) byFile.set(fid, []);
      byFile.get(fid).push(u);
    });
    if (!byFile.size) return;
    document.querySelectorAll("#tabs .tab[data-id]").forEach((tab) => {
      const peers = byFile.get(tab.dataset.id);
      if (peers) tab.appendChild(avatarCluster(peers));
    });
    document.querySelectorAll("#tree .tree-node[data-id]").forEach((row) => {
      const peers = byFile.get(row.dataset.id);
      if (peers) row.insertBefore(avatarCluster(peers), row.querySelector(".tn-del"));
    });
  }
  function avatarCluster(peers) {
    const wrap = document.createElement("span");
    wrap.className = "viewing-avatars";
    peers.slice(0, 3).forEach((u) => {
      const a = document.createElement("span");
      a.className = "who who-mini";
      a.style.background = u.color || "#6e7681";
      a.textContent = (u.name || "?").slice(0, 1).toUpperCase();
      a.title = (u.name || "someone") + " is viewing this file";
      wrap.appendChild(a);
    });
    if (peers.length > 3) {
      const more = document.createElement("span");
      more.className = "who who-mini who-more";
      more.textContent = "+" + (peers.length - 3);
      more.title = peers.length + " people viewing";
      wrap.appendChild(more);
    }
    return wrap;
  }
  function promptRename(id) {
    if (readOnly) return;
    const n = meta.get(id);
    if (!n) return;
    const name = window.prompt("Rename", n.name);
    if (name && name.trim()) renameNode(id, name.trim());
  }
  function iconFor(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (["md", "markdown"].includes(ext)) return "📝";
    if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "🖼";
    if (["json", "yaml", "yml", "toml"].includes(ext)) return "⚙";
    return "📄";
  }

  // ---- tabs + editor -----------------------------------------------------
  function openFile(id) {
    const n = meta.get(id);
    if (!n || n.kind !== "file") return;
    if (!openTabs.includes(id)) openTabs.push(id);
    activeId = id;
    setViewing();
    mountEditor(id);
    renderTabs();
    renderTree();
    updateEmptyHint();
    syncPreview();
  }
  function closeTab(id) {
    openTabs = openTabs.filter((t) => t !== id);
    if (activeId === id) {
      activeId = openTabs[openTabs.length - 1] || null;
      if (activeId) mountEditor(activeId);
      else { if (editor) { editor.destroy(); editor = null; } revokeBinURL(); el("editor-host").textContent = ""; }
      setViewing();
    }
    renderTabs();
    updateEmptyHint();
    syncPreview();
  }
  // Broadcast which file this client is viewing, so peers can show presence
  // avatars on that file's tab/tree row. Rides the same awareness channel.
  function setViewing() {
    if (awareness) awareness.setLocalStateField("file", activeId || null);
  }
  function renderTabs() {
    const bar = el("tabs");
    if (!bar) return;
    bar.textContent = "";
    openTabs.forEach((id) => {
      const n = meta.get(id);
      if (!n) return;
      const tab = document.createElement("div");
      tab.className = "tab" + (id === activeId ? " active" : "");
      tab.dataset.id = id;
      tab.setAttribute("role", "tab");
      tab.tabIndex = 0;
      const name = document.createElement("span");
      name.textContent = n.name;
      const x = document.createElement("button");
      x.className = "tab-x icon-btn";
      x.textContent = "✕";
      x.setAttribute("aria-label", "Close " + n.name);
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id); });
      tab.appendChild(name);
      tab.appendChild(x);
      tab.addEventListener("click", () => openFile(id));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFile(id); }
      });
      bar.appendChild(tab);
    });
    refreshViewingAvatars();
  }
  function mountEditor(id) {
    const host = el("editor-host");
    if (!host) return;
    if (editor) { editor.destroy(); editor = null; }
    revokeBinURL();
    host.textContent = "";
    const n = meta.get(id);
    if (isBinNode(n)) { mountBinaryViewer(host, id, n); return; }
    const ytext = contents.get(id);
    if (!ytext) return;
    editor = window.CMEditor.create({
      parent: host,
      ytext,
      awareness,
      path: n ? n.name : "",
      theme: window.CMEditor.effectiveTheme(),
      readOnly,
    });
  }
  // Re-theme the live editor when the (OS or explicit) color scheme changes.
  // scriptorium has no in-app toggle, so prefers-color-scheme is the primary
  // signal; the data-theme observer covers an explicit override / a future
  // toggle. Wired once from wireControls; reads the current `editor` each time.
  function applyEditorTheme() {
    if (editor && editor.setTheme && window.CMEditor) editor.setTheme(window.CMEditor.effectiveTheme());
    // Mermaid bakes theme colors into its SVG, so re-enrich the preview to
    // re-render diagrams for the new theme (KaTeX/hljs re-theme via CSS).
    previewEnrich();
  }
  let themeSyncWired = false;
  function wireThemeSync() {
    if (themeSyncWired) return;
    themeSyncWired = true;
    try {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyEditorTheme);
    } catch (_) { /* older browsers */ }
    new MutationObserver(applyEditorTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  function revokeBinURL() { if (binURL) { URL.revokeObjectURL(binURL); binURL = null; } }
  // Render a binary file in the editor pane: native <img>/<iframe>/<audio>/<video>
  // for previewable types, else a filename/size card. Always offers a download.
  function mountBinaryViewer(host, id, n) {
    const bytes = blobs.get(id) || new Uint8Array(0);
    const mime = n.mime || mimeFromName(n.name);
    binURL = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const wrap = document.createElement("div");
    wrap.className = "bin-view";
    let media = null;
    if (mime.startsWith("image/")) {
      media = document.createElement("img");
      media.className = "bin-media"; media.alt = n.name; media.src = binURL;
    } else if (mime === "application/pdf") {
      media = document.createElement("iframe");
      media.className = "bin-media bin-frame"; media.src = binURL; media.title = n.name;
    } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      media = document.createElement(mime.startsWith("audio/") ? "audio" : "video");
      media.className = "bin-media"; media.controls = true; media.src = binURL;
    }
    if (media) wrap.appendChild(media);
    const card = document.createElement("div");
    card.className = "bin-card gl-hint";
    const kb = (bytes.length / 1024).toFixed(bytes.length < 102400 ? 1 : 0);
    const label = document.createElement("div");
    label.textContent = iconFor(n.name) + " " + n.name + " · " + mime + " · " + kb + " KB";
    const dl = document.createElement("button");
    dl.className = "gl-btn ghost"; dl.textContent = "⇩ Download this file";
    dl.addEventListener("click", () => {
      const u = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const a = document.createElement("a"); a.href = u; a.download = n.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    });
    card.appendChild(label); card.appendChild(dl);
    wrap.appendChild(card);
    host.appendChild(wrap);
  }
  // Minimal extension→mime fallback when the upload gave no type.
  function mimeFromName(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    const M = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
      pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
      m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
      zip: "application/zip",
    };
    return M[ext] || "application/octet-stream";
  }
  function updateEmptyHint() {
    const hint = el("empty-hint");
    if (hint) hint.hidden = !!activeId;
  }

  // ---- preview -----------------------------------------------------------
  function isMarkdown(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return ext === "md" || ext === "markdown";
  }
  // Which file types render a live preview. Markdown today; extend here (e.g.
  // html) and the toggle/plumbing below applies automatically.
  function previewable(name) { return isMarkdown(name); }

  function syncPreview() {
    const pane = el("preview-pane");
    if (!pane) return;
    if (previewObserver && previewText) {
      previewText.unobserve(previewObserver);
      previewObserver = null;
      previewText = null;
    }
    if (enrichTimer) { clearTimeout(enrichTimer); enrichTimer = null; }
    const n = activeId ? meta.get(activeId) : null;
    const show = previewEnabled && n && previewable(n.name);
    updatePreviewToggle(n);
    if (!show) { pane.hidden = true; return; }
    pane.hidden = false;
    const t = contents.get(activeId);
    if (!t) return;
    // Render synchronously (cheap, no flicker), then enrich Mermaid/KaTeX in a
    // debounced pass so fast typing doesn't thrash the heavy renderers.
    const draw = () => {
      el("preview").innerHTML = window.MD.render(t.toString());
      if (enrichTimer) clearTimeout(enrichTimer);
      enrichTimer = setTimeout(previewEnrich, 200);
    };
    previewText = t;
    previewObserver = draw;
    t.observe(draw);
    draw();
  }
  function previewEnrich() {
    if (!window.MD || !window.MD.enrich) return;
    const theme = window.CMEditor && window.CMEditor.effectiveTheme ? window.CMEditor.effectiveTheme() : undefined;
    window.MD.enrich(el("preview"), { theme });
  }
  // Reflect the toggle's on/off state; disable it when the active file has no
  // preview, so it's clear the control only applies to previewable files.
  function updatePreviewToggle(node) {
    const btn = el("btn-preview");
    if (!btn) return;
    const applicable = !!(node && previewable(node.name));
    btn.setAttribute("aria-pressed", previewEnabled ? "true" : "false");
    btn.classList.toggle("on", previewEnabled);
    btn.disabled = !applicable;
    btn.title = applicable
      ? (previewEnabled ? "Hide preview" : "Show preview")
      : "Preview (available for markdown files)";
  }
  function setPreviewEnabled(on) {
    previewEnabled = !!on;
    try { localStorage.setItem("scriptorium-preview", previewEnabled ? "1" : "0"); } catch (_) { /* private mode */ }
    syncPreview();
  }
  function togglePreview() { setPreviewEnabled(!previewEnabled); }

  // ---- presence ----------------------------------------------------------
  function renderPresence() {
    const box = el("presence");
    if (!box || !awareness) return;
    box.textContent = "";
    const states = awareness.getStates();
    states.forEach((st) => {
      const u = (st && st.user) || {};
      const ai = st && st.ai;
      const hud = st && st.huddle && st.huddle.on;
      const chip = document.createElement("span");
      chip.className = "who" + (ai ? " ai-active" : "");
      chip.style.background = u.color || "#6e7681";
      const who = u.name || "someone";
      const isObserver = observerIds.has(Number(u.pid));
      const viewing = st && st.file ? " · " + idToPath(st.file) : "";
      chip.title = ai
        ? who + (ai.file ? " · assistant editing " + ai.file : " · assistant working")
        : (hud ? who + " · in the huddle" + (st.huddle.muted ? " (muted)" : "") : who + (isObserver ? " · view-only" : "") + viewing);
      if (isObserver) chip.classList.add("observer");
      chip.textContent = (u.name || "?").slice(0, 1).toUpperCase();
      if (ai) {
        // subtle indicator so collaborators see an assistant is touching files
        const spark = document.createElement("span");
        spark.className = "ai-spark";
        spark.textContent = "✦";
        chip.appendChild(spark);
      }
      if (hud) {
        // 🎙 badge so collaborators see who's in the voice huddle
        const mic = document.createElement("span");
        mic.className = "huddle-mic";
        mic.textContent = st.huddle.muted ? "🔇" : "🎙";
        chip.appendChild(mic);
      }
      if (isObserver) {
        // 👁 badge so collaborators see who is watching read-only
        const eye = document.createElement("span");
        eye.className = "observer-eye";
        eye.textContent = "👁";
        chip.appendChild(eye);
      }
      box.appendChild(chip);
    });
    notifyHuddle();
  }

  // ---- huddle (voice-chat membership over awareness) ---------------------
  // Membership is published as an awareness field so huddle.js knows exactly
  // who has JOINED voice (a peer only meshes with those who opted in — a
  // collaborator merely editing is never pulled into audio).
  function setHuddle(info) {
    if (awareness) awareness.setLocalStateField("huddle", info || null);
    renderPresence();
  }
  function huddleMembers() {
    const out = [];
    if (!awareness) return out;
    awareness.getStates().forEach((st) => {
      if (st && st.huddle && st.huddle.on && st.user) {
        out.push({ pid: st.user.pid, name: st.user.name || ("#" + st.user.pid), muted: !!st.huddle.muted });
      }
    });
    return out;
  }
  function registerHuddleObserver(fn) { huddleObserver = fn; if (fn) fn(huddleMembers()); }
  function notifyHuddle() { if (huddleObserver) huddleObserver(huddleMembers()); }

  function setStatus(msg) {
    const s = el("home-status");
    if (s && msg) s.textContent = msg;
  }

  // ---- UI wiring for tree + preview buttons ------------------------------
  function wireControls() {
    wireThemeSync();
    const nf = el("btn-new-file");
    const nd = el("btn-new-dir");
    if (nf) nf.addEventListener("click", () => {
      const name = window.prompt("New file name", "untitled.md");
      if (name && name.trim()) openFile(createFile(name.trim(), ""));
    });
    if (nd) nd.addEventListener("click", () => {
      const name = window.prompt("New folder name", "folder");
      if (name && name.trim()) createDir(name.trim(), "");
    });
    // Upload: button opens the hidden file input; dropping files onto the tree or
    // editor imports them too. importFiles decides text-vs-binary per file.
    const up = el("btn-upload"), fi = el("file-input");
    if (up && fi) {
      up.addEventListener("click", () => fi.click());
      fi.addEventListener("change", async () => { await importFiles(fi.files, ""); fi.value = ""; });
    }
    for (const zoneId of ["tree-pane", "editor-host"]) {
      const zone = el(zoneId) || document.querySelector("." + zoneId);
      if (!zone) continue;
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-hot"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drop-hot"));
      zone.addEventListener("drop", async (e) => {
        e.preventDefault(); zone.classList.remove("drop-hot");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) await importFiles(e.dataTransfer.files, "");
      });
    }
    // Preview on/off (persisted preference). The topbar button toggles it; the
    // ✕ in the preview header disables it.
    try { if (localStorage.getItem("scriptorium-preview") === "0") previewEnabled = false; } catch (_) { /* private mode */ }
    const pv = el("btn-preview");
    if (pv) pv.addEventListener("click", togglePreview);
    const pvc = el("btn-preview-close");
    if (pvc) pvc.addEventListener("click", () => setPreviewEnabled(false));
    updatePreviewToggle(null);
    // Offline copy on/off (persisted preference; default on). Off deletes the
    // local store — see setOffline. Disable the control where IndexedDB / the
    // provider isn't available so it never lies about persisting.
    try { if (localStorage.getItem("scriptorium-offline") === "0") offlineEnabled = false; } catch (_) { /* private mode */ }
    const off = el("btn-offline");
    if (off) {
      if (!window.YIndexeddb || !window.indexedDB) { off.disabled = true; off.title = "Offline copy unavailable in this browser"; }
      else off.addEventListener("click", toggleOffline);
    }
    updateOfflineToggle();
    // Editable workspace name (shared). Debounced so we don't broadcast every
    // keystroke; the settings map is last-writer-wins on a short string.
    const nameEl = el("ws-name");
    if (nameEl) {
      let t = null;
      nameEl.addEventListener("input", () => {
        if (t) clearTimeout(t);
        const v = nameEl.value;
        t = setTimeout(() => setWorkspaceName(v), 250);
      });
    }
  }

  // ---- AI assistant file API ---------------------------------------------
  // A path-based facade over the private Yjs model, for the assistant
  // (assistant.js). The assistant speaks human paths ("src/main.go"), never Yjs
  // ids. Every mutation runs inside `doc.transact(fn, "ai")` so it (a) broadcasts
  // like a human edit — origin "ai" is not "remote" — and (b) is captured by the
  // "ai"-scoped UndoManager for per-turn undo. Edits to an open file reflect in
  // CodeMirror + the preview automatically via yCollab.
  const AI_ORIGIN = "ai";
  const splitPath = (p) => String(p || "").split("/").filter(Boolean);
  const leafName = (p) => splitPath(p).pop() || "";
  const previewStr = (s) => (s.length > 60 ? s.slice(0, 57) + "…" : s);

  function pathToId(path) {
    let parent = "";
    let id = null;
    for (const seg of splitPath(path)) {
      const match = childrenOf(parent).find((cid) => meta.get(cid).name === seg);
      if (match === undefined) return null;
      id = match;
      parent = match;
    }
    return id;
  }
  function idToPath(id) {
    const parts = [];
    let cur = id;
    while (cur) {
      const n = meta.get(cur);
      if (!n) break;
      parts.unshift(n.name);
      cur = n.parent;
    }
    return parts.join("/");
  }
  // Ensure the directory chain for a leaf path exists; return the parent id.
  function ensureParent(path) {
    const parts = splitPath(path);
    parts.pop(); // drop the leaf
    let parent = "";
    for (const seg of parts) {
      let childId = childrenOf(parent).find((cid) => {
        const n = meta.get(cid);
        return n.kind === "dir" && n.name === seg;
      });
      if (childId === undefined) childId = createDir(seg, parent);
      parent = childId;
    }
    return parent;
  }
  function requireFile(path) {
    const id = pathToId(path);
    if (!id) throw new Error("no such file: " + path);
    if (meta.get(id).kind !== "file") throw new Error("not a file: " + path);
    return id;
  }
  // Text-only guard: refuse binary files so the AI can't read/edit bytes as text.
  function requireTextFile(path) {
    const id = requireFile(path);
    if (isBinNode(meta.get(id))) throw new Error("binary file (cannot read/edit as text): " + path);
    return id;
  }

  function fsList() {
    const out = [];
    meta.forEach((n, id) => {
      const e = { path: idToPath(id), kind: n.kind };
      if (n.bin) { e.bin = true; e.mime = n.mime || mimeFromName(n.name); }
      out.push(e);
    });
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }
  function fsRead(path) {
    const t = contents.get(requireTextFile(path));
    return t ? t.toString() : "";
  }
  function fsEdit(path, edits) {
    const t = contents.get(requireTextFile(path));
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("no edits provided");
    let count = 0;
    doc.transact(() => {
      for (const e of edits) {
        const oldStr = e.old_string;
        const newStr = e.new_string != null ? e.new_string : "";
        if (!oldStr) throw new Error("edit missing old_string");
        const s = t.toString();
        const idxs = [];
        for (let at = s.indexOf(oldStr); at !== -1; at = s.indexOf(oldStr, at + oldStr.length)) idxs.push(at);
        if (idxs.length === 0) throw new Error("old_string not found in " + path + ": " + previewStr(oldStr));
        if (idxs.length > 1 && !e.replace_all) {
          throw new Error("old_string is not unique in " + path + " (" + idxs.length + " matches) — add surrounding context or set replace_all");
        }
        const targets = e.replace_all ? idxs : [idxs[0]];
        for (let i = targets.length - 1; i >= 0; i--) { // last→first keeps offsets valid
          t.delete(targets[i], oldStr.length);
          if (newStr) t.insert(targets[i], newStr);
          count++;
        }
      }
    }, AI_ORIGIN);
    return "edited " + path + " (" + count + " change" + (count === 1 ? "" : "s") + ")";
  }
  function fsWrite(path, content) {
    content = content != null ? content : "";
    doc.transact(() => {
      let id = pathToId(path);
      if (!id) id = createFile(leafName(path), ensureParent(path));
      else if (meta.get(id).kind !== "file") throw new Error("not a file: " + path);
      else if (isBinNode(meta.get(id))) throw new Error("binary file (cannot overwrite as text): " + path);
      const t = contents.get(id);
      if (t.length) t.delete(0, t.length);
      if (content) t.insert(0, content);
    }, AI_ORIGIN);
    return "wrote " + path + " (" + content.length + " chars)";
  }
  function fsCreate(path, content) {
    if (pathToId(path)) throw new Error("already exists: " + path);
    content = content != null ? content : "";
    doc.transact(() => {
      const id = createFile(leafName(path), ensureParent(path));
      if (content) contents.get(id).insert(0, content);
    }, AI_ORIGIN);
    return "created " + path;
  }
  function fsRename(path, newPath) {
    const id = pathToId(path);
    if (!id) throw new Error("no such path: " + path);
    if (pathToId(newPath)) throw new Error("target exists: " + newPath);
    doc.transact(() => {
      const parent = ensureParent(newPath);
      meta.set(id, Object.assign({}, meta.get(id), { name: leafName(newPath), parent }));
    }, AI_ORIGIN);
    return "renamed " + path + " → " + newPath;
  }
  function fsDelete(path) {
    const id = pathToId(path);
    if (!id) throw new Error("no such path: " + path);
    doc.transact(() => deleteNode(id), AI_ORIGIN);
    return "deleted " + path;
  }
  function fsFocus(path) {
    const id = requireFile(path);
    openFile(id);
    return "focused " + path;
  }
  // Grep across text files (skip dirs + binaries). Case-insensitive substring by
  // default, or a RegExp when opts.regex. Capped + trimmed to bound token cost.
  function fsSearch(query, opts) {
    if (!query) return { matches: [], truncated: false };
    const MAX = 100, SNIP = 200;
    let re = null;
    if (opts && opts.regex) { try { re = new RegExp(query, "i"); } catch (_) { re = null; } }
    const needle = String(query).toLowerCase();
    const matches = [];
    let truncated = false;
    meta.forEach((n, id) => {
      if (truncated || n.kind !== "file" || isBinNode(n)) return;
      const t = contents.get(id);
      if (!t) return;
      const path = idToPath(id);
      const lines = t.toString().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
        if (!hit) continue;
        if (matches.length >= MAX) { truncated = true; break; }
        const s = lines[i];
        matches.push({ path, line: i + 1, text: s.length > SNIP ? s.slice(0, SNIP) + "…" : s });
      }
    });
    return { matches, truncated };
  }
  // Batch create/overwrite text files in ONE transaction — a single undo unit.
  function fsWriteMany(files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("no files provided");
    const names = [];
    doc.transact(() => {
      for (const f of files) {
        const path = f && f.path;
        if (!path) throw new Error("each file needs a path");
        const content = f.content != null ? f.content : "";
        let id = pathToId(path);
        if (!id) id = createFile(leafName(path), ensureParent(path));
        else if (meta.get(id).kind !== "file") throw new Error("not a file: " + path);
        else if (isBinNode(meta.get(id))) throw new Error("binary file (cannot overwrite as text): " + path);
        const t = contents.get(id);
        if (t.length) t.delete(0, t.length);
        if (content) t.insert(0, content);
        names.push(path);
      }
    }, AI_ORIGIN);
    return "wrote " + names.length + " file" + (names.length === 1 ? "" : "s") + ": " + names.join(", ");
  }
  // Create an (empty) directory chain; error if a segment exists as a file.
  function fsMkdir(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error("empty path");
    doc.transact(() => {
      let parent = "";
      for (const seg of parts) {
        const existing = childrenOf(parent).find((cid) => meta.get(cid).name === seg);
        if (existing !== undefined) {
          if (meta.get(existing).kind !== "dir") throw new Error("a file already exists at: " + seg);
          parent = existing;
        } else {
          parent = createDir(seg, parent);
        }
      }
    }, AI_ORIGIN);
    return "created folder " + parts.join("/");
  }

  // ---- binary files ------------------------------------------------------
  const MAX_BLOB = 5 * 1024 * 1024;         // 5 MiB per file
  const MAX_TOTAL = 24 * 1024 * 1024;       // keep whole-state well under the 32 MiB catch-up ceiling
  const TEXT_EXTS = ["txt", "md", "markdown", "js", "mjs", "cjs", "jsx", "ts", "tsx",
    "json", "yaml", "yml", "toml", "html", "htm", "css", "go", "py", "rs", "sh",
    "bash", "zsh", "c", "h", "cpp", "hpp", "java", "rb", "php", "sql", "xml", "csv",
    "ini", "cfg", "conf", "env", "gitignore", "lock", "log"];

  // Store raw bytes as a binary file (create or replace). Enforces the per-file
  // cap and the whole-workspace budget so late-join catch-up stays under 32 MiB.
  function putBinary(path, bytes, mime) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (bytes.length > MAX_BLOB) {
      throw new Error("file too large (" + (bytes.length / 1048576).toFixed(1) + " MiB); max is 5 MiB");
    }
    const existing = pathToId(path);
    const prev = existing ? (blobs.get(existing) ? blobs.get(existing).length : 0) : 0;
    const total = Y.encodeStateAsUpdate(doc).length - prev + bytes.length;
    if (total > MAX_TOTAL) {
      throw new Error("workspace is near its size limit — remove some files first");
    }
    doc.transact(() => {
      let id = existing;
      if (!id) {
        id = uuid();
        meta.set(id, { name: leafName(path), parent: ensureParent(path), kind: "file", order: meta.size, bin: true, mime: mime || mimeFromName(path) });
      } else {
        contents.delete(id); // in case it was a text file being replaced
        meta.set(id, Object.assign({}, meta.get(id), { bin: true, mime: mime || mimeFromName(path) }));
      }
      blobs.set(id, bytes);
    });
    return { path, bytes: bytes.length };
  }
  // Raw bytes for any file: binary blobs as-is, text files UTF-8 encoded.
  function readBytes(path) {
    const id = requireFile(path);
    const n = meta.get(id);
    if (isBinNode(n)) return blobs.get(id) || new Uint8Array(0);
    const t = contents.get(id);
    return new TextEncoder().encode(t ? t.toString() : "");
  }
  const looksTextual = (name, mime) => {
    if (mime && mime.startsWith("text/")) return true;
    const ext = (name.split(".").pop() || "").toLowerCase();
    return TEXT_EXTS.includes(ext);
  };
  // Upload handler: import File objects — valid-UTF-8 text becomes an editable
  // Y.Text file; everything else becomes a view-only binary blob.
  async function importFiles(fileList, parent) {
    if (readOnly) return; // covers the upload button AND drag-drop
    const files = Array.from(fileList || []);
    let lastId = null, errs = [];
    for (const f of files) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const path = (parent ? parent + "/" : "") + f.name;
        if (looksTextual(f.name, f.type) && buf.length <= MAX_BLOB) {
          let text = null;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (_) { text = null; }
          if (text != null) {
            doc.transact(() => {
              let id = pathToId(path);
              if (!id) id = createFile(leafName(path), ensureParent(path));
              const t = contents.get(id);
              if (t && t.length) t.delete(0, t.length);
              if (text) contents.get(id).insert(0, text);
              lastId = id;
            });
            continue;
          }
        }
        putBinary(path, buf, f.type);
        lastId = pathToId(path);
      } catch (e) {
        errs.push(f.name + ": " + (e && e.message ? e.message : e));
      }
    }
    if (lastId) openFile(lastId);
    return { errors: errs };
  }

  // Replace the ENTIRE workspace with an imported set of files (e.g. a GitHub
  // repo). files: [{ path, bytes:Uint8Array, mime? }]. Valid-UTF-8 files become
  // editable text; the rest become view-only binaries. One atomic transaction =
  // one undo unit + one broadcast to peers. Enforces the per-file + whole-
  // workspace size budget; returns { written, skipped:[{path,reason}] }.
  function importReplace(files) {
    const skipped = [];
    const prepared = [];
    let total = 0;
    for (const f of (files || [])) {
      const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes || 0);
      if (bytes.length > MAX_BLOB) { skipped.push({ path: f.path, reason: "over 5 MiB" }); continue; }
      if (total + bytes.length > MAX_TOTAL) { skipped.push({ path: f.path, reason: "workspace size budget" }); continue; }
      total += bytes.length;
      let text = null;
      if (looksTextual(f.path, f.mime)) {
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (_) { text = null; }
      }
      prepared.push(text != null ? { path: f.path, text } : { path: f.path, bytes, mime: f.mime });
    }
    doc.transact(() => {
      meta.clear(); contents.clear(); blobs.clear();
      for (const p of prepared) {
        if (p.text != null) {
          const id = createFile(leafName(p.path), ensureParent(p.path));
          if (p.text) contents.get(id).insert(0, p.text);
        } else {
          const id = uuid();
          meta.set(id, { name: leafName(p.path), parent: ensureParent(p.path), kind: "file", order: meta.size, bin: true, mime: p.mime || mimeFromName(p.path) });
          blobs.set(id, p.bytes);
        }
      }
    }, AI_ORIGIN);
    openTabs = [];
    activeId = null;
    const ids = [...meta.keys()].filter((id) => meta.get(id).kind === "file");
    const first = ids.find((id) => /(^|\/)readme\.md$/i.test(idToPath(id))) || ids[0];
    if (first) openFile(first); else { renderTree(); renderTabs(); updateEmptyHint(); }
    return { written: prepared.length, skipped };
  }

  function aiCheckpoint() { if (aiUndo) aiUndo.stopCapturing(); }
  function aiUndoTurn() {
    if (!aiUndo) return false;
    const item = aiUndo.undo();
    return item != null;
  }
  // Publish/clear the assistant-activity awareness field (drives the peer ✦).
  function setAIActivity(info) {
    if (awareness) awareness.setLocalStateField("ai", info || null);
    renderPresence();
  }

  window.Workspace = {
    reset, setSend, setSelf, setHost, seedIfEmpty, wireControls,
    applyUpdate, applyAwareness, onCatchupRequest, onCatchupEnd,
    renderPresence, removePeer,
    // shared workspace name (topbar field, download.js)
    setName: setWorkspaceName, getName: getWorkspaceName,
    // cloud sync: host restores an encrypted snapshot on open (cloud.js)
    cloudRestore,
    // offline persistence: per-session store key + load barrier (app.js)
    setSession, whenReady,
    // view-only / observer mode (app.js: setReadOnly on join, setObservers on roster)
    setReadOnly, isReadOnly, setObservers,
    // huddle voice-chat membership (huddle.js)
    setHuddle, registerHuddleObserver,
    // binary files: upload/store/read raw bytes (used by uploads, download.js, assistant.js)
    putBinary, readBytes, importFiles, importReplace,
    // AI assistant surface (assistant.js)
    ai: {
      list: fsList, read: fsRead, edit: fsEdit, write: fsWrite,
      create: fsCreate, rename: fsRename, remove: fsDelete, focus: fsFocus,
      search: fsSearch, writeMany: fsWriteMany, mkdir: fsMkdir,
      checkpoint: aiCheckpoint, undo: aiUndoTurn, activity: setAIActivity,
    },
  };
})();
