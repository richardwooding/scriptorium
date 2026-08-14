// assistant.js — the browser-side AI assistant (window.Assistant).
//
// The user brings their own credentials (Anthropic Console API key, or any
// OpenAI-compatible endpoint). The assistant talks to that provider DIRECTLY
// from the browser — the scriptorium relay is never in the loop, so it stays
// blind. Its file edits go through window.Workspace.ai.*, which applies them to
// the shared Yjs doc: collaborators see them live, and each turn is one undo
// checkpoint. The Go core is untouched.
//
// Trust boundary: file content the user shares with the assistant LEAVES the
// end-to-end-encrypted session and goes to their chosen provider. That is the
// user's explicit choice (they added a key). See docs/AI-ASSISTANT.md.
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const MAX_ITERS = 25;        // hard cap on tool round-trips per turn
  const MAX_TOKENS = 8192;     // Anthropic requires an explicit output cap

  // ---- config (localStorage, storage-safe) -------------------------------
  const KEYS = {
    provider: "scriptorium-ai-provider",
    key: "scriptorium-ai-key",
    base: "scriptorium-ai-base",
    model: "scriptorium-ai-model",
  };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } };

  const DEFAULT_MODEL = { anthropic: "claude-sonnet-5", openai: "gpt-4o" };
  function config() {
    const provider = lsGet(KEYS.provider) || "anthropic";
    return {
      provider,
      key: lsGet(KEYS.key) || "",
      base: lsGet(KEYS.base) || "https://api.openai.com/v1",
      model: lsGet(KEYS.model) || DEFAULT_MODEL[provider] || "",
    };
  }
  const isConfigured = () => !!config().key;

  // ---- state -------------------------------------------------------------
  let W = null;                // window.Workspace
  let self = {};               // { name, pid }
  let history = [];            // provider-neutral message log (see below)
  let running = false;
  let stopped = false;

  // Neutral message shapes in `history`:
  //   { role:"user", text }
  //   { role:"assistant", text, toolCalls:[{id,name,input}] }
  //   { role:"tool", results:[{id,name,output,isError}] }

  // ---- tool catalogue (one schema, mapped per provider) ------------------
  const TOOLS = [
    { name: "list_files", description: "List every file and folder in the workspace (paths + kind).",
      schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "read_file", description: "Read a file's full current text.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "edit_file", description: "Apply one or more exact find/replace edits to a file. Prefer this over write_file. old_string must match the current text exactly and be unique unless replace_all is set.",
      schema: { type: "object", properties: {
        path: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: {
          old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" },
        }, required: ["old_string", "new_string"] } },
      }, required: ["path", "edits"] } },
    { name: "write_file", description: "Create or overwrite a file with full content. Use edit_file for small changes.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "create_file", description: "Create a new file (errors if it already exists). Intermediate folders are created.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } },
    { name: "rename_file", description: "Rename or move a file/folder to a new path.",
      schema: { type: "object", properties: { path: { type: "string" }, new_path: { type: "string" } }, required: ["path", "new_path"] } },
    { name: "delete_file", description: "Delete a file or folder (recursive).",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "open_file", description: "Open a file in the editor so the user can watch changes.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "view_image", description: "Look at an image file — attaches it so you can actually see it. Only works for image files (png/jpg/gif/webp/svg/…), not other binaries or text.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ];

  const b64FromBytes = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };

  // Execute one tool call against the Workspace. Returns { output, isError, image? }.
  function execTool(tc, actions) {
    const a = W.ai;
    const p = tc.input || {};
    try {
      switch (tc.name) {
        case "list_files": return { output: JSON.stringify(a.list()) };
        case "read_file": return { output: a.read(p.path) };
        case "view_image": {
          const node = a.list().find((f) => f.path === p.path);
          if (!node) return { output: "no such file: " + p.path, isError: true };
          if (!node.bin || !(node.mime || "").startsWith("image/")) {
            return { output: "not an image: " + p.path + (node.bin ? " (" + node.mime + ")" : " (text file)"), isError: true };
          }
          const bytes = W.readBytes(p.path);
          if (bytes.length > 5 * 1024 * 1024) return { output: "image too large to view: " + p.path, isError: true };
          a.focus(p.path);
          return { output: "Viewing " + p.path + " (" + node.mime + ")", image: { mime: node.mime, b64: b64FromBytes(bytes) } };
        }
        case "edit_file": {
          a.activity({ file: p.path });
          const r = a.edit(p.path, p.edits); a.focus(p.path); actions.push(r); logAction(r); return { output: r };
        }
        case "write_file": {
          a.activity({ file: p.path });
          const r = a.write(p.path, p.content); a.focus(p.path); actions.push(r); logAction(r); return { output: r };
        }
        case "create_file": {
          a.activity({ file: p.path });
          const r = a.create(p.path, p.content); a.focus(p.path); actions.push(r); logAction(r); return { output: r };
        }
        case "rename_file": {
          a.activity({ file: p.new_path });
          const r = a.rename(p.path, p.new_path); actions.push(r); logAction(r); return { output: r };
        }
        case "delete_file": {
          a.activity({ file: p.path });
          const r = a.remove(p.path); actions.push(r); logAction(r); return { output: r };
        }
        case "open_file": return { output: a.focus(p.path) };
        default: return { output: "unknown tool: " + tc.name, isError: true };
      }
    } catch (e) {
      return { output: "Error: " + (e && e.message ? e.message : String(e)), isError: true };
    }
  }

  // ---- provider abstraction ----------------------------------------------
  const safeJSON = (s) => { try { return JSON.parse(s); } catch (_) { return {}; } };

  function toAnthropic(hist) {
    return hist.map((m) => {
      if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.text }] };
      if (m.role === "assistant") {
        const content = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const tc of m.toolCalls || []) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        return { role: "assistant", content };
      }
      return { role: "user", content: (m.results || []).map((r) => {
        // Anthropic tool_result can carry an image block alongside text.
        if (r.image) {
          return { type: "tool_result", tool_use_id: r.id, content: [
            { type: "text", text: r.output || "" },
            { type: "image", source: { type: "base64", media_type: r.image.mime, data: r.image.b64 } },
          ] };
        }
        return { type: "tool_result", tool_use_id: r.id, content: r.output, is_error: r.isError || undefined };
      }) };
    });
  }
  function toOpenAI(hist, system) {
    const out = [{ role: "system", content: system }];
    for (const m of hist) {
      if (m.role === "user") out.push({ role: "user", content: m.text });
      else if (m.role === "assistant") {
        const msg = { role: "assistant", content: m.text || "" };
        if ((m.toolCalls || []).length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
        out.push(msg);
      } else {
        for (const r of m.results || []) {
          out.push({ role: "tool", tool_call_id: r.id, content: r.output });
          // OpenAI tool messages are text-only; attach any image as a following user turn.
          if (r.image) {
            out.push({ role: "user", content: [
              { type: "text", text: "(image from view_image)" },
              { type: "image_url", image_url: { url: "data:" + r.image.mime + ";base64," + r.image.b64 } },
            ] });
          }
        }
      }
    }
    return out;
  }

  const providers = {
    anthropic: {
      url: () => "https://api.anthropic.com/v1/messages",
      headers: (c) => ({
        "content-type": "application/json",
        "x-api-key": c.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      }),
      body: (c, system, hist) => ({
        model: c.model, max_tokens: MAX_TOKENS, system, stream: true,
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        messages: toAnthropic(hist),
      }),
      // SSE accumulator: text streams live; tool_use inputs arrive as
      // input_json_delta fragments assembled per content-block index.
      newAcc: () => ({ text: "", blocks: {} }),
      onEvent: (e, acc, onText) => {
        if (e.type === "error") throw new Error("provider error: " + ((e.error && e.error.message) || "unknown"));
        if (e.type === "content_block_start") {
          const cb = e.content_block || {};
          acc.blocks[e.index] = cb.type === "tool_use"
            ? { type: "tool_use", id: cb.id, name: cb.name, json: "" }
            : { type: "text" };
        } else if (e.type === "content_block_delta") {
          const d = e.delta || {};
          if (d.type === "text_delta") { acc.text += d.text; onText(d.text); }
          else if (d.type === "input_json_delta") { const b = acc.blocks[e.index]; if (b) b.json += d.partial_json; }
        }
      },
      finish: (acc) => {
        const toolCalls = [];
        for (const k of Object.keys(acc.blocks)) {
          const b = acc.blocks[k];
          if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: safeJSON(b.json || "{}") });
        }
        return { text: acc.text, toolCalls };
      },
    },
    openai: {
      url: (c) => c.base.replace(/\/+$/, "") + "/chat/completions",
      headers: (c) => ({ "content-type": "application/json", authorization: "Bearer " + c.key }),
      body: (c, system, hist) => ({
        model: c.model, stream: true,
        tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
        messages: toOpenAI(hist, system),
      }),
      // SSE accumulator: content streams live; tool_calls arrive as deltas keyed
      // by index, with arguments streamed in fragments.
      newAcc: () => ({ text: "", tools: {} }),
      onEvent: (e, acc, onText) => {
        const ch = e.choices && e.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (d.content) { acc.text += d.content; onText(d.content); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index != null ? tc.index : 0;
          const cur = acc.tools[i] || (acc.tools[i] = { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function) {
            if (tc.function.name) cur.name = tc.function.name;
            if (tc.function.arguments) cur.args += tc.function.arguments;
          }
        }
      },
      finish: (acc) => {
        const toolCalls = Object.keys(acc.tools).sort((a, b) => a - b).map((k) => {
          const t = acc.tools[k];
          return { id: t.id, name: t.name, input: safeJSON(t.args || "{}") };
        });
        return { text: acc.text, toolCalls };
      },
    },
  };

  // Read a Server-Sent-Events stream, handing each `data:` JSON payload to
  // onEvent. Both providers embed a discriminating field in the payload, so we
  // ignore `event:` lines and parse only `data:`. Cancels early if stopped.
  async function readSSE(bodyStream, onEvent) {
    const reader = bodyStream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      if (stopped) { try { await reader.cancel(); } catch (_) { /* ignore */ } return; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        let evt; try { evt = JSON.parse(payload); } catch (_) { continue; }
        onEvent(evt);
      }
    }
  }

  function buildSystem() {
    const tree = W.ai.list().map((f) => (f.kind === "dir" ? "📁 " : (f.bin ? "🖼 " : "   ")) + f.path + (f.bin ? "  [binary: " + f.mime + "]" : "")).join("\n");
    return [
      "You are an AI assistant embedded in scriptorium, a live collaborative editor.",
      "You read and edit files in the shared workspace with the provided tools.",
      "Edits apply IMMEDIATELY and are seen live by every collaborator — be precise.",
      "Read a file before editing it. Prefer minimal edit_file (exact find/replace)",
      "over write_file. Use human paths like \"src/main.go\". Keep replies concise.",
      "Files marked [binary] cannot be read or edited as text; for images use",
      "view_image to actually see them. You can still rename/delete/open binaries.",
      "",
      "Workspace files:",
      tree || "(empty workspace)",
    ].join("\n");
  }

  async function callProvider(cfg, system, onText) {
    const p = providers[cfg.provider];
    if (!p) throw new Error("unknown provider: " + cfg.provider);
    let res;
    try {
      res = await fetch(p.url(cfg), {
        method: "POST", headers: p.headers(cfg), body: JSON.stringify(p.body(cfg, system, history)),
      });
    } catch (e) {
      throw new Error("network error reaching the AI provider (a local endpoint may need CORS enabled): " + e.message);
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j.error || j); } catch (_) { /* non-JSON */ }
      if (res.status === 401) throw new Error("401 unauthorized — check your API key in settings");
      if (res.status === 404) throw new Error("404 — check the model id (and base URL) in settings" + (detail ? ": " + detail : ""));
      if (res.status === 429) throw new Error("429 rate limited — check your plan/limits");
      throw new Error(res.status + " " + (detail || res.statusText));
    }
    if (!res.body) throw new Error("no response stream from the provider");
    const acc = p.newAcc();
    await readSSE(res.body, (evt) => p.onEvent(evt, acc, onText));
    return p.finish(acc);
  }

  // ---- agentic loop ------------------------------------------------------
  async function runTurn(userText) {
    if (running) return;
    const cfg = config();
    if (!cfg.key) { openSettings(); return; }
    running = true; stopped = false;
    setBusy(true);
    history.push({ role: "user", text: userText });
    renderMsg("user", userText);
    W.ai.checkpoint();
    const actions = [];
    let iter = 0;
    try {
      while (iter++ < MAX_ITERS) {
        if (stopped) { renderNote("stopped"); break; }
        // Stream this step's text into a live bubble; finalize as markdown.
        let streamEl = null, streamText = "";
        const onText = (delta) => {
          if (!streamEl) streamEl = beginAssistant();
          streamText += delta;
          streamEl.textContent = streamText;
          scrollLog();
        };
        const { text, toolCalls } = await callProvider(cfg, buildSystem(), onText);
        if (streamEl) finalizeAssistant(streamEl, streamText);
        else if (text) renderMsg("assistant", text); // non-streamed fallback
        if (stopped) { history.push({ role: "assistant", text, toolCalls: [] }); renderNote("stopped"); break; }
        history.push({ role: "assistant", text, toolCalls });
        if (!toolCalls.length) break;
        const results = [];
        for (const tc of toolCalls) {
          const out = execTool(tc, actions);
          results.push({ id: tc.id, name: tc.name, output: out.output, isError: out.isError, image: out.image });
        }
        history.push({ role: "tool", results });
      }
      if (iter > MAX_ITERS) renderNote("reached the step limit for this turn");
    } catch (err) {
      renderError(err && err.message ? err.message : String(err));
    } finally {
      W.ai.activity(null);
      if (actions.length) renderUndo(actions.length);
      running = false; setBusy(false);
    }
  }

  // ---- UI ----------------------------------------------------------------
  function scrollLog() { const l = el("ai-log"); if (l) l.scrollTop = l.scrollHeight; }
  function renderMsg(role, text) {
    const log = el("ai-log"); if (!log) return;
    const div = document.createElement("div");
    div.className = "ai-msg ai-" + role;
    if (role === "assistant" && window.MD) div.innerHTML = window.MD.render(text); // MD sanitizes
    else div.textContent = text;
    log.appendChild(div); scrollLog();
  }
  // Live streaming bubble: append empty, fill with plain text as tokens arrive
  // (fast + safe), then re-render as sanitized markdown when the step completes.
  function beginAssistant() {
    const log = el("ai-log"); if (!log) return null;
    const div = document.createElement("div");
    div.className = "ai-msg ai-assistant streaming";
    log.appendChild(div); scrollLog();
    return div;
  }
  function finalizeAssistant(div, text) {
    div.classList.remove("streaming");
    if (window.MD) div.innerHTML = window.MD.render(text);
    else div.textContent = text;
    scrollLog();
  }
  function logAction(summary) {
    const log = el("ai-log"); if (!log) return;
    const div = document.createElement("div");
    div.className = "ai-action";
    div.textContent = "✎ " + summary;
    log.appendChild(div); scrollLog();
  }
  function renderNote(text) {
    const log = el("ai-log"); if (!log) return;
    const div = document.createElement("div");
    div.className = "ai-note"; div.textContent = text;
    log.appendChild(div); scrollLog();
  }
  function renderError(text) {
    const log = el("ai-log"); if (!log) return;
    const div = document.createElement("div");
    div.className = "ai-error"; div.textContent = "⚠ " + text;
    log.appendChild(div); scrollLog();
  }
  function renderUndo(n) {
    const log = el("ai-log"); if (!log) return;
    const btn = document.createElement("button");
    btn.className = "gl-btn ghost ai-undo";
    btn.textContent = "↩ Undo this turn (" + n + " edit" + (n === 1 ? "" : "s") + ")";
    btn.addEventListener("click", () => {
      const ok = W.ai.undo();
      btn.disabled = true;
      btn.textContent = ok ? "↩ Undone" : "↩ Nothing to undo";
    });
    log.appendChild(btn); scrollLog();
  }
  function setBusy(busy) {
    const send = el("ai-send"), stop = el("ai-stop"), input = el("ai-input");
    if (send) send.hidden = busy;
    if (stop) stop.hidden = !busy;
    if (input) input.disabled = busy;
    if (!busy && input) input.focus();
  }

  function onSubmit(e) {
    if (e) e.preventDefault();
    const input = el("ai-input"); if (!input) return;
    const text = (input.value || "").trim();
    if (!text || running) return;
    input.value = "";
    runTurn(text);
  }

  // ---- settings modal ----------------------------------------------------
  function openSettings() {
    const cfg = config();
    if (el("ai-provider")) el("ai-provider").value = cfg.provider;
    if (el("ai-base")) el("ai-base").value = lsGet(KEYS.base) || "";
    if (el("ai-key")) el("ai-key").value = cfg.key;
    if (el("ai-model")) el("ai-model").value = lsGet(KEYS.model) || "";
    syncSettingsProvider();
    if (el("ai-settings")) el("ai-settings").hidden = false;
  }
  function closeSettings() { if (el("ai-settings")) el("ai-settings").hidden = true; }
  function syncSettingsProvider() {
    const prov = el("ai-provider") ? el("ai-provider").value : "anthropic";
    if (el("ai-base-row")) el("ai-base-row").hidden = prov !== "openai";
    if (el("ai-model")) el("ai-model").placeholder = DEFAULT_MODEL[prov] || "model id";
  }
  function saveSettings() {
    const prov = el("ai-provider").value;
    lsSet(KEYS.provider, prov);
    lsSet(KEYS.key, (el("ai-key").value || "").trim());
    lsSet(KEYS.base, (el("ai-base").value || "").trim());
    lsSet(KEYS.model, (el("ai-model").value || "").trim());
    closeSettings();
    renderNote("settings saved — provider: " + prov);
  }
  function forgetKey() {
    lsDel(KEYS.key);
    if (el("ai-key")) el("ai-key").value = "";
    renderNote("API key forgotten (removed from this browser)");
  }

  // ---- pane visibility ---------------------------------------------------
  function isOpen() { const p = el("ai-pane"); return p && !p.hidden; }
  function open() {
    const p = el("ai-pane"); if (p) p.hidden = false;
    const btn = el("btn-ai"); if (btn) btn.setAttribute("aria-expanded", "true");
    if (!isConfigured()) openSettings();
    const input = el("ai-input"); if (input) input.focus();
  }
  function close() {
    const p = el("ai-pane"); if (p) p.hidden = true;
    const btn = el("btn-ai"); if (btn) btn.setAttribute("aria-expanded", "false");
  }
  function toggle() { if (isOpen()) close(); else open(); }

  // ---- init --------------------------------------------------------------
  function init(opts) {
    W = (opts && opts.workspace) || window.Workspace;
    self = (opts && opts.self) || {};
    history = []; running = false; stopped = false;
    const log = el("ai-log"); if (log) log.textContent = "";
    const form = el("ai-form"); if (form && !form._wired) { form.addEventListener("submit", onSubmit); form._wired = true; }
    wireOnce("ai-stop", "click", () => { stopped = true; });
    wireOnce("btn-ai", "click", toggle);
    wireOnce("btn-ai-close", "click", close);
    wireOnce("btn-ai-settings", "click", openSettings);
    wireOnce("ai-provider", "change", syncSettingsProvider);
    wireOnce("btn-ai-save", "click", saveSettings);
    wireOnce("btn-ai-forget", "click", forgetKey);
    wireOnce("btn-ai-close-settings", "click", closeSettings);
    renderNote(isConfigured() ? "Assistant ready. Ask it to read or edit your files." : "Add an API key (⚙ Settings) to start. Your key stays in this browser.");
  }
  function wireOnce(id, ev, fn) {
    const node = el(id);
    if (node && !node["_w_" + ev]) { node.addEventListener(ev, fn); node["_w_" + ev] = true; }
  }

  window.Assistant = { init, open, close, toggle, openSettings, isConfigured };
})();
