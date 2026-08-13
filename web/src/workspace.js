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
  let aiUndo = null;       // Y.UndoManager scoped to origin "ai" (assistant edits)
  let previewEnabled = true; // user toggle for the preview pane (persisted)
  let huddleObserver = null; // huddle.js callback: who's in the voice huddle

  // ---- lifecycle ---------------------------------------------------------
  function reset() {
    if (editor) { editor.destroy(); editor = null; }
    doc = new Y.Doc();
    meta = doc.getMap("meta");
    contents = doc.getMap("contents");
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
    const n = activeId ? meta.get(activeId) : null;
    const show = previewEnabled && n && previewable(n.name);
    updatePreviewToggle(n);
    if (!show) { pane.hidden = true; return; }
    pane.hidden = false;
    const t = contents.get(activeId);
    if (!t) return;
    const draw = () => { el("preview").innerHTML = window.MD.render(t.toString()); };
    previewText = t;
    previewObserver = draw;
    t.observe(draw);
    draw();
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
      chip.title = ai
        ? who + (ai.file ? " · assistant editing " + ai.file : " · assistant working")
        : (hud ? who + " · in the huddle" + (st.huddle.muted ? " (muted)" : "") : who);
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
    // Preview on/off (persisted preference). The topbar button toggles it; the
    // ✕ in the preview header disables it.
    try { if (localStorage.getItem("scriptorium-preview") === "0") previewEnabled = false; } catch (_) { /* private mode */ }
    const pv = el("btn-preview");
    if (pv) pv.addEventListener("click", togglePreview);
    const pvc = el("btn-preview-close");
    if (pvc) pvc.addEventListener("click", () => setPreviewEnabled(false));
    updatePreviewToggle(null);
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

  function fsList() {
    const out = [];
    meta.forEach((n, id) => out.push({ path: idToPath(id), kind: n.kind }));
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }
  function fsRead(path) {
    const t = contents.get(requireFile(path));
    return t ? t.toString() : "";
  }
  function fsEdit(path, edits) {
    const t = contents.get(requireFile(path));
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
    // huddle voice-chat membership (huddle.js)
    setHuddle, registerHuddleObserver,
    // AI assistant surface (assistant.js)
    ai: {
      list: fsList, read: fsRead, edit: fsEdit, write: fsWrite,
      create: fsCreate, rename: fsRename, remove: fsDelete, focus: fsFocus,
      checkpoint: aiCheckpoint, undo: aiUndoTurn, activity: setAIActivity,
    },
  };
})();
