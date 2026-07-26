import { ALPHABET } from '../shared/code.js';
import { sanitizeText } from '../shared/text.js';

// Who this device is, without an account.
//
// Three separate things, deliberately:
//
//   * a name, so a human can tell two phones apart;
//   * a session id, assigned by the signalling server, thrown away on
//     disconnect;
//   * a key pair, generated once and kept in IndexedDB, which is the only
//     durable identity — and the only one that means anything, because a name
//     can be typed by anybody.
//
// The key pair is what makes "you have sent to this device before" a statement
// rather than a guess: a peer proves possession by signing a fresh challenge
// (see §7.2 — a device identifier you cannot verify is decoration).

const NAME_KEY = 'roombeam.name';
const KNOWN_KEY = 'roombeam.known';
const DB_NAME = 'roombeam';
const DB_STORE = 'identity';

const ADJECTIVES = [
  'Quiet', 'Brass', 'Amber', 'Swift', 'Copper', 'Violet', 'Iron', 'Clever',
  'Tidal', 'Dusty', 'Golden', 'Hollow', 'Northern', 'Patient', 'Silver',
  'Wandering', 'Bright', 'Cedar', 'Frosted', 'Restless',
];
const NOUNS = [
  'Otter', 'Kettle', 'Falcon', 'Lantern', 'Harbour', 'Cedar', 'Comet', 'Meadow',
  'Anchor', 'Sparrow', 'Beacon', 'Compass', 'Ferry', 'Juniper', 'Kestrel',
  'Orchard', 'Pebble', 'Thistle', 'Willow', 'Foxglove',
];

const pick = (list) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];

// ── base64url ────────────────────────────────────────────────────────────────
// Plain base64 would be fine over JSON, but the room URL and the QR both prefer
// an alphabet with no '+', '/' or '=' to escape.

const toB64Url = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64Url = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

// ── IndexedDB, minimal ───────────────────────────────────────────────────────
// A CryptoKey survives structured clone with its non-extractable flag intact,
// which is why the private key is stored here rather than exported to
// localStorage. It cannot be read back out, even by this page.

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) {
        request.result.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbOp(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const request = fn(tx.objectStore(DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };

// Domain separation. Without it, a signature produced for one purpose could be
// replayed as though it answered a different one.
const CHALLENGE_PREFIX = 'roombeam/peer-auth/v1';

class Identity {
  name;
  /** @type {string|null} base64url SPKI — what peers see */
  publicKey = null;
  /** @type {CryptoKey|null} */
  #privateKey = null;
  /** Short, human-comparable form of the public key. */
  fingerprint = '';
  /** True when the key pair could not be created or stored (private browsing). */
  ephemeral = false;

  constructor() {
    this.name = sanitizeText(localStorage.getItem(NAME_KEY), 40, '') || `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    this.#persistName();
  }

  #persistName() {
    try { localStorage.setItem(NAME_KEY, this.name); } catch { /* private mode */ }
  }

  rename(raw) {
    const next = sanitizeText(raw, 40, '');
    if (!next || next === this.name) return false;
    this.name = next;
    this.#persistName();
    return true;
  }

  /** Load the stored key pair, or make one. Never throws — an identity is a
   *  nicety, and losing it must not stop a transfer. */
  async load() {
    try {
      const db = await openDb();
      let record = await dbOp(db, 'readonly', (store) => store.get('keypair'));

      if (!record?.privateKey || !record?.publicKey) {
        const pair = await crypto.subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);
        const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
        record = { privateKey: pair.privateKey, publicKey: toB64Url(spki), created: Date.now() };
        await dbOp(db, 'readwrite', (store) => store.put(record, 'keypair'));
      }

      this.#privateKey = record.privateKey;
      this.publicKey = record.publicKey;
      this.fingerprint = await fingerprintOf(record.publicKey);
      db.close();
    } catch (err) {
      // Safari in private mode, storage pressure, a blocked upgrade — all end
      // up here. Carry on anonymously.
      console.warn('identity unavailable, running without a stable key', err);
      this.ephemeral = true;
      this.publicKey = null;
    }
    return this;
  }

  /**
   * Answer a peer's challenge.
   *
   * @param {string} theirNonce the challenge they issued
   * @param {string} theirPublicKey who we are answering
   * @param {string} myFingerprint our own DTLS fingerprint — see challengeBytes
   */
  async proveTo(theirNonce, theirPublicKey, myFingerprint) {
    if (!this.#privateKey || !this.publicKey || !myFingerprint) return null;
    const message = challengeBytes(theirNonce, theirPublicKey, this.publicKey, myFingerprint);
    const signature = await crypto.subtle.sign(SIGN_PARAMS, this.#privateKey, message);
    return toB64Url(signature);
  }

  /**
   * Check a peer's answer.
   *
   * @param {string} theirPublicKey base64url SPKI they claim
   * @param {string} ourNonce the challenge we issued
   * @param {string} signature their answer
   * @param {string} theirFingerprint the fingerprint we actually received — not
   *   the one they claim. Checking our own view is the entire point.
   */
  async verifyPeer(theirPublicKey, ourNonce, signature, theirFingerprint) {
    if (!theirPublicKey || !signature || !this.publicKey || !theirFingerprint) return false;
    try {
      const key = await crypto.subtle.importKey(
        'spki', fromB64Url(theirPublicKey), ALGORITHM, false, ['verify']);
      const message = challengeBytes(ourNonce, this.publicKey, theirPublicKey, theirFingerprint);
      return await crypto.subtle.verify(SIGN_PARAMS, key, fromB64Url(signature), message);
    } catch {
      return false; // a malformed key or signature is simply "not verified"
    }
  }
}

/**
 * The bytes both sides agree the signature covers.
 *
 * The fingerprint is the load-bearing part. A signature over the nonce alone
 * proves the peer holds its key, which a relay in the middle can simply pass
 * along unchanged. Binding the signature to the prover's own DTLS fingerprint
 * means the verifier can compare it against the fingerprint it actually received
 * — and a relay, presenting its own encryption, cannot make those agree.
 *
 * Field order is fixed by role rather than by device, so the two ends never
 * build different messages.
 */
function challengeBytes(nonce, verifierKey, proverKey, proverFingerprint) {
  return new TextEncoder().encode(
    `${CHALLENGE_PREFIX}|${nonce}|${verifierKey}|${proverKey}|${proverFingerprint}`);
}

export const freshNonce = () => toB64Url(crypto.getRandomValues(new Uint8Array(16)));

// Fingerprints are only useful if both devices show the *same* representation of
// the same key — otherwise there is nothing to compare, which is the entire
// point. So peers are labelled with this form too, not with a slice of the raw
// key. Hashing is async and rendering is not, hence the cache.
const fingerprints = new Map();

/** The fingerprint if it has been computed, otherwise ''. Never blocks. */
export const knownFingerprint = (publicKey) => fingerprints.get(publicKey) ?? '';

/** Compute any fingerprints not yet cached. Resolves true if anything changed,
 *  so the caller knows whether a repaint is worth it. */
export async function warmFingerprints(publicKeys) {
  let changed = false;
  for (const key of publicKeys) {
    if (!key || fingerprints.has(key)) continue;
    fingerprints.set(key, await fingerprintOf(key));
    changed = true;
  }
  return changed;
}

/** Six characters of the key's hash, in the room-code alphabet so it is
 *  readable aloud. Enough to distinguish the devices in one room. */
export async function fingerprintOf(publicKeyB64) {
  if (!publicKeyB64) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64Url(publicKeyB64)));
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

// ── devices we have met ──────────────────────────────────────────────────────
// Keyed by public key, not by name or session id, because those change. A
// "known" badge is only shown once the peer has answered a challenge.

function readKnown() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

export const knownDevices = {
  has: (publicKey) => Boolean(publicKey) && publicKey in readKnown(),

  get: (publicKey) => readKnown()[publicKey] ?? null,

  remember(publicKey, name) {
    if (!publicKey) return;
    const all = readKnown();
    const existing = all[publicKey];
    all[publicKey] = {
      name: sanitizeText(name, 40, existing?.name ?? 'Unknown'),
      firstSeen: existing?.firstSeen ?? Date.now(),
      lastSeen: Date.now(),
    };

    // Keep the list bounded; drop the least recently seen.
    const entries = Object.entries(all).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, 50);
    try {
      localStorage.setItem(KNOWN_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* nothing to do */ }
  },

  forgetAll() {
    try { localStorage.removeItem(KNOWN_KEY); } catch { /* nothing to do */ }
  },

  count: () => Object.keys(readKnown()).length,
};

export const identity = new Identity();
export { toB64Url, fromB64Url };
