import { MIB, deferred, fmtBytes, uuid } from './util.js';
import { crc32 } from './crc32.js';

// Where a received file actually goes.
//
// Sending is uniform everywhere. Receiving is where the platforms diverge, and
// which path a device lands on sets its maximum practical file size — so the tier
// is reported in the UI rather than hidden.
//
//   disk-folder  one directory dialog, every file in the transfer lands in it
//   disk         one save dialog, straight to the chosen location
//   opfs         synchronous writes inside a worker, then a Blob to save
//   opfs-async   the same store without the sync handle; slower, still unbounded
//   download     streamed through the service worker into Downloads
//   memory       the whole file in RAM. Works everywhere, dies on large files
//   discard      counts bytes and drops them — a measurement tool, not a tier
//
// The ordering is deliberate. Anything that streams beats anything that buffers,
// and a dialog the user already expected is not a cost worth avoiding.

const WRITE_HIGH_WATER = 8 * MIB;  // stop feeding storage above this many queued bytes
const WRITE_LOW_WATER = 2 * MIB;   // resume below it

/** Beyond this, the memory tier is a crash rather than a fallback. */
export const MEMORY_TIER_LIMIT = 192 * MIB;

export const TIER_LABELS = {
  'disk-folder': 'disk (folder you chose)',
  disk: 'disk (File System Access)',
  opfs: 'OPFS, synchronous worker writes',
  'opfs-async': 'OPFS, async writes',
  download: 'Downloads folder',
  memory: 'memory — small files only',
  discard: 'discarded (measurement mode)',
};

/**
 * Whether to skip the File System Access pickers in favour of a streamed
 * download. True on phones and tablets, where the picker dialog is confusing and
 * a file written through it lands where the gallery and file manager cannot find
 * it — the browser's own Downloads folder is what a person there expects, and it
 * comes with a download notification for free.
 *
 * userAgentData.mobile is the reliable signal where it exists; the regex is the
 * fallback for Safari and Firefox, which do not implement it.
 */
export function prefersStreamedDownload() {
  if (navigator.userAgentData) return navigator.userAgentData.mobile === true;
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || '');
}

// ── capability probe ─────────────────────────────────────────────────────────

/**
 * Everything that can be answered without awaiting anything.
 *
 * That distinction matters more than it looks. A save dialog is only permitted
 * while the browser still considers a user gesture active, and the accept tap is
 * the only gesture available — so the code path from that tap to
 * `showSaveFilePicker()` must not await first. Keeping the feature tests
 * synchronous is what makes that possible.
 */
export function syncCapabilities() {
  const caps = {
    secureContext: self.isSecureContext === true,
    webrtc: typeof RTCPeerConnection === 'function',
    savePicker: typeof self.showSaveFilePicker === 'function',
    directoryPicker: typeof self.showDirectoryPicker === 'function',
    opfs: typeof navigator.storage?.getDirectory === 'function',
    opfsSync: false,
    serviceWorker: 'serviceWorker' in navigator,
    swController: Boolean(navigator.serviceWorker?.controller),
    wakeLock: 'wakeLock' in navigator,
    barcodeDetector: typeof self.BarcodeDetector === 'function',
    quota: null,
    usage: null,
  };

  // Whether the synchronous access handle exists genuinely cannot be established
  // from here. It is a worker-only API and — measured — the method is not even on
  // the main-thread prototype in browsers that support it, so a feature test
  // reports "no" on a platform where it works perfectly. Hence syncSupport below:
  // ask a worker once, remember the answer, and until it comes back simply try
  // the fast path and fall back.
  caps.opfsSync = caps.opfs && syncSupport !== false;

  return caps;
}

/** null until a worker has been asked; then true or false. */
let syncSupport = null;
let syncProbe = null;

/**
 * Ask a worker whether it can open a synchronous access handle.
 *
 * Worth doing once at startup so the diagnostics panel can state the receive tier
 * accurately rather than guessing at it.
 */
export function probeSyncAccess() {
  if (syncSupport !== null) return Promise.resolve(syncSupport);
  if (syncProbe) return syncProbe;
  if (typeof navigator.storage?.getDirectory !== 'function') {
    syncSupport = false;
    return Promise.resolve(false);
  }

  syncProbe = new Promise((resolve) => {
    let worker;
    const settle = (value) => {
      syncSupport = value;
      try { worker?.terminate(); } catch { /* already gone */ }
      resolve(value);
    };
    try {
      worker = new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => settle(data.t === 'opened');
      worker.onerror = () => settle(false);
      worker.postMessage({ t: 'open', key: 'capability-probe', verify: false, resumeAt: 0, resumeCrc: 0 });
      setTimeout(() => { if (syncSupport === null) settle(false); }, 4000);
    } catch {
      settle(false);
    }
  }).then(async (value) => {
    await removeOpfsEntries(['capability-probe']);
    return value;
  });

  return syncProbe;
}

/** The same, plus the storage quota, which only comes back asynchronously. */
export async function probeCapabilities() {
  const caps = syncCapabilities();
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate) {
      caps.quota = estimate.quota ?? null;
      caps.usage = estimate.usage ?? null;
    }
  } catch { /* Safari sometimes declines; "not reported" is a fine answer */ }
  return caps;
}

/** Free browser storage, or null when the browser will not say. */
export function freeStorage(caps) {
  if (caps.quota === null || caps.usage === null) return null;
  return Math.max(0, caps.quota - caps.usage);
}

// ── shared queue behaviour ───────────────────────────────────────────────────

/**
 * Every asynchronous storage backend needs the same thing: let writes overlap so
 * that disk latency does not become the transfer's speed limit, but cap how many
 * bytes are in flight so a slow disk cannot turn into unbounded memory growth.
 *
 * Awaiting each write in turn — the obvious implementation — makes storage
 * latency and network throughput multiply instead of overlap.
 */
class QueuedSink {
  outstanding = 0;
  bytesWritten = 0;
  error = null;
  #waiters = [];
  #drainWaiters = [];

  /** @param {number} bytes @param {Promise<unknown>} promise */
  track(bytes, promise) {
    this.outstanding += bytes;
    promise.then(
      () => { this.bytesWritten += bytes; this.#settle(bytes); },
      (err) => { this.error ??= err; this.#settle(bytes); },
    );
  }

  #settle(bytes) {
    this.outstanding -= bytes;
    if (this.outstanding <= WRITE_LOW_WATER) {
      for (const resolve of this.#waiters.splice(0)) resolve();
    }
    if (this.outstanding <= 0) {
      for (const resolve of this.#drainWaiters.splice(0)) resolve();
    }
  }

  /** Resolves once storage has caught up enough to accept more. */
  async throttle() {
    if (this.error) throw this.error;
    if (this.outstanding <= WRITE_HIGH_WATER) return;
    const gate = deferred();
    this.#waiters.push(gate.resolve);
    await gate.promise;
    if (this.error) throw this.error;
  }

  /** Resolves once every queued byte has actually been written. Closing a file
   *  before this settles loses whatever was still queued. */
  async drain() {
    while (this.outstanding > 0 && !this.error) {
      const gate = deferred();
      this.#drainWaiters.push(gate.resolve);
      await gate.promise;
    }
    if (this.error) throw this.error;
  }

  /** True while storage is behind — the receiver asks the sender to pause. */
  get congested() { return this.outstanding > WRITE_HIGH_WATER; }
}

// ── the session ──────────────────────────────────────────────────────────────

/**
 * Choose a tier once for a whole transfer, then hand out one writer per file.
 *
 * Choosing per file would be wrong for the picker tiers: a save dialog is only
 * permitted inside a user gesture, and the accept tap is the only gesture we get.
 * One dialog up front for a folder covers every file in the offer.
 *
 * @param {object} opts
 * @param {{id: string, name: string, size: number}[]} opts.files
 * @param {'auto'|'no-dialog'} opts.preference
 * @param {boolean} opts.discard
 * @param {boolean} opts.verify
 */
export async function beginReceiveSession({ files, preference = 'auto', discard = false, verify = true }) {
  if (discard) return new DiscardSession(verify);

  // Synchronous, so the dialog below is still inside the user's tap.
  const caps = syncCapabilities();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const mobile = prefersStreamedDownload();

  // The File System Access pickers are the best experience on a desktop — the
  // user chooses exactly where the file goes — but the wrong one on a phone,
  // where the dialog is confusing and the file lands somewhere the gallery and
  // file manager cannot find. So on mobile we skip the pickers entirely and let
  // the streamed-download tier below put the file in the Downloads folder.
  if (preference === 'auto' && !mobile) {
    if (files.length > 1 && caps.directoryPicker) {
      const dir = await self.showDirectoryPicker({ mode: 'readwrite', id: 'roombeam' });
      return new FileSystemSession(dir, verify);
    }
    if (files.length === 1 && caps.savePicker) {
      const handle = await self.showSaveFilePicker({ suggestedName: files[0].name });
      return new FileSystemSession(null, verify, handle);
    }
    // Several files but only a single-file dialog: fall through to a streaming
    // tier rather than asking for a gesture we no longer have.
  }

  // The remaining tiers all draw on the browser's storage quota, so this is the
  // point to check there is room. Refusing now with a number is better than
  // failing at 90% with a quota error — which is the same outcome plus the wait.
  //
  // On a phone, prefer streaming into Downloads over OPFS: it lands in a place
  // the user can actually find, and the browser raises its own download
  // notification, where OPFS would buffer the whole file against the storage
  // quota and hand back a Save button the user then has to notice and tap.
  const chosen = (mobile && caps.swController)
    ? 'download'
    : caps.opfs
      ? (caps.opfsSync ? 'opfs' : 'opfs-async')
      : caps.swController ? 'download' : 'memory';

  if (chosen === 'memory' && total > MEMORY_TIER_LIMIT) {
    throw new StorageUnavailable(
      `This browser can only receive into memory here, which caps out around ${fmtBytes(MEMORY_TIER_LIMIT)}, `
      + `and this transfer is ${fmtBytes(total)}. Try another browser on this device, or fewer files at once.`);
  }

  if (chosen === 'opfs' || chosen === 'opfs-async') {
    const { quota, usage } = await probeCapabilities();
    const free = quota === null || usage === null ? null : quota - usage;
    // A little headroom: writing right up to the quota tends to fail short of it.
    if (free !== null && total > free * 0.95) {
      throw new StorageUnavailable(
        `Not enough room: this browser has about ${fmtBytes(free)} of storage available and the transfer `
        + `is ${fmtBytes(total)}. Free up space, or have the sender split it up.`);
    }
    return new OpfsSession(verify, chosen === 'opfs');
  }

  if (chosen === 'download') return new DownloadSession(verify);
  return new MemorySession(verify);
}

export class StorageUnavailable extends Error {
  constructor(message) { super(message); this.name = 'StorageUnavailable'; }
}

// ── disk, via File System Access ─────────────────────────────────────────────

class FileSystemSession {
  tier;
  /** @param {FileSystemDirectoryHandle|null} dir */
  constructor(dir, verify, singleHandle = null) {
    this.dir = dir;
    this.verify = verify;
    this.singleHandle = singleHandle;
    this.tier = dir ? 'disk-folder' : 'disk';
  }

  get label() { return TIER_LABELS[this.tier]; }
  get producesBlob() { return false; }

  async writerFor(file, { resumeAt = 0, resumeCrc = 0 } = {}) {
    const handle = this.singleHandle ?? await this.dir.getFileHandle(file.name, { create: true });
    // keepExistingData matters only on resume; without it the browser starts a
    // fresh file and the bytes already on disk are silently discarded.
    const stream = await handle.createWritable({ keepExistingData: resumeAt > 0 });
    const writer = stream.getWriter();
    if (resumeAt > 0) await writer.write({ type: 'seek', position: resumeAt });
    return new StreamWriter(writer, this.tier, this.verify, resumeAt, resumeCrc);
  }

  async finish() { /* each file closes its own stream */ }
  async abort() { /* the partial file stays where the user put it, deliberately */ }
}

class StreamWriter extends QueuedSink {
  crc;
  constructor(writer, tier, verify, resumeAt, resumeCrc) {
    super();
    this.writer = writer;
    this.tier = tier;
    this.verify = verify;
    this.crc = resumeCrc >>> 0;
    this.bytesWritten = resumeAt;
    this.offset = resumeAt;
  }

  async write(chunk) {
    if (this.error) throw this.error;
    const view = new Uint8Array(chunk);
    if (this.verify) this.crc = crc32(view, this.crc);
    this.offset += view.byteLength;
    this.track(view.byteLength, this.writer.write(view));
    await this.throttle();
  }

  async close() {
    await this.writer.close();
    if (this.error) throw this.error;
    return { bytes: this.offset, crc: this.crc, blob: null };
  }

  async abort() {
    await this.writer.abort().catch(() => {});
  }
}

// ── OPFS ─────────────────────────────────────────────────────────────────────

class OpfsSession {
  tier;
  #keys = [];
  constructor(verify, sync) {
    this.verify = verify;
    this.sync = sync;
    this.tier = sync ? 'opfs' : 'opfs-async';
  }

  get label() { return TIER_LABELS[this.tier]; }
  get producesBlob() { return true; }

  async writerFor(_file, { resumeAt = 0, resumeCrc = 0, key } = {}) {
    const fileKey = key ?? `${Date.now().toString(36)}-${uuid().slice(0, 8)}`;
    this.#keys.push(fileKey);

    // Try the worker, fall back to async writes. Attempting it is a more reliable
    // test than any feature detection available here, and the cost of being wrong
    // is one failed open rather than a whole transfer on the slow path.
    if (this.sync) {
      try {
        const writer = await OpfsWorkerWriter.open(fileKey, this.verify, resumeAt, resumeCrc);
        this.tier = 'opfs';
        return writer;
      } catch {
        this.sync = false;
        this.tier = 'opfs-async';
      }
    }
    return OpfsAsyncWriter.open(fileKey, this.verify, resumeAt, resumeCrc);
  }

  async finish() { /* files are removed once handed to the user */ }
  async abort() { await removeOpfsEntries(this.#keys); }
}

/** Talks to opfs-worker.js. The worker holds the sync handle; this side only
 *  counts bytes and applies backpressure. */
class OpfsWorkerWriter extends QueuedSink {
  static async open(key, verify, resumeAt, resumeCrc) {
    const worker = new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' });
    const writer = new OpfsWorkerWriter(worker, key, verify);
    try {
      await writer.#request({ t: 'open', key, verify, resumeAt, resumeCrc }, 'opened', 5000);
    } catch (err) {
      // Leave nothing running behind a failed open; the caller falls back.
      worker.terminate();
      throw err;
    }
    writer.offset = resumeAt;
    writer.crc = resumeCrc >>> 0;
    return writer;
  }

  tier = 'opfs';
  crc = 0;
  offset = 0;
  /** Replies keyed by message type: open, close and abort happen once each. */
  #pending = new Map();
  /** Write acknowledgements, keyed by sequence number. */
  #acks = new Map();
  #seq = 0;

  constructor(worker, key, verify) {
    super();
    this.worker = worker;
    this.key = key;
    this.verify = verify;

    const failAll = (err) => {
      this.error ??= err;
      for (const gate of this.#pending.values()) gate.reject(err);
      for (const gate of this.#acks.values()) gate.reject(err);
      this.#pending.clear();
      this.#acks.clear();
    };

    worker.onmessage = ({ data }) => {
      if (data.t === 'error') return failAll(new Error(data.message));

      if (data.t === 'wrote') {
        this.offset = data.offset;
        const gate = this.#acks.get(data.seq);
        if (gate) { this.#acks.delete(data.seq); gate.resolve(); }
        return;
      }

      if (data.t === 'closed') this.crc = data.crc >>> 0;
      const gate = this.#pending.get(data.t);
      if (gate) { this.#pending.delete(data.t); gate.resolve(data); }
    };

    worker.onerror = (event) => failAll(new Error(event.message || 'the storage worker failed'));
  }

  /**
   * Send a message and wait for its one reply.
   *
   * The timeout is the point. Without it, a worker that fails to start — or a
   * platform where the synchronous handle is unavailable in a way that produces
   * silence rather than an error — leaves this promise pending forever, and the
   * caller's fallback to async writes never runs. A tier that hangs is worse than
   * a tier that is missing.
   */
  #request(msg, expect, timeout = 8000) {
    const gate = deferred();
    this.#pending.set(expect, gate);
    this.worker.postMessage(msg);
    setTimeout(() => {
      if (this.#pending.get(expect) !== gate) return;
      this.#pending.delete(expect);
      gate.reject(new Error(`the storage worker did not answer "${msg.t}"`));
    }, timeout);
    return gate.promise;
  }

  async write(chunk) {
    if (this.error) throw this.error;
    const bytes = chunk.byteLength;
    const seq = ++this.#seq;
    const gate = deferred();
    this.#acks.set(seq, gate);
    // Transferring the buffer hands ownership to the worker with no copy, which
    // is why nothing here may touch `chunk` afterwards.
    this.worker.postMessage({ t: 'write', buf: chunk, seq }, [chunk]);
    this.track(bytes, gate.promise);
    await this.throttle();
  }

  async close() {
    // Every queued write must land before the file is closed, or the tail of the
    // file is lost and only the checksum notices.
    await this.drain();
    const result = await this.#request({ t: 'close' }, 'closed');
    if (this.error) throw this.error;
    const blob = await readOpfsFile(this.key);
    this.worker.terminate();
    return { bytes: result.offset, crc: result.crc >>> 0, blob, opfsKey: this.key };
  }

  async abort() {
    try { await this.#request({ t: 'abort', remove: true }, 'aborted'); } catch { /* going away anyway */ }
    this.worker.terminate();
  }
}

/** OPFS without the sync handle: still off RAM, but every write is a promise. */
class OpfsAsyncWriter extends QueuedSink {
  static async open(key, verify, resumeAt, resumeCrc) {
    const dir = await incomingDir();
    const handle = await dir.getFileHandle(key, { create: true });
    const stream = await handle.createWritable({ keepExistingData: resumeAt > 0 });
    const writer = stream.getWriter();
    if (resumeAt > 0) await writer.write({ type: 'seek', position: resumeAt });
    return new OpfsAsyncWriter(writer, key, verify, resumeAt, resumeCrc);
  }

  tier = 'opfs-async';
  constructor(writer, key, verify, resumeAt, resumeCrc) {
    super();
    this.writer = writer;
    this.key = key;
    this.verify = verify;
    this.crc = resumeCrc >>> 0;
    this.offset = resumeAt;
  }

  async write(chunk) {
    if (this.error) throw this.error;
    const view = new Uint8Array(chunk);
    if (this.verify) this.crc = crc32(view, this.crc);
    this.offset += view.byteLength;
    this.track(view.byteLength, this.writer.write(view));
    await this.throttle();
  }

  async close() {
    await this.writer.close();
    if (this.error) throw this.error;
    return { bytes: this.offset, crc: this.crc, blob: await readOpfsFile(this.key), opfsKey: this.key };
  }

  async abort() {
    await this.writer.abort().catch(() => {});
    await removeOpfsEntries([this.key]);
  }
}

async function incomingDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('incoming', { create: true });
}

async function readOpfsFile(key) {
  const dir = await incomingDir();
  const handle = await dir.getFileHandle(key);
  return handle.getFile();
}

export async function removeOpfsEntries(keys) {
  try {
    const dir = await incomingDir();
    for (const key of keys) await dir.removeEntry(key).catch(() => {});
  } catch { /* nothing to clean */ }
}

/**
 * Clear anything left in OPFS from a previous session. Nothing can be in flight
 * at page load, so whatever is there is debris from a tab that was closed
 * mid-transfer — and left alone it accumulates against the storage quota until
 * receiving stops working for no visible reason.
 */
export async function sweepOpfs() {
  if (!navigator.storage?.getDirectory) return 0;
  try {
    const dir = await incomingDir();
    let removed = 0;
    for await (const name of dir.keys()) {
      await dir.removeEntry(name, { recursive: true }).catch(() => {});
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

// ── streamed through the service worker ──────────────────────────────────────

class DownloadSession {
  tier = 'download';
  constructor(verify) { this.verify = verify; }
  get label() { return TIER_LABELS[this.tier]; }
  get producesBlob() { return false; }

  async writerFor(file) { return DownloadWriter.open(file, this.verify); }
  async finish() {}
  async abort() {}
}

/**
 * Hands the bytes to the service worker, which answers a hidden request with a
 * streaming response. The browser writes it straight into Downloads, so the file
 * is never held in RAM and never counted against the storage quota.
 *
 * The awkward part is unavoidable: a stream has to be pulled by a request, so
 * something has to make that request. A hidden iframe does it without navigating
 * the page away mid-transfer.
 */
class DownloadWriter extends QueuedSink {
  static async open(file, verify) {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new StorageUnavailable('The service worker is not controlling this page yet. Reload and retry.');

    const id = uuid();
    const channel = new MessageChannel();
    const ready = deferred();

    channel.port1.onmessage = ({ data }) => {
      if (data.t === 'ready') ready.resolve();
      else if (data.t === 'error') ready.reject(new Error(data.message));
    };

    controller.postMessage({ t: 'download-open', id, name: file.name, size: file.size }, [channel.port2]);
    await Promise.race([
      ready.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the service worker did not answer')), 4000)),
    ]);

    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = `/-/dl/${id}`;
    document.body.append(frame);

    return new DownloadWriter(channel.port1, frame, verify);
  }

  tier = 'download';
  crc = 0;
  offset = 0;
  #acks = [];

  constructor(port, frame, verify) {
    super();
    this.port = port;
    this.frame = frame;
    this.verify = verify;
    port.onmessage = ({ data }) => {
      if (data.t === 'wrote') this.#acks.shift()?.resolve();
      else if (data.t === 'error') {
        this.error ??= new Error(data.message);
        for (const gate of this.#acks.splice(0)) gate.reject(this.error);
      }
    };
  }

  async write(chunk) {
    if (this.error) throw this.error;
    const view = new Uint8Array(chunk);
    if (this.verify) this.crc = crc32(view, this.crc);
    this.offset += view.byteLength;

    const gate = deferred();
    this.#acks.push(gate);
    this.port.postMessage({ t: 'chunk', buf: chunk }, [chunk]);
    this.track(view.byteLength, gate.promise);
    await this.throttle();
  }

  async close() {
    await this.drain();
    this.port.postMessage({ t: 'end' });
    // The frame is what is pulling the stream, so it has to outlive the last
    // chunk or the download is cut short at the very end.
    setTimeout(() => this.frame.remove(), 2000);
    if (this.error) throw this.error;
    return { bytes: this.offset, crc: this.crc, blob: null };
  }

  async abort() {
    this.port.postMessage({ t: 'abort' });
    this.frame.remove();
  }
}

// ── memory ───────────────────────────────────────────────────────────────────

class MemorySession {
  tier = 'memory';
  constructor(verify) { this.verify = verify; }
  get label() { return TIER_LABELS[this.tier]; }
  get producesBlob() { return true; }
  async writerFor(file) { return new MemoryWriter(file, this.verify); }
  async finish() {}
  async abort() {}
}

class MemoryWriter {
  tier = 'memory';
  crc = 0;
  offset = 0;
  outstanding = 0;
  error = null;
  #parts = [];

  constructor(file, verify) { this.file = file; this.verify = verify; }
  get congested() { return false; }

  async write(chunk) {
    const view = new Uint8Array(chunk);
    if (this.verify) this.crc = crc32(view, this.crc);
    this.#parts.push(view);
    this.offset += view.byteLength;
    if (this.offset > MEMORY_TIER_LIMIT) {
      // Better an explanation than a tab that vanishes at 400 MB.
      this.#parts.length = 0;
      throw new StorageUnavailable(
        `Ran past the ${fmtBytes(MEMORY_TIER_LIMIT)} limit of this browser's in-memory receive path.`);
    }
  }

  async close() {
    const blob = new Blob(this.#parts, { type: this.file.mime || 'application/octet-stream' });
    this.#parts.length = 0;
    return { bytes: this.offset, crc: this.crc, blob };
  }

  async abort() { this.#parts.length = 0; }
}

// ── discard: the measurement tier ────────────────────────────────────────────

/**
 * Counts bytes and drops them.
 *
 * This exists to answer one question that reading the code cannot: when a
 * transfer runs slowly, is storage the limit or is the network? Receive the same
 * file with this on, and if the rate jumps, the disk was the bottleneck. If it
 * does not move, no amount of code will help and the link itself is the ceiling.
 */
class DiscardSession {
  tier = 'discard';
  constructor(verify) { this.verify = verify; }
  get label() { return TIER_LABELS[this.tier]; }
  get producesBlob() { return false; }
  async writerFor() { return new DiscardWriter(this.verify); }
  async finish() {}
  async abort() {}
}

class DiscardWriter {
  tier = 'discard';
  crc = 0;
  offset = 0;
  outstanding = 0;
  error = null;
  constructor(verify) { this.verify = verify; }
  get congested() { return false; }

  async write(chunk) {
    // The checksum stays optional here too — leaving it on measures the cost of
    // hashing, turning it off measures the network alone.
    if (this.verify) this.crc = crc32(chunk, this.crc);
    this.offset += chunk.byteLength;
  }

  async close() { return { bytes: this.offset, crc: this.crc, blob: null }; }
  async abort() {}
}
