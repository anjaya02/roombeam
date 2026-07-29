// End-to-end: two real browser tabs, one real transfer.
//
// The unit checks cover the maths and the server. They cannot tell you whether a
// DataChannel opens, whether the OPFS worker writes what it was given, or whether
// the checksum agrees at the far end — and those are the things that actually
// break. So this drives a headless Chromium over the DevTools Protocol, opens the
// app twice, drops a file onto one tab's device row, accepts on the other, and
// waits for both to say it arrived intact.
//
// It goes through the interface a person uses: a drop event and a tap on Accept.
// No test hooks in the app, so nothing here can pass because of a back door.
//
//   node tools/check-browser.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strictEqual, ok } from 'node:assert';
import { WebSocket } from 'ws';
import { attachSignaling } from '../src/signaling.js';
import { createRequestHandler } from '../src/http.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILE_BYTES = 6 * 1024 * 1024;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const browserPath = BROWSERS.find((path) => existsSync(path));
if (!browserPath) {
  console.log('\n  No Chromium-based browser found — skipping the end-to-end check.\n');
  process.exit(0);
}

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

// ── a minimal DevTools Protocol client ───────────────────────────────────────

class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();
  #listeners = [];

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      cdp.#ws.once('open', resolve);
      cdp.#ws.once('error', reject);
    });
    cdp.#ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && cdp.#pending.has(msg.id)) {
        const { resolve, reject } = cdp.#pending.get(msg.id);
        cdp.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const listener of cdp.#listeners) listener(msg);
      }
    });
    return cdp;
  }

  on(fn) { this.#listeners.push(fn); }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  close() { this.#ws.close(); }
}

/** One tab, plus whatever it logged. */
class Tab {
  errors = [];

  constructor(cdp, sessionId, label) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.label = label;
  }

  static async open(cdp, url, label, { init } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, label);

    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params.exceptionDetails;
        tab.errors.push(detail.exception?.description ?? detail.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        tab.errors.push(msg.params.args.map((a) => a.description ?? a.value).join(' '));
      }
    });

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    // Settings have to be in place before the app's first line runs. Setting them
    // afterwards and reloading would work, but it also joins the room twice under
    // two names, and then the test is racing the roster it is about to assert on.
    if (init) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init }, sessionId);

    await tab.goto(url);
    return tab;
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await this.waitFor('document.readyState === "complete"', 15_000, 'page load');
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise,
    }, this.sessionId);
    if (result.exceptionDetails) {
      throw new Error(`${this.label}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  /** Poll until truthy. Takes either an expression or a block that returns. */
  async waitFor(source, timeout, what) {
    const body = /\breturn\b/.test(source) ? source : `return (${source});`;
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.eval(body);
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${this.label}: timed out waiting for ${what} (last value ${JSON.stringify(last)})`);
  }
}

// ── the app server ───────────────────────────────────────────────────────────
// Plain HTTP on 127.0.0.1, which counts as a secure context, so WebRTC, service
// workers and OPFS are all available without certificate wrangling.

let signaling;
const server = createServer(createRequestHandler({
  roots: { '/': join(ROOT, 'public') },
  stats: () => signaling.stats(),
  startedAt: Date.now(),
}));
signaling = attachSignaling(server, { log: () => {} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ── the browser ──────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'roombeam-e2e-'));
const child = spawn(browserPath, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  // Chromium normally replaces local IP candidates with mDNS names for privacy.
  // Two tabs in one headless browser have no mDNS responder to resolve them, so
  // without this ICE has nothing usable and the connection never forms.
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--allow-loopback-in-peer-connection',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const debuggerUrl = await new Promise((resolve, reject) => {
  let buffered = '';
  const timer = setTimeout(() => reject(new Error('the browser never reported a debugging port')), 20_000);
  child.stderr.on('data', (data) => {
    buffered += data.toString();
    const match = /ws:\/\/[^\s]+/.exec(buffered);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  });
  child.once('exit', (code) => reject(new Error(`the browser exited early (${code})`)));
});

const cdp = await Cdp.connect(debuggerUrl);

async function cleanup() {
  try { cdp.close(); } catch { /* going away */ }
  child.kill();
  signaling.close();
  await new Promise((resolve) => server.close(resolve));
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

// ── the run ──────────────────────────────────────────────────────────────────

console.log(`\nEnd to end — ${browserPath.split(/[/\\]/).pop()}, two tabs, ${FILE_BYTES / 1048576} MB\n`);

try {
  // No save dialog — there is nobody here to answer one — and checksums on,
  // which is the path worth exercising.
  const settingsFor = (name) => `
    localStorage.setItem('roombeam.settings', JSON.stringify({ savePreference: 'no-dialog', verifyIntegrity: true }));
    localStorage.setItem('roombeam.name', ${JSON.stringify(name)});
  `;

  const sender = await Tab.open(cdp, origin, 'sender', { init: settingsFor('Sender') });
  const receiver = await Tab.open(cdp, origin, 'receiver', { init: settingsFor('Receiver') });

  /** Locate a device row by name rather than by position. */
  const peerRow = (name) => `[...document.querySelectorAll('#peers .peer')]`
    + `.find(r => r.querySelector('.nm').textContent === ${JSON.stringify(name)})`;

  check('both tabs come up without a script error', () => {
    strictEqual(sender.errors.length, 0, sender.errors.join(' | '));
    strictEqual(receiver.errors.length, 0, receiver.errors.join(' | '));
  });

  const connState = await sender.waitFor(
    `document.querySelector('#conn')?.dataset.state === 'open'`, 10_000, 'signalling to connect');
  check('the signalling socket connects', () => ok(connState));

  const found = await sender.waitFor(`Boolean(${peerRow('Receiver')})`, 10_000, 'the other device to appear');
  await receiver.waitFor(`Boolean(${peerRow('Sender')})`, 10_000, 'the other device to appear');

  check('each tab discovers the other by name, with no user action', () => ok(found));

  const rosterSize = await sender.eval(`return document.querySelectorAll('#peers .peer').length;`);
  check('exactly one device is listed', () => strictEqual(rosterSize, 1));

  const sendAllShown = await sender.eval(`
    const btn = document.querySelector('#send-all');
    return Boolean(btn) && !btn.hidden && btn.offsetParent !== null;
  `);
  check('"Send files to all" stays out of the way for one device', () => strictEqual(sendAllShown, false));

  const messageAction = await sender.eval(`
    const btn = document.querySelector('#send-message');
    return {
      text: btn.textContent,
      inMessages: Boolean(btn.closest('section')?.querySelector('#messages')),
      shown: !btn.hidden && btn.offsetParent !== null,
    };
  `);
  check('"New message" belongs to Messages once a device is present', () => {
    strictEqual(messageAction.text, 'New message');
    strictEqual(messageAction.inMessages, true);
    strictEqual(messageAction.shown, true);
  });

  // ── a link, sent as a message ───────────────────────────────────────────────
  // The other thing that crosses the channel: not a file but a short link, shown
  // on the far device straight away — no accept prompt, because nothing is saved
  // or opened on its own. Driven through the compose dialog a person actually
  // uses, and this is also what opens the connection the file transfer reuses.
  const LINK = 'https://example.com/handout';
  await sender.eval(`
    document.querySelector('#send-message').click();
    document.querySelector('#message-body').value = ${JSON.stringify(LINK)};
    document.querySelector('#message-form').requestSubmit();
    return true;
  `);

  const message = await receiver.waitFor(`
    const row = document.querySelector('#messages .msg');
    return row ? {
      body: row.querySelector('.msg-body').textContent,
      who: row.querySelector('.msg-who').textContent,
      open: row.querySelector('a.btn')?.getAttribute('href') ?? null,
      copyable: Boolean(row.querySelector('.icon-btn')),
    } : false;
  `, 15_000, 'the message to arrive on the other device');

  check('a text message arrives with no accept prompt', () => {
    strictEqual(message.body, LINK, message.body);
    ok(/Sender/.test(message.who), message.who);
  });

  check('an http link is offered to open, and is copyable', () => {
    strictEqual(message.open, LINK, `open href: ${message.open}`);
    ok(message.copyable, 'no copy control on the message');
  });

  // A real drop event on the device row — the same path a person uses.
  await sender.eval(`
    const bytes = new Uint8Array(${FILE_BYTES});
    // A repeating but non-trivial pattern: compressible enough to build quickly,
    // varied enough that a checksum means something.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 11)) & 0xff;
    window.__expected = bytes.length;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'measurement.bin', { type: 'application/octet-stream' }));
    ${peerRow('Receiver')}.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return true;
  `);

  const offered = await receiver.waitFor(
    `[...document.querySelectorAll('#transfers .tx .btn')].some(b => b.textContent === 'Accept')`,
    20_000, 'the accept prompt');
  check('the receiver is asked before a byte is sent', () => ok(offered));

  const offeredName = await receiver.eval(`return document.querySelector('#transfers .tx-title').textContent;`);
  check('the offer names the file and the sender', () => {
    ok(offeredName.includes('measurement.bin'), offeredName);
    ok(offeredName.includes('Sender'), offeredName);
  });

  // A background tab has its timers throttled, so give the sender's own row a
  // moment to render rather than assuming it already has.
  const sentNothingYet = await sender.waitFor(
    `document.querySelector('#transfers .tx-note')?.textContent || false`, 8000, `the sender's status`);
  check('the sender is waiting, not sending', () =>
    ok(/waiting/i.test(sentNothingYet), `note was: ${sentNothingYet}`));

  await receiver.eval(`
    [...document.querySelectorAll('#transfers .tx .btn')].find(b => b.textContent === 'Accept').click();
    return true;
  `);

  // Cancel is a node someone has to be able to press while bytes are moving, and
  // the row it lives in repaints several times a second. Rebuilt on every
  // repaint, it is destroyed between mousedown and mouseup and the click never
  // lands — the button looks broken and nothing explains why. Tag the live node,
  // let several repaints go by, and see whether the tag survived.
  await receiver.waitFor(
    `[...document.querySelectorAll('#transfers .tx .btn')].some(b => b.textContent === 'Cancel')`,
    10_000, 'the Cancel button to appear');

  const cancelNode = await receiver.eval(`
    return (async () => {
      const find = () => [...document.querySelectorAll('#transfers .tx .btn')]
        .find((b) => b.textContent === 'Cancel');
      find().dataset.probe = 'tagged';
      await new Promise((r) => setTimeout(r, 600));
      const after = find();
      if (!after) return 'gone: ' + document.querySelector('#transfers .tx')?.dataset.status;
      return after.dataset.probe === 'tagged' ? 'same node' : 'rebuilt on every repaint';
    })();
  `, { awaitPromise: true });

  check('the Cancel button survives repaints, so it can actually be clicked', () =>
    strictEqual(cancelNode, 'same node'));

  await receiver.waitFor(
    `document.querySelector('#transfers .tx')?.dataset.status === 'done'`, 60_000, 'the receiver to finish');
  await sender.waitFor(
    `document.querySelector('#transfers .tx')?.dataset.status === 'done'`, 20_000, 'the sender to finish');

  const receiverState = await receiver.eval(`
    const row = document.querySelector('#transfers .tx');
    return {
      note: row.querySelector('.tx-note').textContent,
      meta: row.querySelector('.tx-meta').textContent,
      saveLink: row.querySelector('.save-link')?.getAttribute('download') ?? null,
      progress: row.querySelector('.bar-track').style.getPropertyValue('--p'),
    };
  `);
  const senderState = await sender.eval(`
    const row = document.querySelector('#transfers .tx');
    return { note: row.querySelector('.tx-note').textContent, meta: row.querySelector('.tx-meta').textContent };
  `);

  console.log(`\n        receiver: ${receiverState.note}\n        ${receiverState.meta}`);
  console.log(`        sender:   ${senderState.note}\n        ${senderState.meta}\n`);

  check('the file arrives and the checksum agrees', () =>
    ok(receiverState.note.includes('checksum verified'), receiverState.note));

  check('the data path is reported as local', () => {
    ok(/local network/.test(receiverState.note), `receiver: ${receiverState.note}`);
    ok(/local network/.test(senderState.note), `sender: ${senderState.note}`);
  });

  check('the receive tier is the OPFS worker, not memory', () =>
    ok(/OPFS, synchronous worker writes/.test(receiverState.note), receiverState.note));

  check('a negotiated chunk size is reported', () =>
    ok(/\d+ KB chunks/.test(receiverState.note), receiverState.note));

  check('the progress bar completes', () => strictEqual(receiverState.progress, '100%'));

  check('the received file is offered for saving under its own name', () =>
    strictEqual(receiverState.saveLink, 'measurement.bin'));

  check('the transferred size is right', () =>
    ok(receiverState.meta.includes('6.0 MB'), receiverState.meta));

  // The sender's number must come from the receiver's acknowledgements, not from
  // what it handed to the network stack.
  const confirmed = await sender.eval(`
    const meta = document.querySelector('#transfers .tx-meta').textContent;
    return meta;
  `);
  check('the sender reports the confirmed total', () => ok(confirmed.includes('6.0 MB'), confirmed));

  // Identity: each side should have proved possession of its key, bound to this
  // connection's fingerprint.
  const trust = await receiver.eval(`
    const badges = [...document.querySelectorAll('#peers .badge')].map(b => b.textContent);
    return badges;
  `);
  check('the peer is verified against its key', () => {
    ok(trust.includes('verified'), `badges: ${JSON.stringify(trust)}`);
    ok(!trust.includes('key mismatch'), `badges: ${JSON.stringify(trust)}`);
  });

  // The save link's object URL must be minted once and kept. This row is redrawn
  // on every transfer change, so a URL created during render would leak one per
  // repaint, each pinning the whole received file.
  const urlBefore = await receiver.eval(
    `return document.querySelector('#transfers .save-link')?.getAttribute('href') ?? null;`);

  // A second run on the same pair: the device is now remembered, and a reused
  // connection must not need a fresh handshake to work.
  await sender.eval(`
    const bytes = new Uint8Array(256 * 1024);
    bytes.fill(7);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'second.bin', { type: 'application/octet-stream' }));
    ${peerRow('Receiver')}.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return true;
  `);
  await receiver.waitFor(`
    [...document.querySelectorAll('#transfers .tx')].some(row =>
      row.querySelector('.tx-title').textContent.includes('second.bin')
      && [...row.querySelectorAll('.btn')].some(b => b.textContent === 'Accept'))
  `, 15_000, 'a second offer');
  await receiver.eval(`
    const row = [...document.querySelectorAll('#transfers .tx')]
      .find(r => r.querySelector('.tx-title').textContent.includes('second.bin'));
    [...row.querySelectorAll('.btn')].find(b => b.textContent === 'Accept').click();
    return true;
  `);
  const secondDone = await receiver.waitFor(`
    const row = [...document.querySelectorAll('#transfers .tx')]
      .find(r => r.querySelector('.tx-title').textContent.includes('second.bin'));
    return row?.dataset.status === 'done' ? row.querySelector('.tx-note').textContent : false;
  `, 25_000, 'the second transfer');
  check('a second transfer reuses the open connection', () =>
    ok(secondDone.includes('checksum verified'), secondDone));

  const urlAfter = await receiver.eval(`
    const row = [...document.querySelectorAll('#transfers .tx')]
      .find(r => r.querySelector('.tx-title').textContent.includes('measurement.bin'));
    return row?.querySelector('.save-link')?.getAttribute('href') ?? null;
  `);
  check('a save link keeps one object URL across repaints', () => {
    ok(urlBefore, 'there was a save link to begin with');
    strictEqual(urlAfter, urlBefore, 'a new URL per render would leak the file');
  });

  // Room codes: the discovery path that works when address grouping does not.
  const code = await sender.eval(`
    [...document.querySelectorAll('#room-actions .btn')].find(b => b.textContent === 'Create a room code').click();
    return true;
  `) && await sender.waitFor(
    `document.querySelector('#room-code')?.textContent.trim() || false`, 10_000, 'a room code');
  check('creating a room code shows a code and a QR', () => {
    ok(/^[0-9A-Z]{2}-[0-9A-Z]{3}$/.test(code.trim()), `code was ${JSON.stringify(code)}`);
  });

  const qrModules = await sender.eval(`
    const svg = document.querySelector('#qr svg');
    return svg ? { box: svg.getAttribute('viewBox'), path: svg.querySelector('path')?.getAttribute('d')?.length ?? 0 } : null;
  `);
  check('the QR renders as real geometry', () => {
    ok(qrModules, 'no svg produced');
    ok(qrModules.path > 200, `path data was ${qrModules.path} characters`);
  });

  // The receiver was left behind in the network room; joining the code has to
  // bring the two back together.
  const joined = await receiver.eval(`
    const code = ${JSON.stringify(code.replace('-', ''))};
    location.hash = '#/r/' + code;
    return true;
  `) && await receiver.waitFor(
    `document.querySelectorAll('#peers .peer').length >= 1
     && document.querySelector('#room-code')?.textContent.replace('-','').length === 5`,
    12_000, 'the code room to reunite them');
  check('joining by code reunites the devices', () => ok(joined));

  // The device count in the room line comes from the live roster. Taking it from
  // the room size the server sent at join time leaves it stale from the moment
  // somebody arrives — which is precisely when it is read.
  const roomLine = await sender.waitFor(
    `document.querySelector('#room-what')?.textContent.includes('devices in this room')
       ? document.querySelector('#room-what').textContent : false`,
    12_000, 'the room line to count the new arrival');
  check('the room line counts arrivals as they happen', () =>
    ok(roomLine.startsWith('2 devices'), roomLine));

  // The wordmark goes home. It is a real link so it can be opened in a new tab,
  // but a plain click must not reload — a reload would abandon a transfer in
  // flight, which is exactly when someone might click it by accident.
  const home = await receiver.eval(`
    return (async () => {
      const link = document.querySelector('#home-link');
      if (!link) return 'no #home-link in the header';
      if (!link.getAttribute('href')) return 'not a real link';
      window.__stayed = true; // a reload would wipe this
      link.click();
      // Read the address bar before anything can have come back from the server.
      // Waiting for the room change to be confirmed would leave the URL naming a
      // room the user has left — and that is the URL they would copy or reload.
      const immediate = location.hash;
      await new Promise((r) => setTimeout(r, 1500));
      return {
        stayed: window.__stayed === true,
        immediate,
        hash: location.hash,
        room: document.querySelector('#room-what')?.textContent ?? '',
      };
    })();
  `, { awaitPromise: true });

  check('the wordmark returns to the home room without reloading the page', () => {
    ok(typeof home === 'object', String(home));
    ok(home.stayed, 'the page reloaded, which would abandon a running transfer');
    strictEqual(home.immediate, '',
      `the room code should leave the address bar on the click, not when the server replies, got "${home.immediate}"`);
    strictEqual(home.hash, '', `the room code should be off the address bar, got "${home.hash}"`);
    ok(/network address/i.test(home.room), `still in a code room: ${home.room}`);
  });

  // Going home genuinely left the room, so put the receiver back where the rest
  // of the run expects to find it.
  await receiver.eval(`
    location.hash = '#/r/' + ${JSON.stringify(code.replace('-', ''))};
    return true;
  `);
  await receiver.waitFor(
    `document.querySelector('#room-code')?.textContent.replace('-','').length === 5`,
    12_000, 'the receiver to rejoin the code room');

  // ── the measurement §14 asks for ───────────────────────────────────────────
  //
  // Receive the same payload again with storage taken out of the path. If the
  // rate jumps, the disk was the limit; if it does not, the transport is, and no
  // amount of tuning the writer would have helped. Reported rather than asserted
  // — one headless browser talking to itself is not a claim about real hardware,
  // but the *comparison* is valid because only one thing changed.
  await receiver.eval(`
    document.querySelector('#open-settings').click();
    const box = document.querySelector('#set-discard');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    document.querySelector('#settings-dialog').close();
    return true;
  `);

  // Both devices moved rooms a moment ago, and a background tab has its timers
  // throttled, so wait for the row rather than assuming it has repainted.
  await sender.waitFor(`Boolean(${peerRow('Receiver')})`, 15_000, 'the receiver to reappear in the code room');

  await sender.eval(`
    const bytes = new Uint8Array(${FILE_BYTES});
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 11)) & 0xff;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'discard-test.bin', { type: 'application/octet-stream' }));
    ${peerRow('Receiver')}.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return true;
  `);

  const rowFor = (name) => `[...document.querySelectorAll('#transfers .tx')]`
    + `.find(r => r.querySelector('.tx-title').textContent.includes(${JSON.stringify(name)}))`;

  await receiver.waitFor(`
    const row = ${rowFor('discard-test.bin')};
    if (!row) return false;
    const button = [...row.querySelectorAll('.btn')].find(b => b.textContent === 'Accept');
    if (!button) return false;
    button.click();
    return true;
  `, 20_000, 'the discard-mode offer');

  const discardResult = await receiver.waitFor(`
    const row = ${rowFor('discard-test.bin')};
    if (row?.dataset.status !== 'done') return false;
    return row.querySelector('.tx-meta').textContent + ' | ' + row.querySelector('.tx-note').textContent;
  `, 60_000, 'the discard-mode transfer');

  check('a transfer with storage removed from the path still verifies', () =>
    ok(/measurement mode/.test(discardResult), discardResult));

  console.log(`\n        with storage:    ${receiverState.meta}`);
  console.log(`        without storage: ${discardResult.split(' | ')[0]}`);
  console.log('        Only the writer changed, so the difference is the storage cost.\n');

  // Last, because it deliberately strands a tab on its own. An empty device list
  // is where someone whose devices cannot see each other actually sits, so it is
  // the one place the way out has to be written down.
  const emptyState = await receiver.eval(`
    document.querySelector('#room-actions .btn').click();
    return true;
  `) && await receiver.waitFor(`
    const box = document.querySelector('#peers .empty');
    return box && /no other devices/i.test(box.textContent) ? box.textContent : false;
  `, 12_000, 'the empty device list');

  check('an empty device list says what to do about it', () => {
    ok(/hotspot/i.test(emptyState), `no way out offered: ${emptyState}`);
  });

  check('nothing logged an error along the way', () => {
    strictEqual(sender.errors.length, 0, `sender: ${sender.errors.join(' | ')}`);
    strictEqual(receiver.errors.length, 0, `receiver: ${receiver.errors.join(' | ')}`);
  });
} catch (err) {
  failed++;
  console.log(`  FAIL  the run did not complete\n        ${err.message}`);
} finally {
  await cleanup();
}

console.log(`\n${failed ? 'FAILED' : 'passed'}: ${passed} checks ok, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
