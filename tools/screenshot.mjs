// Renders the app in a headless browser and writes a PNG.
//
// Useful when a change is visual: the automated checks assert behaviour and say
// nothing about whether the result is legible. Two tabs, so the device list and a
// finished transfer are both populated rather than empty.
//
//   node tools/screenshot.mjs [outfile] [--light]

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { attachSignaling } from '../src/signaling.js';
import { createRequestHandler } from '../src/http.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outFile = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'roombeam.png';
const dark = !process.argv.includes('--light');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.log('No Chromium-based browser found.');
  process.exit(0);
}

let signaling;
const server = createServer(createRequestHandler({
  roots: { '/': join(ROOT, 'public') }, stats: () => signaling.stats(), startedAt: Date.now(),
}));
signaling = attachSignaling(server, { log: () => {} });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'roombeam-shot-'));
const child = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection',
  '--hide-scrollbars', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const dbg = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('no debugging port')), 20_000);
  child.stderr.on('data', (d) => { buf += d; const m = /ws:\/\/[^\s]+/.exec(buf); if (m) { clearTimeout(t); res(m[0]); } });
});

const ws = new WebSocket(dbg, { maxPayload: 1 << 28 });
await new Promise((r) => ws.once('open', r));
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => { if (pending.delete(n)) rej(new Error(`${method} timed out`)); }, 30_000);
});

async function tab(name, { width, height } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  }, sessionId);
  if (width) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false,
    }, sessionId);
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('roombeam.settings', JSON.stringify({savePreference:'no-dialog',verifyIntegrity:true}));`
      + `localStorage.setItem('roombeam.name', ${JSON.stringify(name)});`,
  }, sessionId);
  await send('Page.navigate', { url: origin }, sessionId);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // Wait for this tab to finish loading before returning, so the caller can open
  // the next one. Both tabs share one localStorage: navigating them concurrently
  // lets the second tab''s injected name overwrite the first before that tab has
  // read its own, and both devices end up with the same name.
  for (let i = 0; i < 100; i++) {
    if (await ev('return document.readyState === "complete" && Boolean(document.querySelector("#myname").value);')) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  return { name, sessionId, ev };
}

const wait = async (t, expr, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await t.ev(`return (${expr});`)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  const state = await t.ev(`return {
    conn: document.querySelector('#conn')?.dataset.state,
    room: document.querySelector('#room-what')?.textContent,
    peers: document.querySelector('#peers')?.textContent,
    visibility: document.visibilityState,
  };`).catch((err) => ({ error: err.message }));
  throw new Error(`timed out on ${t.name}: ${expr}\n  ${JSON.stringify(state)}`);
};

const row = (n) => `[...document.querySelectorAll('#peers .peer')].find(r=>r.querySelector('.nm').textContent===${JSON.stringify(n)})`;

// The receiver is the tab we photograph, so it must be the visible one: a
// background tab has its timers throttled and would not have finished painting.
const sender = await tab('Brass Kettle');
const shot = await tab('Quiet Otter', { width: 860, height: 1180 });

for (const t of [sender, shot]) await wait(t, `document.querySelector('#conn')?.dataset.state === 'open'`);
await wait(sender, `Boolean(${row('Quiet Otter')})`);
await wait(shot, `Boolean(${row('Brass Kettle')})`);

// A room code, so the QR is on screen.
await sender.ev(`[...document.querySelectorAll('#room-actions .btn')].find(b=>b.textContent==='Create a room code').click(); return true;`);
const code = await (async () => {
  await wait(sender, `document.querySelector('#room-code')?.textContent.trim()`);
  return sender.ev(`return document.querySelector('#room-code').textContent.replace('-','');`);
})();
await shot.ev(`location.hash = '#/r/' + ${JSON.stringify(code)}; return true;`);
await wait(shot, `Boolean(${row('Brass Kettle')}) && document.querySelector('#room-share')?.hidden === false`);

// One finished transfer and one awaiting a decision, so both states are visible.
await sender.ev(`
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'holiday-photos.zip', { type: 'application/zip' }));
  ${row('Quiet Otter')}.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
`);
await wait(shot, `[...document.querySelectorAll('#transfers .tx .btn')].some(b=>b.textContent==='Accept')`);
await shot.ev(`[...document.querySelectorAll('#transfers .tx .btn')].find(b=>b.textContent==='Accept').click(); return true;`);
await wait(shot, `document.querySelector('#transfers .tx')?.dataset.status === 'done'`, 40_000);

await sender.ev(`
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(820 * 1024)], 'meeting-notes.pdf', { type: 'application/pdf' }));
  ${row('Quiet Otter')}.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
`);
await wait(shot, `[...document.querySelectorAll('#transfers .tx .btn')].some(b=>b.textContent==='Accept')`);

// Diagnostics open, since explaining itself is half of what this app claims to do.
await shot.ev(`document.querySelector('#diagnostics').open = true; return true;`);
await new Promise((r) => setTimeout(r, 1200));

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, shot.sessionId);
writeFileSync(join(ROOT, outFile), Buffer.from(data, 'base64'));
console.log(`wrote ${outFile} (${dark ? 'dark' : 'light'})`);

ws.close();
child.kill();
signaling.close();
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows locks */ }
process.exit(0);
