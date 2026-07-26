// Small shared helpers. Nothing here knows anything about transfers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. Text is always assigned through textContent, never
 * innerHTML — device names and filenames come from other people's devices and
 * every one of them ends up on screen.
 *
 * @param {string} tag
 * @param {Record<string, string|boolean|number|Function>} [attrs]
 * @param {(Node|string)[]|string} [children]
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'class') node.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const KIB = 1024;
export const MIB = 1024 * 1024;

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < KIB) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = -1;
  do { value /= KIB; i++; } while (value >= KIB && i < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtRate(bytes, ms) {
  if (!(ms > 0) || !(bytes > 0)) return '—';
  const mbps = bytes / MIB / (ms / 1000);
  return mbps < 10 ? `${mbps.toFixed(1)} MB/s` : `${Math.round(mbps)} MB/s`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Remaining time from the rate so far. Deliberately coarse — a per-frame ETA
 *  that jitters between "2m" and "40s" is less informative than no ETA. */
export function fmtEta(done, total, ms) {
  if (!(done > 0) || !(ms > 500) || done >= total) return '';
  const remaining = ((total - done) / done) * ms;
  return remaining > 2000 ? `${fmtDuration(remaining)} left` : 'almost done';
}

export const uuid = () =>
  crypto.randomUUID?.() ??
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Yield to the event loop so the browser can paint. */
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Resolve on the first of several events, or reject on timeout. Used wherever we
 * wait on a WebRTC state change, all of which can also simply never happen.
 */
export function waitFor(target, events, { timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = [];
    const done = (fn) => (value) => { cleanup.forEach((c) => c()); fn(value); };
    const ok = done(resolve);
    const fail = done(reject);

    for (const event of [].concat(events)) {
      const handler = (e) => ok(e);
      target.addEventListener(event, handler);
      cleanup.push(() => target.removeEventListener(event, handler));
    }
    if (timeout > 0) {
      const timer = setTimeout(() => fail(new Error('timeout')), timeout);
      cleanup.push(() => clearTimeout(timer));
    }
    if (signal) {
      if (signal.aborted) return fail(new Error('aborted'));
      const onAbort = () => fail(new Error('aborted'));
      signal.addEventListener('abort', onAbort);
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
    }
  });
}

/** Minimal event emitter. Handlers that throw must not break the emitter. */
export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) { this.#handlers.get(event)?.delete(fn); }

  emit(event, ...args) {
    for (const fn of this.#handlers.get(event) ?? []) {
      try { fn(...args); } catch (err) { console.error(`[${event}]`, err); }
    }
  }
}

/**
 * Collapse a burst of calls into one, at most every `ms`.
 *
 * Deliberately a timer and not `requestAnimationFrame`. A hidden tab gets no
 * frames at all — not delayed, suspended — so a renderer built on rAF stops
 * updating the moment the tab goes to the background and shows stale state when
 * the user comes back. A transfer running behind a locked screen is precisely the
 * case that has to keep its own books straight.
 *
 * 60ms is imperceptible on a progress bar and comfortably faster than the
 * ~200ms at which progress actually arrives.
 */
export function coalesce(fn, ms = 60) {
  let timer = null;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms);
  };
}
