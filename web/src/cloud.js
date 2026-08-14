// cloud.js (window.Cloud) — optional E2EE-at-rest persistence.
//
// The host serializes the whole Y.Doc, encrypts it with a phrase-derived key
// (window.CloudCrypto, key from the WASM core), and PUTs the ciphertext to a
// short-TTL presigned URL from our /cloud/presign endpoint. On open the host
// GETs + decrypts + seeds the doc before serving catch-up. The server only
// signs URLs — it never sees plaintext or the key. Everything here is pure
// browser fetch; the WASM core / relay are not involved. Dormant when the
// server has no object-store configured (presign route 404s → enabled=false).
(function () {
  "use strict";

  const DEBOUNCE_MS = 2000;

  let sid = "";
  let cloudKey = "";
  let enabled = null; // null=unknown, true/false after first presign attempt
  let saveTimer = null;
  let saving = false;
  let pending = false;
  let provider = null; // () => Uint8Array full-state snapshot

  function el(id) { return document.getElementById(id); }
  function setStatus(text) {
    const s = el("cloud-status");
    if (!s) return;
    if (!text) { s.hidden = true; s.textContent = ""; return; }
    s.hidden = false;
    s.textContent = text;
  }

  function configure(newSid, newKey) {
    sid = newSid || "";
    cloudKey = newKey || "";
    enabled = null;
  }
  function isConfigured() { return !!(sid && cloudKey && window.CloudCrypto); }

  // presign asks our origin to sign a PUT/GET URL for this session's object.
  // A 404 means the route isn't mounted (no object store configured) → dormant.
  async function presign(op) {
    const res = await fetch("/cloud/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: sid, op: op }),
    });
    if (res.status === 404) { enabled = false; setStatus(""); return null; }
    if (!res.ok) throw new Error("presign " + op + " → " + res.status);
    enabled = true;
    const j = await res.json();
    return j.url;
  }

  // scheduleSave debounces a full-state upload. provider() is called at flush
  // time so we always encrypt the latest state. Host-gating is the caller's job.
  function scheduleSave(p) {
    if (!isConfigured() || enabled === false) return;
    provider = p;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, DEBOUNCE_MS);
  }

  async function flush() {
    if (!provider || !isConfigured() || enabled === false) return;
    if (saving) { pending = true; return; } // coalesce; run once current upload finishes
    saving = true;
    try {
      setStatus("☁ saving…");
      const bytes = provider();
      const url = await presign("put");
      if (!url) return; // dormant
      const sealed = window.CloudCrypto.seal(cloudKey, bytes);
      const put = await fetch(url, { method: "PUT", body: sealed });
      if (!put.ok) throw new Error("upload " + put.status);
      setStatus("☁ synced");
    } catch (e) {
      setStatus("☁ save failed");
      // eslint-disable-next-line no-console
      console.warn("[cloud] save failed:", e && e.message ? e.message : e);
    } finally {
      saving = false;
      if (pending) { pending = false; flush(); }
    }
  }

  // restore returns the decrypted snapshot bytes (Uint8Array) or null when there
  // is no stored object / cloud is dormant / anything fails (open falls back to
  // a fresh workspace — persistence is best-effort, never a hard dependency).
  async function restore() {
    if (!isConfigured()) return null;
    try {
      const url = await presign("get");
      if (!url) return null;
      const res = await fetch(url);
      if (res.status === 404 || res.status === 403) return null; // no object yet
      if (!res.ok) throw new Error("download " + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) return null;
      const plain = window.CloudCrypto.open(cloudKey, buf);
      setStatus("☁ restored");
      return plain;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[cloud] restore failed:", e && e.message ? e.message : e);
      setStatus("");
      return null;
    }
  }

  window.Cloud = {
    configure: configure,
    isConfigured: isConfigured,
    scheduleSave: scheduleSave,
    flush: flush,
    restore: restore,
  };
})();
