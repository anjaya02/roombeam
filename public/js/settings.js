import { Emitter } from './util.js';

// Preferences live in localStorage. There is no server-side profile because
// there are no accounts, and there are no accounts because an account implies a
// database of who moves what to whom.

const KEY = 'roombeam.settings';

const DEFAULTS = {
  /** End-to-end checksum. SCTP already guarantees delivery, so this exists to
   *  let the receiver *state* that the file is intact rather than assume it. Both
   *  ends compute it off the main thread, so it costs no throughput. */
  verifyIntegrity: true,

  /** Refuse to send unless the selected ICE candidate pair is local. Off by
   *  default because a transfer that silently declines to happen is worse than
   *  one that happens over a route we label honestly — but for anyone who wants
   *  the promise enforced rather than reported, this enforces it. */
  requireLocalRoute: false,

  /** Ask a STUN server for our public-facing address. Needed only when the two
   *  devices are not actually on the same network. Turning it off restricts
   *  candidates to host addresses, which is the strictest local-only posture
   *  available. */
  useStun: true,

  /** 'auto'     — best tier available; on Chromium this means a save dialog
   *  'no-dialog' — skip the picker so accepting is a single tap */
  savePreference: 'auto',

  /** Diagnostics only: count received bytes and throw them away. This is the
   *  measurement that separates "the disk is the bottleneck" from "the Wi-Fi
   *  link is the bottleneck", and no amount of code reading can substitute. */
  discardReceived: false,

  /** Diagnostics only: 0 means negotiate from the SCTP limit. */
  chunkSizeOverride: 0,

  /** Keep the screen awake during a transfer. Backgrounding a tab suspends it
   *  on iOS, which stalls the transfer until the user returns. */
  keepAwake: true,
};

class Settings extends Emitter {
  #values;

  constructor() {
    super();
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch { /* corrupt or unavailable — defaults are fine */ }

    // Only known keys, only matching types. A stale key from an older build
    // should not be able to reintroduce behaviour that has since been removed.
    this.#values = { ...DEFAULTS };
    for (const [k, v] of Object.entries(stored)) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) this.#values[k] = v;
    }
  }

  get all() { return { ...this.#values }; }
  get(key) { return this.#values[key]; }

  set(key, value) {
    if (!(key in DEFAULTS) || this.#values[key] === value) return;
    this.#values[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#values));
    } catch { /* private mode; the setting still applies for this session */ }
    this.emit('change', key, value);
    this.emit(`change:${key}`, value);
  }

  toggle(key) { this.set(key, !this.#values[key]); }
}

export const settings = new Settings();
export { DEFAULTS };
