// zipimport.js — read a .zip in the browser (window.ZipImport).
//
// The mirror image of download.js's writer: purely client-side, no dependency,
// no server involvement. Parses the central directory, inflates DEFLATE
// entries via the native DecompressionStream, verifies sizes + CRC32, and
// returns sanitized entries for Workspace.importMerge. Encrypted, ZIP64, and
// exotic-compression archives are rejected or skipped with a reason.
(() => {
  "use strict";

  const MAX_FILE = 5 * 1024 * 1024;  // matches workspace.js MAX_BLOB
  const MAX_FILES = 2000;            // matches publish.js GitHub-import cap

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

  // Drop ASCII control characters (0x00–0x1f and 0x7f) from a path segment —
  // names are untrusted archive input. Code-point filter (no control-char literals).
  function stripCtrl(s) {
    let out = "";
    for (const ch of s) { const c = ch.codePointAt(0); if (c > 31 && c !== 127) out += ch; }
    return out;
  }
  // Clean an archive entry name into a safe workspace path: forward slashes,
  // no leading slash, drop "." / ".." segments. "" if nothing remains.
  function safeName(path) {
    return String(path || "")
      .split(/[/\\]/)
      .map((s) => stripCtrl(s).trim())
      .filter((s) => s && s !== "." && s !== "..")
      .join("/");
  }

  function junk(name) {
    if (name.startsWith("__MACOSX/")) return true;
    const leaf = name.split("/").filter(Boolean).pop() || "";
    return leaf === ".DS_Store" || leaf === "Thumbs.db";
  }

  // ---- inflate (native) ---------------------------------------------------
  async function inflateRaw(slice) {
    if (typeof DecompressionStream === "undefined") return null; // -> skip entry
    const ds = new DecompressionStream("deflate-raw");
    const buf = await new Response(new Blob([slice]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ---- central directory --------------------------------------------------
  // EOCD may be preceded by a comment of up to 65535 bytes, so scan backward.
  function findEOCD(view) {
    const len = view.byteLength;
    const min = Math.max(0, len - 22 - 65535);
    for (let i = len - 22; i >= min; i--) {
      if (view.getUint32(i, true) !== 0x06054b50) continue;
      const count = view.getUint16(i + 10, true);
      const cdSize = view.getUint32(i + 12, true);
      const cdOffset = view.getUint32(i + 16, true);
      if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff ||
        (i >= 20 && view.getUint32(i - 20, true) === 0x07064b50)) {
        throw new Error("ZIP64 archives aren't supported");
      }
      return { count, cdOffset };
    }
    throw new Error("not a zip archive");
  }

  // Sizes/CRC come from the central directory only: archives written with the
  // streaming flag (bit 3) have zeros in the local headers.
  function parseCentral(view, eocd) {
    const dec = new TextDecoder();
    const recs = [];
    let off = eocd.cdOffset;
    for (let n = 0; n < eocd.count; n++) {
      if (off + 46 > view.byteLength || view.getUint32(off, true) !== 0x02014b50) {
        throw new Error("corrupt central directory");
      }
      const nameLen = view.getUint16(off + 28, true);
      recs.push({
        flags: view.getUint16(off + 8, true),
        method: view.getUint16(off + 10, true),
        crc: view.getUint32(off + 16, true),
        compSize: view.getUint32(off + 20, true),
        uncompSize: view.getUint32(off + 24, true),
        localOffset: view.getUint32(off + 42, true),
        name: dec.decode(new Uint8Array(view.buffer, view.byteOffset + off + 46, nameLen)),
      });
      off += 46 + nameLen + view.getUint16(off + 30, true) + view.getUint16(off + 32, true);
    }
    return recs;
  }

  // The local header's own name/extra lengths locate the data (the local extra
  // field can differ from the central one).
  function dataStart(view, localOffset) {
    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("bad local header");
    }
    return localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
  }

  // Strip a single shared top-level folder (GitHub's "Download ZIP" wraps
  // everything in "repo-main/"); scriptorium's own exports have no wrapper.
  function stripCommonRoot(entries) {
    let root = null;
    for (const e of entries) {
      const segs = e.path.split("/");
      if (segs.length < 2 && !e.dir) return entries;
      if (root === null) root = segs[0];
      else if (segs[0] !== root) return entries;
    }
    if (root === null) return entries;
    const out = [];
    for (const e of entries) {
      const path = e.path.split("/").slice(1).join("/");
      if (path) out.push(Object.assign({}, e, { path }));
    }
    return out;
  }

  // Require BOTH a zip name/MIME and the PK magic: magic alone would wrongly
  // explode zip containers (.docx, .jar) users mean to store as blobs.
  function isZip(name, type, bytes) {
    const named = /\.zip$/i.test(name || "") ||
      type === "application/zip" || type === "application/x-zip-compressed";
    if (!named || !bytes || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    return (bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6);
  }

  // One central-directory record -> { entry }, { skip: {path, reason} }, or
  // null for junk. Everything is checked BEFORE inflating (zip-bomb guard).
  async function readEntry(view, bytes, r) {
    if (junk(r.name)) return null;
    const path = safeName(r.name);
    if (!path) return { skip: { path: r.name, reason: "unsafe name" } };
    if (r.name.endsWith("/")) return { entry: { path, dir: true } };
    if (r.flags & 1) return { skip: { path, reason: "encrypted" } };
    if (r.method !== 0 && r.method !== 8) return { skip: { path, reason: "unsupported compression" } };
    if (r.uncompSize > MAX_FILE) return { skip: { path, reason: "over 5 MiB" } };
    const start = dataStart(view, r.localOffset);
    // Slice exactly compSize bytes: DecompressionStream can reject trailing data.
    const slice = bytes.subarray(start, start + r.compSize);
    let out = slice;
    if (r.method === 8) {
      out = await inflateRaw(slice);
      if (out == null) return { skip: { path, reason: "browser can't decompress" } };
    }
    if (out.length !== r.uncompSize || crc32(out) !== r.crc) return { skip: { path, reason: "corrupt entry" } };
    return { entry: { path, bytes: out } };
  }

  async function parseZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [], skipped = [];
    let files = 0;
    for (const r of parseCentral(view, findEOCD(view))) {
      // Cap checked up front so entries past it are never inflated.
      if (files >= MAX_FILES && !r.name.endsWith("/")) {
        skipped.push({ path: safeName(r.name) || r.name, reason: "file cap reached" });
        continue;
      }
      let res;
      try {
        res = await readEntry(view, bytes, r);
      } catch (_) {
        res = { skip: { path: safeName(r.name) || r.name, reason: "unreadable entry" } };
      }
      if (!res) continue;
      if (res.skip) { skipped.push(res.skip); continue; }
      entries.push(res.entry);
      if (!res.entry.dir) files++;
    }
    return { entries: stripCommonRoot(entries), skipped };
  }

  // stripCommonRoot/crc32 exposed for tests (scripts/test-zipimport.js).
  window.ZipImport = { isZip, parseZip, __stripCommonRoot: stripCommonRoot, __crc32: crc32 };
})();
