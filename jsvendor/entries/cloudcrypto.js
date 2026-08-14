// cloudcrypto bundle — XChaCha20-Poly1305 for E2EE-at-rest cloud snapshots.
// The key is HKDF-derived from the phrase in the WASM core and handed to JS;
// this only does the AEAD seal/open. Wire format: nonce(24) ‖ ciphertext‖tag.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

window.CloudCrypto = {
  // seal(keyB64, Uint8Array) -> Uint8Array(nonce ‖ ct). Fresh 24-byte random
  // nonce per call (XChaCha's large nonce makes random generation safe).
  seal(keyB64, bytes) {
    const key = b64ToBytes(keyB64);
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const ct = xchacha20poly1305(key, nonce).encrypt(bytes);
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0);
    out.set(ct, nonce.length);
    return out;
  },
  // open(keyB64, Uint8Array) -> plaintext Uint8Array. Throws if auth fails
  // (wrong key/phrase or tampered ciphertext).
  open(keyB64, blob) {
    const key = b64ToBytes(keyB64);
    const nonce = blob.subarray(0, 24);
    const ct = blob.subarray(24);
    return xchacha20poly1305(key, nonce).decrypt(ct);
  },
};
