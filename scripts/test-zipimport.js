#!/usr/bin/env node
// Round-trip and corner-case tests for web/src/zipimport.js, using
// web/src/download.js as the writer. Zero dependencies: Node >= 20 provides
// Blob/Response/CompressionStream/DecompressionStream. Both files are IIFEs
// exporting onto `window`, so alias it to `global` before loading them.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");

global.window = global;
require(path.join(__dirname, "../web/src/download.js"));
require(path.join(__dirname, "../web/src/zipimport.js"));

const enc = (s) => new TextEncoder().encode(s);
const rand = (n) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};
async function zipBytes(entries) {
  const blob = await window.Download.__buildZip(entries);
  return new Uint8Array(await blob.arrayBuffer());
}
function findSig(bytes, sig, fromEnd) {
  const start = fromEnd ? bytes.length - 4 : 0;
  const step = fromEnd ? -1 : 1;
  for (let i = start; i >= 0 && i <= bytes.length - 4; i += step) {
    if (bytes[i] === sig[0] && bytes[i + 1] === sig[1] && bytes[i + 2] === sig[2] && bytes[i + 3] === sig[3]) return i;
  }
  throw new Error("signature not found");
}
const eocdAt = (b) => findSig(b, [0x50, 0x4b, 0x05, 0x06], true);
const centralAt = (b) => findSig(b, [0x50, 0x4b, 0x01, 0x02], false);

async function main() {
  const Z = window.ZipImport;

  // round trip: compressible text (deflate), random binary (store), empty dir
  const text = "lorem ipsum dolor sit amet ".repeat(400);
  const bin = rand(1024);
  {
    const b = await zipBytes([
      { name: "a.md", bytes: enc(text) },
      { name: "bin/x.png", bytes: bin },
      { name: "empty/", bytes: new Uint8Array(0) },
    ]);
    const { entries, skipped } = await Z.parseZip(b);
    assert.equal(skipped.length, 0);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    assert.equal(new TextDecoder().decode(byPath["a.md"].bytes), text);
    assert.deepEqual([...byPath["bin/x.png"].bytes], [...bin]);
    assert.equal(byPath["empty"].dir, true);
  }

  // corrupt payload byte -> CRC mismatch -> skipped
  {
    const b = await zipBytes([{ name: "r.bin", bytes: rand(256) }]);
    b[30 + "r.bin".length + 40] ^= 0xff;
    const { entries, skipped } = await Z.parseZip(b);
    assert.equal(entries.length, 0);
    assert.deepEqual(skipped, [{ path: "r.bin", reason: "corrupt entry" }]);
  }

  // ZIP64 markers in the EOCD -> hard error
  {
    const b = await zipBytes([{ name: "a.txt", bytes: enc("hi") }]);
    const i = eocdAt(b);
    b[i + 10] = 0xff; b[i + 11] = 0xff;
    await assert.rejects(() => Z.parseZip(b), /ZIP64/);
  }

  // encrypted flag (bit 0 in the central record) -> skipped
  {
    const b = await zipBytes([{ name: "s.txt", bytes: enc("secret") }]);
    b[centralAt(b) + 8] |= 1;
    const { entries, skipped } = await Z.parseZip(b);
    assert.equal(entries.length, 0);
    assert.deepEqual(skipped, [{ path: "s.txt", reason: "encrypted" }]);
  }

  // traversal names sanitized, mac junk dropped
  {
    const b = await zipBytes([
      { name: "../../evil.txt", bytes: enc("x") },
      { name: "/abs.txt", bytes: enc("y") },
      { name: "__MACOSX/a.md", bytes: enc("z") },
      { name: "d/.DS_Store", bytes: enc("z") },
    ]);
    const { entries, skipped } = await Z.parseZip(b);
    assert.equal(skipped.length, 0);
    assert.deepEqual(entries.map((e) => e.path).sort(), ["abs.txt", "evil.txt"]);
  }

  // stripCommonRoot: GitHub-style wrapper stripped, mixed roots and bare files kept
  {
    const stripped = Z.__stripCommonRoot([
      { path: "repo-main", dir: true },
      { path: "repo-main/a.md" },
      { path: "repo-main/src/b.js" },
    ]);
    assert.deepEqual(stripped.map((e) => e.path).sort(), ["a.md", "src/b.js"]);
    const mixed = [{ path: "a/x.md" }, { path: "b/y.md" }];
    assert.equal(Z.__stripCommonRoot(mixed), mixed);
    const bare = [{ path: "a.md" }];
    assert.equal(Z.__stripCommonRoot(bare), bare);
  }

  // isZip: needs BOTH a zip name/MIME and the PK magic
  {
    const b = await zipBytes([{ name: "a.txt", bytes: enc("hi") }]);
    assert.equal(Z.isZip("a.zip", "", b), true);
    assert.equal(Z.isZip("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", b), false);
    assert.equal(Z.isZip("a.zip", "", enc("not a zip")), false);
    assert.equal(Z.isZip("renamed.bin", "application/zip", b), true);
  }

  console.log("zipimport tests OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
