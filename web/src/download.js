// download.js — export the workspace as a .zip (window.Download).
//
// Purely client-side: it reads the files out of the Yjs doc via
// window.Workspace.ai.list()/read() (all content is text), builds a standard
// ZIP in the browser — DEFLATE via the native CompressionStream, a small
// CRC32, store fallback — and triggers a Blob download. Nothing leaves the
// browser, so this stays true to scriptorium's E2EE model, with no dependency
// and no server involvement.
(() => {
  "use strict";

  // ---- CRC32 (table-based) ----------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- deflate (native, with store fallback) -----------------------------
  async function deflate(bytes) {
    if (typeof CompressionStream === "undefined") return null; // -> store
    try {
      const cs = new CompressionStream("deflate-raw");
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_) { return null; }
  }

  // ---- little-endian writers --------------------------------------------
  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

  // Drop ASCII control characters (0x00–0x1f and 0x7f) from a path segment —
  // names are untrusted peer input. Code-point filter (no control-char literals).
  function stripCtrl(s) {
    let out = "";
    for (const ch of s) { const c = ch.codePointAt(0); if (c > 31 && c !== 127) out += ch; }
    return out;
  }
  // Clean a workspace path into a portable, safe zip entry name: forward
  // slashes, no leading slash, drop "." / ".." segments. "" if nothing remains.
  function safeName(path) {
    return String(path || "")
      .split("/")
      .map((s) => stripCtrl(s).trim())
      .filter((s) => s && s !== "." && s !== "..")
      .join("/");
  }

  // ---- build the zip -----------------------------------------------------
  // entries: [{ name, bytes }] — name may end in "/" for a directory entry.
  async function buildZip(entries) {
    const enc = new TextEncoder();
    const chunks = [];          // Uint8Array parts of the whole file
    const central = [];         // central-directory records
    let offset = 0;             // running offset of the next local header
    const push = (arr) => {
      const u = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
      chunks.push(u); offset += u.length;
    };

    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const raw = e.bytes || new Uint8Array(0);
      const crc = crc32(raw);
      let method = 0, data = raw;
      if (raw.length > 0) {
        const def = await deflate(raw);
        if (def && def.length < raw.length) { method = 8; data = def; }
      }
      const localOffset = offset;
      const flags = 0x0800; // bit 11: filename is UTF-8
      // local file header
      push([...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method),
        ...u16(0), ...u16(0), // mod time/date (0)
        ...u32(crc), ...u32(data.length), ...u32(raw.length),
        ...u16(nameBytes.length), ...u16(0)]);
      push(nameBytes);
      push(data);
      // central directory record (emitted after all local records)
      central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(raw.length),
        ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(localOffset), ...nameBytes]);
    }

    const cdStart = offset;
    for (const rec of central) push(rec);
    const cdSize = offset - cdStart;
    // end of central directory
    push([...u32(0x06054b50), ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(cdSize), ...u32(cdStart), ...u16(0)]);

    return new Blob(chunks, { type: "application/zip" });
  }

  // Collect the workspace into zip entries (files + explicit dir entries so
  // empty folders survive).
  function collect() {
    const enc = new TextEncoder();
    const W = window.Workspace;
    if (!W || !W.ai) return [];
    const entries = [];
    for (const node of W.ai.list()) {
      const name = safeName(node.path);
      if (!name) continue;
      if (node.kind === "dir") {
        entries.push({ name: name + "/", bytes: new Uint8Array(0) });
      } else {
        let text = "";
        try { text = W.ai.read(node.path); } catch (_) { text = ""; }
        entries.push({ name, bytes: enc.encode(text) });
      }
    }
    return entries;
  }

  function archiveName() {
    let phrase = "";
    try { phrase = safeName(decodeURIComponent((location.hash || "").replace(/^#/, ""))); } catch (_) { phrase = ""; }
    return "scriptorium-" + (phrase || "workspace") + ".zip";
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveZip() {
    const entries = collect();
    const fileCount = entries.filter((e) => !e.name.endsWith("/")).length;
    if (!fileCount) return { fileCount: 0 };
    const blob = await buildZip(entries);
    const name = archiveName();
    triggerDownload(blob, name);
    return { fileCount, bytes: blob.size, name };
  }

  // buildZip/collect exposed for tests (build in-page without a save dialog).
  window.Download = { saveZip, __buildZip: buildZip, __collect: collect, __name: archiveName };
})();
