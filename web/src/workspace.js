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
  let meta = null;         // Y.Map: fileId → {name, parent, kind, order}
  let contents = null;     // Y.Map: fileId → Y.Text
  let awareness = null;
  let send = () => {};     // bridge send, injected by app.js
  let self = { name: "anon", color: "#a371f7", host: false };
  let openTabs = [];       // [fileId]
  let activeId = null;
  let editor = null;       // { view, setLanguage, destroy } from CMEditor
  let previewObserver = null;
  let previewText = null;

  // ---- lifecycle ---------------------------------------------------------
  function reset() {
    if (editor) { editor.destroy(); editor = null; }
    doc = new Y.Doc();
    meta = doc.getMap("meta");
    contents = doc.getMap("contents");
    awareness = new Awareness(doc);
    openTabs = [];
    activeId = null;
    previewObserver = null;
    previewText = null;

    // Local edits → broadcast; peer-applied (REMOTE) updates are ignored so we
    // don't echo. seq/size safety lives in the Go service, not here.
    doc.on("update", (update, origin) => {
      if (origin === REMOTE) return;
      send({ type: "doc.update", fileID: WS, update: b64encode(update) });
    });
    awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === REMOTE) return;
      const changed = added.concat(updated, removed);
      const payload = encodeAwarenessUpdate(awareness, changed);
      send({ type: "doc.awareness", update: b64encode(payload) });
    });
    meta.observeDeep(() => renderTree());
    renderTree();
    renderTabs();
    updateEmptyHint();
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
  }
  function setHost(isHost) { self.host = !!isHost; }

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
  function applyUpdate(_fileID, b64) {
    try { Y.applyUpdate(doc, b64decode(b64), REMOTE); }
    catch (e) { console.warn("[doc] bad update", e); }
  }
  function applyAwareness(_from, b64) {
    try { applyAwarenessUpdate(awareness, b64decode(b64), REMOTE); }
    catch (e) { console.warn("[doc] bad awareness", e); }
    renderPresence();
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
    }
    meta.delete(id);
    closeTab(id);
  }
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
  }
  function promptRename(id) {
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
      else if (editor) { editor.destroy(); editor = null; el("editor-host").textContent = ""; }
    }
    renderTabs();
    updateEmptyHint();
    syncPreview();
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
  }
  function mountEditor(id) {
    const host = el("editor-host");
    if (!host) return;
    if (editor) { editor.destroy(); editor = null; }
    host.textContent = "";
    const ytext = contents.get(id);
    if (!ytext) return;
    const n = meta.get(id);
    editor = window.CMEditor.create({
      parent: host,
      ytext,
      awareness,
      path: n ? n.name : "",
    });
  }
  function updateEmptyHint() {
    const hint = el("empty-hint");
    if (hint) hint.hidden = !!activeId;
  }

  // ---- markdown preview --------------------------------------------------
  function isMarkdown(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return ext === "md" || ext === "markdown";
  }
  function syncPreview() {
    const pane = el("preview-pane");
    if (!pane) return;
    if (previewObserver && previewText) {
      previewText.unobserve(previewObserver);
      previewObserver = null;
      previewText = null;
    }
    const n = activeId ? meta.get(activeId) : null;
    if (!n || !isMarkdown(n.name)) { pane.hidden = true; return; }
    pane.hidden = false;
    const t = contents.get(activeId);
    if (!t) return;
    const draw = () => { el("preview").innerHTML = window.MD.render(t.toString()); };
    previewText = t;
    previewObserver = draw;
    t.observe(draw);
    draw();
  }

  // ---- presence ----------------------------------------------------------
  function renderPresence() {
    const box = el("presence");
    if (!box || !awareness) return;
    box.textContent = "";
    const states = awareness.getStates();
    states.forEach((st) => {
      const u = (st && st.user) || {};
      const chip = document.createElement("span");
      chip.className = "who";
      chip.style.background = u.color || "#6e7681";
      chip.title = u.name || "someone";
      chip.textContent = (u.name || "?").slice(0, 1).toUpperCase();
      box.appendChild(chip);
    });
  }

  function setStatus(msg) {
    const s = el("home-status");
    if (s && msg) s.textContent = msg;
  }

  // ---- UI wiring for tree buttons ----------------------------------------
  function wireControls() {
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
  }

  window.Workspace = {
    reset, setSend, setSelf, setHost, seedIfEmpty, wireControls,
    applyUpdate, applyAwareness, onCatchupRequest, onCatchupEnd,
    renderPresence, removePeer,
  };
})();
