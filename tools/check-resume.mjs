// What a transfer does when the link misbehaves — resuming, and reporting the
// route honestly while it runs.
//
// These are the behaviours the other suites cannot reach. The unit checks never
// build a TransferManager, and the end-to-end check moves a file over a link that
// works — so the whole resume path, which only runs when the link *stops*
// working, went untested. The bug it was hiding: `resuming` was set for the
// lifetime of an attempt and cleared only when an answer came back, so a single
// lost `resume-query` — the likeliest message in the protocol to be lost, since
// it travels over a channel that has just come back from being broken — left the
// sender saying "asking where to pick up" and the receiver saying "waiting to
// pick up", both of them forever.
//
// So: a real TransferManager, driven through the interface a peer drives it
// through — control messages and a channel that closes — with a fake clock, so a
// test about timeouts does not take as long as the timeouts.
//
//   node tools/check-resume.mjs

import { ok, strictEqual } from 'node:assert';

// Must be in place before the modules under test are loaded: settings reads
// storage at import time, and a transfer asks for a wake lock.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.navigator ??= {};

const { STATUS, TransferManager } = await import('../public/js/transfer.js');
const { settings } = await import('../public/js/settings.js');

// The checksum runs in a Worker, which is a browser global. Nothing here is
// measuring integrity, so it is simply off.
settings.set('verifyIntegrity', false);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ── a clock we control ───────────────────────────────────────────────────────

// Two turns, because the code under test chains awaits before it settles.
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

class Clock {
  now = 0;
  #timers = new Map();
  #next = 1;
  #real = {};

  install() {
    this.#real = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
    };
    globalThis.setTimeout = (fn, ms = 0) => {
      const id = this.#next++;
      this.#timers.set(id, { at: this.now + ms, fn });
      return id;
    };
    globalThis.clearTimeout = (id) => this.#timers.delete(id);
    // Intervals are real here: the manager runs its route refresh on one, and a
    // no-op stub would make that untestable.
    globalThis.setInterval = (fn, ms = 0) => {
      const id = this.#next++;
      this.#timers.set(id, { at: this.now + ms, fn, period: Math.max(1, ms) });
      return id;
    };
  }

  restore() {
    Object.assign(globalThis, this.#real);
    if (this.#realNow) Date.now = this.#realNow;
  }

  /** Wall-clock too, for code that measures silence rather than sets a timer. */
  installDate(epoch = 1_700_000_000_000) {
    this.#realNow = Date.now;
    this.epoch = epoch;
    Date.now = () => this.epoch + this.now;
  }

  #realNow = null;

  /** Run every timer due within `ms`, in order, flushing microtasks between. */
  async advance(ms) {
    const until = this.now + ms;
    for (let guard = 0; guard < 1000; guard++) {
      let due = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= until && (!due || timer.at < due[1].at)) due = [id, timer];
      }
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.period) timer.at = this.now + timer.period;
      else this.#timers.delete(id);
      timer.fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

// ── fakes, one layer below the code under test ───────────────────────────────

/** `closeAfter` chunks in, the channel dies under the sender — a Wi-Fi roam, a
 *  phone changing bands. The send loop notices on its next pass, which is
 *  precisely the timing the real thing has. */
function fakeChannel(closeAfter = Infinity) {
  return {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    chunks: 0,
    send() {
      this.chunks++;
      if (this.chunks >= closeAfter) this.readyState = 'closed';
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A stand-in for PeerLink: records what was sent, and lets the test play the
 *  part of the peer by firing the events a real one would emit. */
function fakeLink(id, { pubkey = 'peer-key', closeAfter = Infinity } = {}) {
  const handlers = new Map();
  return {
    id,
    name: 'Test Device',
    pubkey,
    state: 'connected',
    pc: {},
    // Only the first channel is doomed. A channel handed out after the drop stays
    // open, so a query that goes unanswered is unanswered rather than undelivered.
    channel: fakeChannel(closeAfter),
    sent: [],
    channelsOpened: 0,

    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },

    async ensureChannel() {
      // A reconnect gets a new channel, exactly as it would in the browser.
      if (this.channel.readyState !== 'open') {
        this.channel = fakeChannel();
        this.channelsOpened++;
      }
      return this.channel;
    },

    // The real one drops anything handed to a channel that is not open. That is
    // the whole mechanism by which a resume query goes missing, so it is modelled.
    send(channel, msg) {
      if (channel?.readyState === 'open') this.sent.push(msg);
    },

    // What the route looks like right now. A test can reassign this to model ICE
    // moving the traffic to a different pair partway through.
    path: { kind: 'local', label: 'local network', tone: 'ok', localType: 'host', remoteType: 'host', rtt: 1 },
    pathReads: 0,

    async describePath() {
      this.pathReads++;
      return this.path;
    },
    async refreshPath() {
      const path = await this.describePath();
      if (path.kind !== 'unknown') {
        this.pathLabel = path.label;
        this.pathTone = path.tone;
        this.fire('info');
      }
      return path;
    },
    async diagnose() { return { cause: 'test', message: 'test' }; },
  };
}

function fakeNetwork(link) {
  const handlers = new Map();
  return {
    links: new Map([[link.id, link]]),
    renewals: 0,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    linkTo: (id) => (id === link.id ? link : null),
    renew(id) { this.renewals++; return this.linkTo(id); },
  };
}

const queriesIn = (link) => link.sent.filter((msg) => msg.t === 'resume-query').length;

/**
 * Run a transfer up to the point where the connection dies mid-file.
 * @returns {Promise<{ transfers, link, network, transfer, clock }>}
 */
async function interruptedTransfer({ closeAfterChunks = 2 } = {}) {
  const clock = new Clock();
  clock.install();

  const link = fakeLink('session-1', { closeAfter: closeAfterChunks });
  const network = fakeNetwork(link);
  const transfers = new TransferManager(network);

  // Big enough to take several chunks, small enough to stay instant.
  const file = new File([new Uint8Array(160 * 1024)], 'holiday.mkv', { type: 'video/x-matroska' });

  const sending = transfers.send(link, [file]);
  await flush();

  const offer = link.sent.find((msg) => msg.t === 'offer-files');
  ok(offer, 'the sender should have offered the file');

  // Play the receiver accepting; the channel then dies of its own accord.
  link.fire('control', link.channel, {
    t: 'accept', transferId: offer.transferId, fileIds: offer.files.map((f) => f.id),
  });
  await sending;
  await flush();

  const transfer = [...transfers.outgoing.values()][0];
  return { transfers, link, network, transfer, clock };
}

// ── the checks ───────────────────────────────────────────────────────────────

console.log('\n  resume\n');

await test('a connection lost mid-file leaves the transfer resumable, not failed', async () => {
  const { transfer, clock } = await interruptedTransfer();
  try {
    strictEqual(transfer.status, STATUS.interrupted);
    ok(transfer.stalledAt > 0, 'it should record when it stalled');
  } finally {
    clock.restore();
  }
});

await test('the sender asks the peer where to pick up', async () => {
  const { link, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    strictEqual(queriesIn(link), 1);
  } finally {
    clock.restore();
  }
});

await test('a lost resume query is asked again instead of stalling forever', async () => {
  // The regression. Before the fix this stayed at one query for the full ten
  // minutes the transfer was kept alive, which is what both screens were showing.
  const { link, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    strictEqual(queriesIn(link), 1, 'the first query should go out at once');

    await clock.advance(60_000);
    ok(queriesIn(link) > 1, `a silent peer should be asked again — only ${queriesIn(link)} query sent in a minute`);
  } finally {
    clock.restore();
  }
});

await test('retries back off rather than hammering a peer that is gone', async () => {
  const { link, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    await clock.advance(60_000);
    const first = queriesIn(link);
    await clock.advance(60_000);
    const second = queriesIn(link) - first;
    ok(second <= first, `retries should not accelerate: ${first} then ${second}`);
    ok(queriesIn(link) < 60, `a minute should not produce ${queriesIn(link)} queries`);
  } finally {
    clock.restore();
  }
});

await test('an answer stops the asking and restarts the file from the offset given', async () => {
  const { link, transfer, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    const asked = queriesIn(link);
    const item = transfer.items[0];

    link.fire('control', link.channel, {
      t: 'resume-from',
      transferId: transfer.id,
      fileId: item.id,
      available: true,
      offset: 32_768,
    });
    await flush();

    ok(transfer.status !== STATUS.interrupted, 'the transfer should have left the interrupted state');
    ok(item.sent >= 32_768, `it should resume at the offset the receiver quoted, not ${item.sent}`);

    await clock.advance(120_000);
    strictEqual(queriesIn(link), asked, 'no further queries once the answer arrived');
  } finally {
    clock.restore();
  }
});

await test('a peer reappearing under a new session id retries immediately', async () => {
  const { link, network, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    const before = queriesIn(link);

    // Far enough into the backoff that nothing was about to fire on its own.
    await clock.advance(30_000);
    const midway = queriesIn(link);

    network.emit('peer-available', { id: link.id, pubkey: link.pubkey });
    await clock.advance(0);
    ok(queriesIn(link) > midway, 'an announcement should not wait out the backoff');
    ok(midway >= before);
  } finally {
    clock.restore();
  }
});

await test('a cancelled transfer stops trying to resume', async () => {
  const { transfers, link, transfer, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    transfers.cancel(transfer);
    const asked = queriesIn(link);

    await clock.advance(120_000);
    strictEqual(queriesIn(link), asked, 'a cancelled transfer should send nothing further');
  } finally {
    clock.restore();
  }
});

await test('a dead connection is replaced rather than retried', async () => {
  const { network, clock } = await interruptedTransfer();
  try {
    await clock.advance(0);
    ok(network.renewals > 0, 'the retry should go through renew(), not linkTo()');
  } finally {
    clock.restore();
  }
});

// ── the route a transfer reports ─────────────────────────────────────────────
//
// Sampled once and frozen, this is the number that misleads whoever is trying to
// work out why a transfer is slow — and the reason two devices could describe
// one connection as both "local network · 118 ms" and "internet route · 7 ms".

console.log('\n  route reporting\n');

await test('a running transfer re-reads its route rather than freezing the first one', async () => {
  const { link, transfer, clock } = await interruptedTransfer();
  try {
    strictEqual(transfer.path.label, 'local network');

    // ICE moves the traffic to a pair that leaves the network.
    link.path = { kind: 'internet', label: 'internet route', tone: 'warn', localType: 'srflx', remoteType: 'srflx', rtt: 90 };
    await clock.advance(5_000);

    strictEqual(transfer.path.label, 'internet route');
    strictEqual(transfer.path.rtt, 90, 'the round-trip figure should track the link too');
  } finally {
    clock.restore();
  }
});

await test('a route that cannot be read leaves the last known one alone', async () => {
  const { link, transfer, clock } = await interruptedTransfer();
  try {
    link.path = { kind: 'unknown', label: 'route not established yet', tone: '', localType: null, remoteType: null, rtt: null };
    await clock.advance(5_000);

    strictEqual(transfer.path.label, 'local network', 'a shrug should not replace a real answer');
  } finally {
    clock.restore();
  }
});

await test('an idle app does not poll getStats', async () => {
  const { transfers, link, transfer, clock } = await interruptedTransfer();
  try {
    transfers.cancel(transfer);
    const reads = link.pathReads;
    await clock.advance(30_000);
    strictEqual(link.pathReads, reads, 'nothing is running; the route should not be read');
  } finally {
    clock.restore();
  }
});

// ── a peer that has forgotten the transfer ───────────────────────────────────

await test('a file-start for an unknown transfer is refused, not silently dropped', async () => {
  const clock = new Clock();
  clock.install();
  try {
    const link = fakeLink('session-1');
    const transfers = new TransferManager(fakeNetwork(link));
    void transfers;

    // What the sender does after being told to start over, against a tab that
    // was reloaded or discarded while it was in the background.
    link.fire('control', link.channel, {
      t: 'file-start', transferId: 'gone', fileId: 'f1', chunkSize: 16384, offset: 0,
    });
    await flush();

    const reply = link.sent.find((msg) => msg.t === 'cancel');
    ok(reply, 'the sender must be told; otherwise it streams the whole file into nothing '
      + 'and then reports it delivered');
    strictEqual(reply.transferId, 'gone');
  } finally {
    clock.restore();
  }
});

// ── the signalling socket's own liveness ─────────────────────────────────────
//
// The failure this pins down: a phone frozen in the background stops sending
// keepalives, the server drops it after 90s, and the close never reaches a
// frozen tab — or a radio that changed networks never delivers it. The tab wakes
// up with readyState still OPEN, so it never rejoins, never re-announces, and
// the device waiting to send to it waits for a peer the server has forgotten.

class FakeSocket {
  static OPEN = 1;
  static instances = [];

  readyState = 0;
  sent = [];

  constructor(url) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  /** The server accepting the connection. */
  accept() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  deliver(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const listeners = new Map();
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  },
};

globalThis.WebSocket = FakeSocket;
globalThis.document = fakeDocument;
globalThis.location = { protocol: 'https:', host: 'roombeam.test' };
globalThis.addEventListener ??= () => {};

const { Signaling } = await import('../public/js/signaling.js');

/** A connected Signaling with one live socket, on a clock the test controls. */
async function connected(clock) {
  FakeSocket.instances.length = 0;
  const signaling = new Signaling(() => ({ name: 'Tester', pubkey: 'k' }));
  signaling.connect(true);
  const socket = FakeSocket.instances[0];
  socket.accept();
  socket.deliver({ t: 'welcome', id: 'sess-1', room: { kind: 'network', code: null, size: 1 }, peers: [] });
  await flush();
  return { signaling, socket };
}

await test('a socket that stops answering is replaced, not pinged forever', async () => {
  const clock = new Clock();
  clock.install();
  clock.installDate();
  try {
    const { socket } = await connected(clock);
    strictEqual(FakeSocket.instances.length, 1);

    // The server has dropped us and the close never arrived: still OPEN here,
    // carrying nothing. Pings go out and nothing comes back.
    await clock.advance(90_000);

    ok(socket.sent.some((msg) => msg.t === 'ping'), 'it should have tried pinging first');
    strictEqual(FakeSocket.instances.length, 2, 'the dead socket should have been replaced');
  } finally {
    clock.restore();
  }
});

await test('a socket that keeps answering is left alone', async () => {
  const clock = new Clock();
  clock.install();
  clock.installDate();
  try {
    const { socket } = await connected(clock);
    // Answer every ping, as a healthy server does.
    socket.send = (data) => {
      socket.sent.push(JSON.parse(data));
      queueMicrotask(() => socket.deliver({ t: 'pong' }));
    };

    await clock.advance(300_000);
    strictEqual(FakeSocket.instances.length, 1, 'a healthy socket must not be churned');
  } finally {
    clock.restore();
  }
});

await test('returning to the foreground proves the socket rather than trusting it', async () => {
  const clock = new Clock();
  clock.install();
  clock.installDate();
  try {
    const { socket } = await connected(clock);
    const before = socket.sent.length;

    // Back from another app. readyState still says OPEN, so the old check —
    // "reconnect only if not connected" — did nothing at all here.
    for (const fn of listeners.get('visibilitychange') ?? []) fn();
    await flush();

    ok(socket.sent.length > before, 'it should ask outright instead of assuming');
    await clock.advance(6_000);
    strictEqual(FakeSocket.instances.length, 2, 'no answer means the socket is gone');
  } finally {
    clock.restore();
  }
});

console.log(`\n${failed ? 'FAILED' : 'passed'}: ${passed} checks ok, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
