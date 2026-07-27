import { Emitter, MIB, deferred, fmtBytes, uuid, waitFor } from './util.js';
import { MSG, negotiateChunkSize } from './protocol.js';
import { settings } from './settings.js';
import { StorageUnavailable, beginReceiveSession } from './writers.js';

// Moving the bytes.
//
// The rules that shape this file, in order of how much trouble they save:
//
//  1. Never hold a whole file in memory. The source is read as a stream and the
//     destination is written as a stream. `file.arrayBuffer()` on a 2 GB file is
//     an instant crash on a phone.
//  2. Never write to a DataChannel without checking how much is already queued.
//     Without that check the queue grows until the tab dies, and the symptom is a
//     large transfer that stops partway with no error at all.
//  3. The receiver's byte count is the true one. The sender only knows what it
//     handed to the network stack.
//  4. A dropped connection is not a lost transfer. Both ends keep their place and
//     the sender asks where to pick up from.

const SEND_HIGH_WATER = 8 * MIB;   // pause the read loop above this many queued bytes
const SEND_LOW_WATER = 1 * MIB;    // resume below it — deep enough that the link never idles
const PROGRESS_INTERVAL = 200;     // ms between progress reports to the sender
const RESUME_KEEP_MS = 10 * 60_000; // how long a stalled transfer stays resumable

// The resume handshake travels over a channel that has just come back from being
// broken, which is precisely when a message is most likely to vanish. So it is
// asked again rather than asked once: wait this long for an answer, then back off
// and ask afresh until the transfer is reaped.
const RESUME_ANSWER_TIMEOUT = 8_000;
const RESUME_RETRY_MIN = 1_000;
const RESUME_RETRY_MAX = 15_000;

// How often a running transfer re-reads which route it is actually taking. Often
// enough that the round-trip figure tracks the link; rare enough that `getStats`
// stays off the hot path.
const PATH_REFRESH_INTERVAL = 2_000;

export const STATUS = {
  connecting: 'connecting',
  waiting: 'waiting',       // offered, awaiting the other side's decision
  declined: 'declined',
  running: 'running',
  paused: 'paused',         // the receiver's storage is behind
  interrupted: 'interrupted',
  verifying: 'verifying',
  done: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
};

const TERMINAL = new Set([STATUS.done, STATUS.failed, STATUS.cancelled, STATUS.declined]);
export const isTerminal = (status) => TERMINAL.has(status);

let seq = 0;

class Transfer {
  key = `t${++seq}`;
  status = STATUS.connecting;
  detail = '';
  tone = '';
  path = null;
  chunkSize = 0;
  startedAt = 0;
  endedAt = 0;
  /** @type {AbortController} */
  abort = new AbortController();

  /** Resume bookkeeping, sender side. `resuming` is true only while one attempt
   *  is actually in flight — it is a guard against two overlapping attempts, and
   *  must never outlive the attempt that set it, or nothing will ever retry. */
  resuming = false;
  resumeAttempts = 0;
  lastPaint = 0;        // throttles progress repaints out of the send loop
  resumeTimer = null;   // waiting for an answer to a query already sent
  retryTimer = null;    // waiting out the backoff before the next attempt
  resumePeerId = null;  // the session id the peer was last seen under

  constructor(direction, transferId, link) {
    this.direction = direction;
    this.id = transferId;
    this.link = link;
    this.peerName = link.name;
    this.peerKey = link.pubkey;
  }

  get files() { return this.items; }
  get totalBytes() { return this.items.reduce((sum, item) => sum + item.size, 0); }
  get movedBytes() { return this.items.reduce((sum, item) => sum + item.progress, 0); }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt || performance.now()) - this.startedAt;
  }

  /**
   * Bytes and time since the transfer last started moving. Reset on resume, so
   * that a transfer stalled for five minutes does not report an average rate
   * that includes the five minutes of nothing.
   */
  rateFrom = { bytes: 0, at: 0 };

  markMoving() {
    this.rateFrom = { bytes: this.movedBytes, at: performance.now() };
    if (!this.startedAt) this.startedAt = this.rateFrom.at;
  }

  get currentRate() {
    if (!this.rateFrom.at) return { bytes: 0, ms: 0 };
    return {
      bytes: this.movedBytes - this.rateFrom.bytes,
      ms: (this.endedAt || performance.now()) - this.rateFrom.at,
    };
  }
}

class SendItem {
  sent = 0;         // handed to the network stack
  confirmed = 0;    // acknowledged by the receiver — the honest number
  status = STATUS.connecting;
  crc = null;
  skipped = false;

  constructor(file) {
    this.id = uuid().slice(0, 12);
    this.file = file;
    this.name = file.name;
    this.size = file.size;
    this.mime = file.type ?? '';
    this.mtime = file.lastModified ?? 0;
  }

  get progress() { return this.confirmed || this.sent; }
}

class ReceiveItem {
  received = 0;
  status = STATUS.waiting;
  /** @type {import('./writers.js').StreamWriter|null} */
  writer = null;
  blob = null;
  crcOk = null;
  opfsKey = null;

  constructor(descriptor) {
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.size = descriptor.size;
    this.mime = descriptor.mime;
    this.mtime = descriptor.mtime;
  }

  get progress() { return this.received; }
}

export class TransferManager extends Emitter {
  /** @type {Map<string, Transfer>} */
  outgoing = new Map();
  /** @type {Map<string, Transfer>} */
  incoming = new Map();

  #network;
  /** Which file each channel is currently streaming, so a binary message needs
   *  no header — the sequence is the framing. */
  #activeByChannel = new Map();
  /** One transfer at a time per peer: concurrent streams to the same device just
   *  contend for the same radio and finish later, both of them. */
  #queues = new Map();
  #wakeLock = null;

  constructor(network) {
    super();
    this.#network = network;

    network.on('link', (link) => this.#watch(link));
    for (const link of network.links.values()) this.#watch(link);

    // A peer that reappears under a new session id is usually the same device
    // coming back from a locked screen. That is the moment to retry.
    network.on('peer-available', (peer) => this.#retryFor(peer));

    setInterval(() => this.#reap(), 60_000);
    setInterval(() => this.#refreshPaths(), PATH_REFRESH_INTERVAL);
  }

  #changed(transfer) { this.emit('change', transfer); }

  #watch(link) {
    link.on('control', (channel, msg) => this.#onControl(link, channel, msg));
    link.on('binary', (channel, data) => this.#onBinary(channel, data));
    link.on('channel-close', (channel) => this.#onChannelClose(channel));
    link.on('trust', () => {
      for (const transfer of [...this.outgoing.values(), ...this.incoming.values()]) {
        if (transfer.link === link) this.#changed(transfer);
      }
    });
  }

  // ── sending ────────────────────────────────────────────────────────────────

  /**
   * @param {import('./peer.js').PeerLink} link
   * @param {File[]} files
   */
  async send(link, files) {
    if (!files.length) return null;

    const transfer = new Transfer('out', uuid(), link);
    transfer.items = files.map((file) => new SendItem(file));
    this.outgoing.set(transfer.id, transfer);
    this.#changed(transfer);

    // Serialise per peer. The promise chain is the queue.
    const previous = this.#queues.get(link.id) ?? Promise.resolve();
    const run = previous.then(() => this.#runSend(transfer)).catch(() => {});
    this.#queues.set(link.id, run);
    await run;
    return transfer;
  }

  async #runSend(transfer) {
    const link = transfer.link;
    try {
      transfer.status = STATUS.connecting;
      transfer.detail = 'opening a direct connection…';
      this.#changed(transfer);

      const channel = await link.ensureChannel({ signal: transfer.abort.signal });
      transfer.channel = channel;
      channel.bufferedAmountLowThreshold = SEND_LOW_WATER;

      transfer.path = await this.#settledPath(link);
      if (settings.get('requireLocalRoute') && transfer.path.kind !== 'local') {
        return this.#fail(transfer,
          `Refusing to send: the connection is a ${transfer.path.label}, and "local network only" is on. `
          + 'Both devices need to be on the same Wi-Fi, without a VPN.');
      }

      transfer.chunkSize = negotiateChunkSize(link.pc, settings.get('chunkSizeOverride'));

      link.send(channel, {
        t: MSG.offerFiles,
        transferId: transfer.id,
        files: transfer.items.map((item) => ({
          id: item.id, name: item.name, size: item.size, mime: item.mime, mtime: item.mtime,
        })),
      });

      transfer.status = STATUS.waiting;
      transfer.detail = `waiting for ${link.name} to accept`;
      this.#changed(transfer);

      const verdict = deferred();
      transfer.verdict = verdict;
      const accepted = await Promise.race([
        verdict.promise,
        waitFor(transfer.abort.signal, 'abort').then(() => null),
      ]);
      transfer.verdict = null;

      if (!accepted) return; // declined or cancelled; state already set

      await this.#pump(transfer, accepted);
    } catch (err) {
      if (transfer.abort.signal.aborted) return;
      await this.#explainSendFailure(transfer, err);
    } finally {
      this.#releaseWakeLock();
    }
  }

  async #pump(transfer, acceptedIds) {
    transfer.status = STATUS.running;
    transfer.markMoving();
    this.#changed(transfer);
    await this.#takeWakeLock();

    for (const item of transfer.items) {
      if (transfer.abort.signal.aborted) break;
      if (!acceptedIds.includes(item.id)) {
        item.status = STATUS.declined;
        item.skipped = true;
        continue;
      }
      await this.#sendOne(transfer, item);
      if (item.status === STATUS.failed || item.status === STATUS.interrupted) return;
    }

    if (transfer.abort.signal.aborted) return;

    // Count against what the receiver actually asked for. Files it declined are
    // not shortfalls, and reporting them as "3 of 5 sent" reads like a failure.
    const wanted = transfer.items.filter((item) => !item.skipped);
    const delivered = wanted.filter((item) => item.status === STATUS.done);
    transfer.endedAt = performance.now();
    transfer.status = delivered.length ? STATUS.done : STATUS.failed;
    transfer.detail = delivered.length === wanted.length
      ? ''
      : `${delivered.length} of ${wanted.length} sent`;
    this.#changed(transfer);
  }

  async #sendOne(transfer, item) {
    const { link } = transfer;
    const channel = transfer.channel;
    if (channel?.readyState !== 'open') {
      item.status = STATUS.interrupted;
      return this.#interrupt(transfer, 'the connection dropped');
    }

    // The checksum runs in its own worker over the same file. On another thread
    // it costs the send loop nothing; on this one it would compete with it.
    const checksum = settings.get('verifyIntegrity') ? startChecksum(item.file) : null;

    item.status = STATUS.running;
    link.send(channel, {
      t: MSG.fileStart,
      transferId: transfer.id,
      fileId: item.id,
      chunkSize: transfer.chunkSize,
      offset: item.sent,
    });

    const source = item.sent > 0 ? item.file.slice(item.sent) : item.file;

    // One listener for the whole file, not one per backpressure wait. Attaching a
    // fresh 'close' listener inside the loop would leave one behind on every
    // iteration that raced it — thousands of them over a large file.
    const closed = waitFor(channel, 'close').catch(() => {});
    let stalled = false;

    const dropped = () => {
      item.status = STATUS.interrupted;
      checksum?.cancel();
      this.#interrupt(transfer, stalled
        ? 'the connection stopped accepting data'
        : 'the connection dropped mid-file');
    };

    try {
      for await (const chunk of chunksOf(source, transfer.chunkSize)) {
        if (transfer.abort.signal.aborted) return;
        if (channel.readyState !== 'open') return dropped();

        // Storage on the far end has fallen behind. Its queue is finite; ours is
        // the network's, and both filling at once is how a transfer dies.
        while (transfer.flowPaused && !transfer.abort.signal.aborted) {
          if (transfer.status !== STATUS.paused) {
            transfer.status = STATUS.paused;
            this.#changed(transfer);
          }
          // The gate is always present while flowPaused is set. Bailing out if it
          // is somehow missing keeps a lost message from becoming a busy loop.
          if (!transfer.flowGate) break;
          await transfer.flowGate.promise;
        }
        if (transfer.status === STATUS.paused) {
          transfer.status = STATUS.running;
          this.#changed(transfer);
        }

        if (channel.bufferedAmount > SEND_HIGH_WATER) {
          const drained = await Promise.race([
            waitFor(channel, 'bufferedamountlow', { timeout: 60_000 }).then(() => true, () => false),
            closed.then(() => false),
          ]);
          // A minute without the buffer draining is not slow, it is gone. Pushing
          // more into it would only grow memory.
          if (!drained && channel.readyState === 'open') stalled = true;
        }
        if (stalled || channel.readyState !== 'open') return dropped();

        channel.send(chunk);
        item.sent += chunk.byteLength;

        // Not on every chunk. `progress` prefers `confirmed` the moment the
        // receiver's first report lands, so past that point a repaint per chunk
        // redraws numbers that cannot have changed — thousands of full re-renders
        // over a large file, on the same thread that is feeding the network.
        const now = performance.now();
        if (now - transfer.lastPaint > PROGRESS_INTERVAL) {
          transfer.lastPaint = now;
          this.#changed(transfer);
        }
      }
    } catch (err) {
      checksum?.cancel();
      item.status = STATUS.failed;
      return this.#fail(transfer, `Could not read ${item.name}: ${err.message}`);
    }

    if (transfer.abort.signal.aborted) return;

    item.crc = await checksum?.result ?? null;
    link.send(channel, {
      t: MSG.fileEnd,
      transferId: transfer.id,
      fileId: item.id,
      bytes: item.size,
      crc: item.crc,
    });
    item.status = STATUS.done;
    this.#changed(transfer);
  }

  /** Wait briefly for ICE to settle so the route label is real rather than
   *  "unknown", which is what an immediate call always returns. */
  #settledPath(link) {
    return link.refreshPath({ retries: 12 });
  }

  /**
   * Keep the route each transfer reports honest.
   *
   * It used to be sampled once, as early as 150ms after the connection formed,
   * and then frozen for the life of the transfer. Two things make that a lie:
   * ICE carries on checking and can move the traffic to a better pair, and the
   * first round-trip figure is measured during the handshake, when it is least
   * representative. The visible symptom is two devices describing the same
   * connection differently — one reading "local network · 118 ms", the other
   * "internet route · 7 ms" — which is exactly when someone is trying to work out
   * why a transfer is slow, and exactly when the number has to be trustworthy.
   */
  async #refreshPaths() {
    const active = [...this.outgoing.values(), ...this.incoming.values()]
      .filter((transfer) => !isTerminal(transfer.status) && transfer.status !== STATUS.waiting);
    if (!active.length) return; // `getStats` is not free; do not poll an idle app

    // One read per connection, however many transfers are riding on it.
    const byLink = new Map();
    for (const transfer of active) {
      if (!byLink.has(transfer.link)) byLink.set(transfer.link, transfer.link.refreshPath());
    }

    for (const transfer of active) {
      const path = await byLink.get(transfer.link).catch(() => null);
      if (!path || path.kind === 'unknown') continue;
      transfer.path = path;
      this.#changed(transfer);
    }
  }

  async #explainSendFailure(transfer, err) {
    if (err?.message === 'connection-failed' || transfer.link.state === 'failed') {
      const { message } = await transfer.link.diagnose();
      return this.#fail(transfer, message);
    }
    if (err?.message === 'timeout') {
      return this.#fail(transfer,
        'The other device did not finish connecting within 20 seconds. Both pages need to be '
        + 'open at the same time — if they are, this network is probably blocking device-to-device traffic.');
    }
    if (err?.message === 'channel-closed') {
      return this.#interrupt(transfer, 'the connection closed before the transfer started');
    }
    return this.#fail(transfer, err?.message ?? 'Unknown failure.');
  }

  // ── receiving ──────────────────────────────────────────────────────────────

  #onControl(link, channel, msg) {
    switch (msg.t) {
      case MSG.offerFiles: return this.#onOffer(link, channel, msg);
      case MSG.accept: return this.#onAccept(msg);
      case MSG.decline: return this.#onDecline(msg);
      case MSG.fileStart: return this.#onFileStart(link, channel, msg);
      case MSG.fileEnd: return this.#onFileEnd(channel, msg);
      case MSG.progress: return this.#onProgress(msg);
      case MSG.flow: return this.#onFlow(msg);
      case MSG.cancel: return this.#onCancel(msg);
      case MSG.resumeQuery: return this.#onResumeQuery(link, channel, msg);
      case MSG.resumeFrom: return this.#onResumeFrom(msg);
      case MSG.fileSkip: return this.#onFileSkip(msg);
    }
  }

  #onOffer(link, channel, msg) {
    if (this.incoming.has(msg.transferId)) return; // a duplicate offer after a reconnect

    const transfer = new Transfer('in', msg.transferId, link);
    transfer.channel = channel;
    transfer.items = msg.files.map((descriptor) => new ReceiveItem(descriptor));
    transfer.status = STATUS.waiting;
    transfer.detail = `${link.name} wants to send ${msg.files.length === 1 ? 'a file' : `${msg.files.length} files`}`;
    this.incoming.set(transfer.id, transfer);

    // Which way the bytes would arrive, established before the user decides
    // rather than reported afterwards. The receiver has more reason to care about
    // this than the sender does.
    link.describePath().then((path) => {
      transfer.path = path;
      this.#changed(transfer);
    });

    this.#changed(transfer);
    // Nothing is accepted automatically, ever. On a shared network this prompt is
    // the only thing between the user and files from a stranger.
    this.emit('offer', transfer);
  }

  /** Called by the UI when the user taps Accept. Must run inside that gesture:
   *  a save dialog is not permitted outside one. */
  async accept(transfer) {
    if (transfer.status !== STATUS.waiting) return;

    // Pinned for the whole transfer. Reading the setting again at verification
    // time would let a mid-transfer toggle compare a checksum against one that
    // was never computed.
    transfer.verify = settings.get('verifyIntegrity');

    try {
      const session = await beginReceiveSession({
        files: transfer.items,
        preference: settings.get('savePreference'),
        discard: settings.get('discardReceived'),
        verify: transfer.verify,
      });
      transfer.session = session;
    } catch (err) {
      const message = err?.name === 'AbortError'
        ? 'You cancelled the save dialog.'
        : err instanceof StorageUnavailable
          ? err.message
          : `No usable storage on this device: ${err.message}`;
      transfer.link.send(transfer.channel, { t: MSG.decline, transferId: transfer.id, reason: 'no storage' });
      transfer.status = STATUS.failed;
      transfer.detail = message;
      this.#changed(transfer);
      return;
    }

    // Only now, with the dialog behind us, is it safe to await anything. The route
    // check has to come after the picker or the user's tap would have expired.
    transfer.path = await this.#settledPath(transfer.link);

    if (settings.get('requireLocalRoute') && transfer.path.kind !== 'local') {
      await transfer.session.abort().catch(() => {});
      transfer.session = null;
      transfer.link.send(transfer.channel, { t: MSG.decline, transferId: transfer.id, reason: 'not a local route' });
      transfer.status = STATUS.declined;
      transfer.detail = `Refused: this connection is a ${transfer.path.label}, and "local network only" is on.`;
      this.#changed(transfer);
      return;
    }

    transfer.status = STATUS.running;
    transfer.markMoving();
    // The tier is reported through the session's own label; repeating it here
    // would print it twice on the same line.
    transfer.detail = '';
    for (const item of transfer.items) item.status = STATUS.connecting;
    this.#changed(transfer);
    await this.#takeWakeLock();

    transfer.link.send(transfer.channel, {
      t: MSG.accept,
      transferId: transfer.id,
      fileIds: transfer.items.map((item) => item.id),
    });
  }

  decline(transfer, reason = 'declined') {
    transfer.link.send(transfer.channel, { t: MSG.decline, transferId: transfer.id, reason });
    transfer.status = STATUS.declined;
    transfer.detail = 'You declined this transfer.';
    this.#changed(transfer);
  }

  #onAccept(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    transfer?.verdict?.resolve(msg.fileIds);
  }

  #onDecline(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    if (!transfer) return;
    transfer.status = STATUS.declined;
    transfer.detail = msg.reason === 'no storage'
      ? 'The other device could not find room to save this.'
      : `${transfer.link.name} declined.`;
    transfer.verdict?.resolve(null);
    this.#changed(transfer);
  }

  async #onFileStart(link, channel, msg) {
    const transfer = this.incoming.get(msg.transferId);
    if (!transfer) {
      // No memory of this transfer — the tab was reloaded, or the phone was
      // discarded in the background and came back fresh. Staying quiet meant
      // every chunk that followed was dropped on the floor while the sender
      // streamed the entire file and then reported it delivered.
      link.send(channel, {
        t: MSG.cancel,
        transferId: msg.transferId,
        fileId: msg.fileId,
        reason: 'this device no longer has that transfer — send it again',
      });
      return;
    }
    transfer.channel = channel;

    const item = transfer.items.find((candidate) => candidate.id === msg.fileId);
    if (!item) return;

    transfer.chunkSize = msg.chunkSize;

    // The sender states where it is resuming from, and until now nothing checked
    // it. An existing writer can only append, so if the two disagree the bytes
    // would land at the wrong offsets and the file would be quietly wrong — the
    // one failure worth being loud about, because the checksum only catches it
    // after the whole thing has been sent.
    if (item.writer && msg.offset !== item.writer.offset) {
      this.#activeByChannel.delete(channel);
      transfer.link.send(channel, {
        t: MSG.fileSkip,
        transferId: transfer.id,
        fileId: item.id,
        reason: 'resume offset does not match',
      });
      item.status = STATUS.failed;
      transfer.status = STATUS.failed;
      transfer.detail = `${item.name} could not be resumed: the sender restarted at `
        + `${fmtBytes(msg.offset)} but ${fmtBytes(item.writer.offset)} had already been written. Send it again.`;
      this.#changed(transfer);
      return;
    }

    // Registered *before* the writer exists, and deliberately.
    //
    // The sender sends file-start and starts pushing chunks straight away — it
    // has no reason to wait, and an older or third-party client would not. But
    // opening a writer is asynchronous: a save handle, or spawning the storage
    // worker, takes a few milliseconds. Anything arriving in that window has to
    // go somewhere, and dropping it silently corrupts the file in the worst
    // possible way: quietly, with the transfer still reporting success until the
    // checksum disagrees at the very end.
    const entry = { transfer, item, queue: [], ready: false, queued: 0 };
    this.#activeByChannel.set(channel, entry);

    entry.opened = (async () => {
      try {
        // On resume the writer is still open and already in position; recreating
        // it would rewind the file to the start.
        item.writer ??= await transfer.session.writerFor(item, { resumeAt: 0, resumeCrc: 0 });
      } catch (err) {
        this.#activeByChannel.delete(channel);
        transfer.link.send(channel, {
          t: MSG.fileSkip, transferId: transfer.id, fileId: item.id, reason: err.message,
        });
        item.status = STATUS.failed;
        this.#changed(transfer);
        return;
      }

      item.status = STATUS.running;
      item.startedAt = performance.now();
      this.#changed(transfer);

      // Drain whatever arrived while the writer was opening. New arrivals during
      // the drain land in the same queue and are picked up by this loop, so
      // `ready` only flips once nothing is waiting.
      while (entry.queue.length) {
        const buffered = entry.queue.shift();
        entry.queued -= buffered.byteLength;
        await this.#writeChunk(channel, entry, buffered);
      }
      entry.ready = true;
    })();

    await entry.opened;
  }

  async #onBinary(channel, data) {
    const active = this.#activeByChannel.get(channel);
    if (!active) return; // a stray chunk after a cancel

    if (!active.ready) {
      // Only ever a few milliseconds' worth. The cap is here so that a peer which
      // ignores the protocol cannot turn this into unbounded memory growth.
      active.queued += data.byteLength;
      if (active.queued > 64 * MIB) {
        this.#activeByChannel.delete(channel);
        active.transfer.status = STATUS.failed;
        active.transfer.detail = 'The sender got too far ahead of this device\'s storage.';
        this.#changed(active.transfer);
        return;
      }
      active.queue.push(data);
      return;
    }

    await this.#writeChunk(channel, active, data);
  }

  async #writeChunk(channel, active, data) {
    const { transfer, item } = active;

    try {
      await item.writer.write(data);
      item.received = item.writer.offset;
    } catch (err) {
      this.#activeByChannel.delete(channel);
      item.status = STATUS.failed;
      transfer.status = STATUS.failed;
      transfer.detail = err instanceof StorageUnavailable
        ? err.message
        : `Could not write to storage: ${err.message}`;
      transfer.link.send(channel, {
        t: MSG.cancel, transferId: transfer.id, fileId: item.id, reason: 'storage failed',
      });
      this.#changed(transfer);
      return;
    }

    // Tell the sender what has actually landed. Without this the sender can only
    // report what it queued, which overstates progress and never matches reality.
    const now = performance.now();
    if (now - (transfer.lastReport ?? 0) > PROGRESS_INTERVAL) {
      transfer.lastReport = now;
      transfer.link.send(channel, {
        t: MSG.progress, transferId: transfer.id, fileId: item.id, received: item.received,
      });
      this.#applyFlowControl(transfer, item, channel);
      this.#changed(transfer);
    }
  }

  /** Ask the sender to hold off while storage catches up. */
  #applyFlowControl(transfer, item, channel) {
    const congested = item.writer?.congested === true;
    if (congested === transfer.askedPause) return;
    transfer.askedPause = congested;
    transfer.link.send(channel, { t: MSG.flow, transferId: transfer.id, pause: congested });
    if (!congested) return;

    // The resume cannot wait for the next chunk to arrive: this runs only when a
    // chunk arrives, and we have just asked for there to be no more of them. What
    // it waits on is storage draining, which is the thing that actually changed.
    // Left to the old path it recovered only because the sender's buffer still
    // had a backlog to push — and a pause that lands on an empty buffer stalls
    // the transfer outright.
    item.writer.throttle().then(() => {
      if (!transfer.askedPause || isTerminal(transfer.status)) return;
      transfer.askedPause = false;
      transfer.link.send(transfer.channel, { t: MSG.flow, transferId: transfer.id, pause: false });
    }, () => { /* the write failed; #writeChunk reports it */ });
  }

  #onFlow(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    if (!transfer) return;

    if (msg.pause) {
      // Idempotent on purpose. Replacing a live gate would orphan whoever is
      // already waiting on it, and nothing would ever wake them.
      if (transfer.flowPaused) return;
      transfer.flowPaused = true;
      transfer.flowGate = deferred();
    } else {
      transfer.flowPaused = false;
      transfer.flowGate?.resolve();
      transfer.flowGate = null;
    }
  }

  #onProgress(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    const item = transfer?.items.find((candidate) => candidate.id === msg.fileId);
    if (!item) return;
    item.confirmed = msg.received;
    this.#changed(transfer);
  }

  async #onFileEnd(channel, msg) {
    const transfer = this.incoming.get(msg.transferId);
    if (!transfer) return;
    const item = transfer.items.find((candidate) => candidate.id === msg.fileId);
    if (!item) return;

    // The tail of the file may still be in the pre-writer queue. Closing now
    // would truncate it, and the only thing that would notice is the checksum.
    await this.#activeByChannel.get(channel)?.opened;
    if (!item.writer) return;

    this.#activeByChannel.delete(channel);
    item.status = STATUS.verifying;
    this.#changed(transfer);

    let result;
    try {
      result = await item.writer.close();
    } catch (err) {
      item.status = STATUS.failed;
      transfer.status = STATUS.failed;
      transfer.detail = `Could not finish writing ${item.name}: ${err.message}`;
      this.#changed(transfer);
      return;
    }

    item.received = result.bytes;
    item.blob = result.blob;
    item.opfsKey = result.opfsKey ?? null;

    const sizeOk = msg.bytes === null || result.bytes === msg.bytes;
    // Only a claim we can actually check counts. If either side had verification
    // off, the honest answer is "not checked", not "fine".
    const crcOk = (msg.crc === null || !transfer.verify) ? null : result.crc === msg.crc;
    item.crcOk = crcOk;

    if (!sizeOk || crcOk === false) {
      item.status = STATUS.failed;
      transfer.status = STATUS.failed;
      transfer.detail = sizeOk
        ? `${item.name} arrived complete but the checksum does not match. It is corrupt — send it again.`
        : `${item.name} is short: expected ${msg.bytes} bytes, wrote ${result.bytes}.`;
      this.#changed(transfer);
      return;
    }

    item.status = STATUS.done;
    // Confirm the final byte count; the sender's last report may predate it.
    transfer.link.send(channel, {
      t: MSG.progress, transferId: transfer.id, fileId: item.id, received: item.received,
    });

    const pending = transfer.items.some((candidate) =>
      candidate.status !== STATUS.done && candidate.status !== STATUS.failed && candidate.status !== STATUS.declined);

    if (!pending) {
      await transfer.session?.finish();
      transfer.endedAt = performance.now();
      transfer.status = transfer.items.some((candidate) => candidate.status === STATUS.done)
        ? STATUS.done
        : STATUS.failed;
      transfer.detail = '';
      this.#releaseWakeLock();
    }
    this.#changed(transfer);
  }

  #onFileSkip(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    const item = transfer?.items.find((candidate) => candidate.id === msg.fileId);
    if (!item) return;
    item.status = STATUS.failed;
    item.skipReason = msg.reason;
    this.#changed(transfer);
  }

  // ── interruption and resume ────────────────────────────────────────────────

  #onChannelClose(channel) {
    const active = this.#activeByChannel.get(channel);
    this.#activeByChannel.delete(channel);

    if (active) {
      const { transfer, item } = active;
      if (!isTerminal(transfer.status)) {
        item.status = STATUS.interrupted;
        transfer.status = STATUS.interrupted;
        transfer.stalledAt = Date.now();
        transfer.detail = 'Connection lost. Waiting to pick up where it stopped…';
        // Flush what is queued so the resume point we quote is the truth rather
        // than an optimistic guess.
        item.writer?.drain().catch(() => {}).finally(() => this.#changed(transfer));
        this.#changed(transfer);
      }
    }

    for (const transfer of this.outgoing.values()) {
      if (transfer.channel !== channel || isTerminal(transfer.status)) continue;
      this.#interrupt(transfer, 'the connection dropped');
    }
  }

  #interrupt(transfer, why) {
    transfer.status = STATUS.interrupted;
    transfer.stalledAt = Date.now();
    transfer.detail = `Paused — ${why}. It will continue by itself if the device comes back.`;
    this.#changed(transfer);

    // A channel that has just died takes any query sent over it with it, so an
    // attempt that was in flight is over whether it knows it or not. Whether that
    // counts against the backoff is the difference between a link that flaps and
    // a tight loop of reconnect-and-die: if we had an attempt running, this is it
    // failing, and it waits its turn.
    if (transfer.resuming) this.#attemptFailed(transfer);
    else this.#scheduleResume(transfer, 0);
  }

  /**
   * A device is reachable again. Anything stalled to it can resume.
   *
   * Matching is by public key rather than session id, because the session id is
   * new on every reconnect — the key is the only thing that says "this is the
   * same device".
   */
  #retryFor(peer) {
    for (const transfer of this.outgoing.values()) {
      if (transfer.status !== STATUS.interrupted) continue;

      const sameDevice = (transfer.peerKey && peer.pubkey && transfer.peerKey === peer.pubkey)
        || transfer.link.id === peer.id
        || transfer.resumePeerId === peer.id;
      if (!sameDevice) continue;

      // A device announcing itself is news, not another failed attempt. Drop
      // whatever backoff we had reached and go now, under the id it just used.
      transfer.resumePeerId = peer.id;
      transfer.resumeAttempts = 0;
      clearTimeout(transfer.retryTimer);
      transfer.retryTimer = null;
      this.#scheduleResume(transfer, 0);
    }
  }

  /**
   * Line up the next resume attempt.
   *
   * Everything that could want a transfer to resume — the interruption itself, a
   * peer reappearing, an attempt timing out — comes through here, and anything
   * already in flight or already scheduled wins. That is what keeps overlapping
   * triggers from sending two `resume-query` messages and streaming the same file
   * from two offsets at once.
   */
  #scheduleResume(transfer, delay) {
    if (transfer.resuming || transfer.retryTimer) return;
    if (transfer.status !== STATUS.interrupted || transfer.abort.signal.aborted) return;

    transfer.retryTimer = setTimeout(() => {
      transfer.retryTimer = null;
      this.#attemptResume(transfer);
    }, delay);
  }

  async #attemptResume(transfer) {
    if (transfer.status !== STATUS.interrupted || transfer.abort.signal.aborted) return;

    // A failed RTCPeerConnection never recovers: a data channel opened on one
    // stays 'connecting' until it times out, every time, forever. Renewing gives
    // the retry something that can actually succeed.
    const link = this.#network.renew(transfer.resumePeerId ?? transfer.link.id);
    if (!link) return this.#attemptFailed(transfer);

    transfer.resuming = true;
    transfer.link = link;
    transfer.peerName = link.name;

    try {
      const channel = await link.ensureChannel({ timeout: 15_000, signal: transfer.abort.signal });
      if (transfer.status !== STATUS.interrupted) return this.#settleResume(transfer);

      transfer.channel = channel;
      channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
      transfer.detail = 'Reconnected — asking where to pick up…';
      this.#changed(transfer);
      link.send(channel, { t: MSG.resumeQuery, transferId: transfer.id });

      // The query is out. If no answer comes back, that is not a reason to stop
      // — it is a reason to ask again, which is the whole difference between a
      // transfer that survives a flaky link and one that sits at "asking where to
      // pick up" until it is reaped.
      transfer.resumeTimer = setTimeout(() => this.#attemptFailed(transfer), RESUME_ANSWER_TIMEOUT);
    } catch {
      this.#attemptFailed(transfer); // still unreachable; back off and try again
    }
  }

  /** One attempt is over without an answer. Back off, then have another go. */
  #attemptFailed(transfer) {
    this.#abandonAttempt(transfer);
    if (transfer.status !== STATUS.interrupted || transfer.abort.signal.aborted) return;

    const wait = Math.min(RESUME_RETRY_MAX, RESUME_RETRY_MIN * 2 ** transfer.resumeAttempts++);
    transfer.detail = `Waiting for ${transfer.peerName} to come back — retrying…`;
    this.#changed(transfer);
    this.#scheduleResume(transfer, wait);
  }

  /** Forget an attempt that is in flight, without touching the backoff. */
  #abandonAttempt(transfer) {
    clearTimeout(transfer.resumeTimer);
    transfer.resumeTimer = null;
    transfer.resuming = false;
  }

  /** Stop the retry machinery altogether: answered, cancelled or given up on. */
  #settleResume(transfer) {
    this.#abandonAttempt(transfer);
    clearTimeout(transfer.retryTimer);
    transfer.retryTimer = null;
    transfer.resumeAttempts = 0;
  }

  async #onResumeQuery(link, channel, msg) {
    const transfer = this.incoming.get(msg.transferId);
    if (!transfer) {
      // We no longer hold the partial file. Say so plainly rather than letting
      // the sender resume into nothing.
      link.send(channel, {
        t: MSG.resumeFrom, transferId: msg.transferId, fileId: msg.fileId ?? 'unknown',
        available: false, offset: 0,
      });
      return;
    }

    transfer.channel = channel;
    const item = transfer.items.find((candidate) =>
      candidate.status === STATUS.interrupted || candidate.status === STATUS.running)
      ?? transfer.items.find((candidate) => candidate.status !== STATUS.done);

    if (!item?.writer) {
      link.send(channel, {
        t: MSG.resumeFrom, transferId: transfer.id, fileId: item?.id ?? 'unknown',
        available: false, offset: 0,
      });
      return;
    }

    // Everything queued must be on disk before we can name an offset.
    await item.writer.drain().catch(() => {});
    item.received = item.writer.offset;
    item.status = STATUS.running;
    transfer.status = STATUS.running;
    // Restart the rate clock, or the reported speed would include however long
    // the transfer sat waiting for the other device to come back.
    transfer.markMoving();
    transfer.detail = `resuming at ${fmtBytes(item.received)}`;
    // The same shape `file-start` registers, and for the same reason: `#onBinary`
    // reads `queue` and `queued` off whatever it finds here. A bare
    // `{ transfer, item }` throws on the first chunk that arrives ahead of the
    // sender's `file-start`, and the chunk is lost with nothing on screen.
    // `ready` is true because this writer is already open and in position.
    this.#activeByChannel.set(channel, {
      transfer, item, queue: [], queued: 0, ready: true, opened: Promise.resolve(),
    });
    this.#changed(transfer);

    link.send(channel, {
      t: MSG.resumeFrom,
      transferId: transfer.id,
      fileId: item.id,
      available: true,
      offset: item.received,
    });
  }

  async #onResumeFrom(msg) {
    const transfer = this.outgoing.get(msg.transferId);
    if (!transfer) return;

    // The answer we were waiting for, whatever we then decide to do with it. Stop
    // the retry machinery before the early return below, or a transfer that has
    // moved on would keep a timer running against it.
    this.#settleResume(transfer);
    if (transfer.status !== STATUS.interrupted) return;

    const item = transfer.items.find((candidate) => candidate.id === msg.fileId)
      ?? transfer.items.find((candidate) => candidate.status === STATUS.interrupted);
    if (!item) return;

    if (!msg.available) {
      transfer.detail = 'The other device no longer has the partial file — starting this one again.';
      item.sent = 0;
      item.confirmed = 0;
    } else {
      item.sent = Math.min(msg.offset, item.size);
      item.confirmed = item.sent;
      transfer.detail = item.sent > 0 ? `resumed at ${fmtBytes(item.sent)}` : '';
    }

    transfer.status = STATUS.running;
    transfer.chunkSize = negotiateChunkSize(transfer.link.pc, settings.get('chunkSizeOverride'));
    transfer.markMoving();
    this.#changed(transfer);
    await this.#takeWakeLock();

    // Continue with this file, then the rest of the queue.
    const remaining = transfer.items.slice(transfer.items.indexOf(item));
    for (const next of remaining) {
      if (transfer.abort.signal.aborted) return;
      if (next.status === STATUS.done || next.skipped) continue;
      await this.#sendOne(transfer, next);
      if (next.status === STATUS.failed || next.status === STATUS.interrupted) return;
    }

    transfer.endedAt = performance.now();
    transfer.status = transfer.items.some((candidate) => candidate.status === STATUS.done)
      ? STATUS.done
      : STATUS.failed;
    this.#changed(transfer);
    this.#releaseWakeLock();
  }

  // ── cancel ─────────────────────────────────────────────────────────────────

  cancel(transfer, reason = 'cancelled') {
    transfer.abort.abort();
    this.#settleResume(transfer);
    transfer.flowGate?.resolve();
    transfer.verdict?.resolve(null);
    transfer.link.send(transfer.channel, { t: MSG.cancel, transferId: transfer.id, reason });
    transfer.status = STATUS.cancelled;
    transfer.detail = 'Cancelled.';
    transfer.endedAt = performance.now();

    if (transfer.direction === 'in') {
      for (const item of transfer.items) item.writer?.abort().catch(() => {});
      transfer.session?.abort().catch(() => {});
      this.#activeByChannel.delete(transfer.channel);
    }
    this.#changed(transfer);
    this.#releaseWakeLock();
  }

  #onCancel(msg) {
    const transfer = this.outgoing.get(msg.transferId) ?? this.incoming.get(msg.transferId);
    if (!transfer || isTerminal(transfer.status)) return;

    transfer.abort.abort();
    this.#settleResume(transfer);
    transfer.flowGate?.resolve();
    transfer.verdict?.resolve(null);
    transfer.status = STATUS.cancelled;
    transfer.detail = `${transfer.link.name} cancelled${msg.reason ? ` — ${msg.reason}` : ''}.`;
    transfer.endedAt = performance.now();

    if (transfer.direction === 'in') {
      for (const item of transfer.items) item.writer?.abort().catch(() => {});
      transfer.session?.abort().catch(() => {});
      // Without this, chunks still in flight when the cancel arrived would be
      // handed to a writer that has already been torn down.
      this.#activeByChannel.delete(transfer.channel);
    }
    this.#changed(transfer);
    this.#releaseWakeLock();
  }

  #fail(transfer, message) {
    this.#settleResume(transfer);
    transfer.status = STATUS.failed;
    transfer.detail = message;
    transfer.endedAt = performance.now();
    this.#changed(transfer);
  }

  /** Let go of stalled transfers that are never coming back, and of the OPFS
   *  files behind completed ones the user has already saved. */
  #reap() {
    const now = Date.now();
    for (const map of [this.outgoing, this.incoming]) {
      for (const transfer of map.values()) {
        if (transfer.status !== STATUS.interrupted) continue;
        if (now - (transfer.stalledAt ?? now) < RESUME_KEEP_MS) continue;
        this.#settleResume(transfer);
        transfer.status = STATUS.failed;
        transfer.detail = 'Gave up waiting for the other device to come back.';
        if (transfer.direction === 'in') {
          for (const item of transfer.items) item.writer?.abort().catch(() => {});
        }
        this.#changed(transfer);
      }
    }
  }

  /**
   * The user has saved a received file.
   *
   * Deliberately does *not* delete the backing OPFS file. The download the click
   * just started reads through a Blob backed by that file, and removing it
   * underneath an in-flight save truncates it — a corrupted download caused by
   * tidying up. The startup sweep reclaims it on the next page load instead, which
   * is deterministic and cannot race anything.
   *
   * The object URL is released on a long timer purely to free the reference.
   */
  release(item) {
    if (!item.objectUrl || item.released) return;
    item.released = true;
    setTimeout(() => {
      URL.revokeObjectURL(item.objectUrl);
      item.objectUrl = null;
    }, 120_000);
  }

  // ── screen wake lock ───────────────────────────────────────────────────────
  // A locked screen suspends the tab on iOS and stalls the transfer. This makes
  // that less likely; it is not a substitute for resume, which handles it when
  // the lock is unavailable or refused.

  async #takeWakeLock() {
    if (!settings.get('keepAwake') || this.#wakeLock || !navigator.wakeLock) return;
    try {
      this.#wakeLock = await navigator.wakeLock.request('screen');
      this.#wakeLock.addEventListener('release', () => { this.#wakeLock = null; });
    } catch { /* refused, or the tab is not visible. Not worth reporting. */ }
  }

  #releaseWakeLock() {
    const busy = [...this.outgoing.values(), ...this.incoming.values()]
      .some((transfer) => !isTerminal(transfer.status) && transfer.status !== STATUS.waiting);
    if (busy) return;
    this.#wakeLock?.release?.().catch(() => {});
    this.#wakeLock = null;
  }
}

// ── reading the source ───────────────────────────────────────────────────────

/**
 * Exactly `size`-byte pieces of a Blob, read as a stream.
 *
 * Streaming rather than slicing per chunk for two reasons: a 1 GB file needs
 * around four thousand `slice().arrayBuffer()` round trips, each an async hop
 * through the file system, and slicing says nothing about read-ahead. A stream
 * lets the browser read at its own pace while we hand out fixed-size messages.
 *
 * The buffer is reused across chunks. `send()` copies into the transport's own
 * queue before returning, so the bytes are safe the moment the call completes,
 * and avoiding a fresh allocation per chunk keeps the garbage collector out of
 * the hot path.
 */
async function* chunksOf(blob, size) {
  if (typeof blob.stream !== 'function') {
    // Older Safari. Slice-based, but never the whole file at once.
    for (let at = 0; at < blob.size; at += size) {
      yield new Uint8Array(await blob.slice(at, at + size).arrayBuffer());
    }
    return;
  }

  const reader = blob.stream().getReader();
  const buffer = new Uint8Array(size);
  let filled = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      let taken = 0;
      while (taken < value.byteLength) {
        const room = size - filled;
        const take = Math.min(room, value.byteLength - taken);
        buffer.set(value.subarray(taken, taken + take), filled);
        filled += take;
        taken += take;
        if (filled === size) {
          yield buffer;
          filled = 0;
        }
      }
    }
    if (filled > 0) yield buffer.subarray(0, filled);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Hash the file on another thread, and let the caller stop caring if the
 *  transfer dies first. */
function startChecksum(file) {
  const worker = new Worker(new URL('./crc-worker.js', import.meta.url), { type: 'module' });
  const gate = deferred();

  worker.onmessage = ({ data }) => {
    gate.resolve(data.t === 'crc' ? data.crc >>> 0 : null);
    worker.terminate();
  };
  worker.onerror = () => { gate.resolve(null); worker.terminate(); };
  worker.postMessage({ file });

  return {
    result: gate.promise,
    cancel: () => { gate.resolve(null); worker.terminate(); },
  };
}
