import { $, coalesce } from './util.js';
import { normalizeCode } from '../shared/code.js';
import { identity, knownDevices, warmFingerprints } from './identity.js';
import { settings } from './settings.js';
import { Signaling } from './signaling.js';
import { PeerNetwork } from './peer.js';
import { TransferManager, isTerminal } from './transfer.js';
import { UI } from './ui.js';
import { canScan, codeFromUrl, probeScanner, scanForCode } from './scan.js';
import { capabilityRows, linkSummary, loopbackBenchmark } from './diagnostics.js';
import { probeSyncAccess, sweepOpfs } from './writers.js';

// Wiring, and nothing else. Every decision this file makes is about which module
// to hand something to.

// A STUN-only fallback, used until /ice-servers answers (and if it never does).
// The server's list normally replaces this and may add a TURN relay.
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
let configuredIce = FALLBACK_ICE;
const iceServers = () => (settings.get('useStun') ? configuredIce : []);

/**
 * Ask the server which ICE servers to use. This is where a configured TURN
 * relay arrives, so that two devices on different networks can connect when no
 * direct path can be punched through. Falls back silently to STUN-only.
 */
async function loadIceServers() {
  try {
    const res = await fetch('/ice-servers', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      configuredIce = data.iceServers;
      network.setIceServers(iceServers());
    }
  } catch { /* keep the STUN-only fallback */ }
}

// pendingTarget holds the id of the device a picked file is destined for, or
// this sentinel to mean "every device in the room".
const ALL = Symbol('send-to-all');
let pendingTarget = null;

const signaling = new Signaling(() => ({ name: identity.name, pubkey: identity.publicKey }));
const network = new PeerNetwork(signaling, iceServers());
const transfers = new TransferManager(network);

const ui = new UI({
  pickFilesFor: (peerId) => { pendingTarget = peerId; $('#picker').click(); },
  sendFiles: (peerId, files) => startSend(peerId, files),
  accept: (transfer) => transfers.accept(transfer),
  decline: (transfer) => transfers.decline(transfer),
  cancel: (transfer) => transfers.cancel(transfer),
  savedFile: (item) => transfers.release(item),
  newRoom: () => signaling.joinRoom('new'),
  openJoin: () => openDialog('#join-dialog', () => $('#join-code').focus()),
  openScan: () => startScan(),
});

// ── render loop ──────────────────────────────────────────────────────────────

let roomProblem = '';

const paintRoom = () => ui.renderRoom(signaling.room, {
  canScan: canScan(),
  // Count devices, not connections, so a reconnected phone or a second tab does
  // not inflate the total the way it used to show a duplicate row.
  others: network.distinctPeers().length,
  problem: roomProblem,
});

const paintPeers = coalesce(async () => {
  const peers = network.distinctPeers();
  // Fingerprints have to be hashed before they can be shown, and rendering is
  // synchronous — so resolve them first, then draw once with the real labels.
  await warmFingerprints(peers.map((peer) => peer.pubkey));
  ui.renderPeers(peers, network.links);
  // The room line carries a device count, so it is only correct if it is redrawn
  // whenever the roster is.
  paintRoom();
});
// Coalesced for the same reason the roster is: this redraws every transfer row,
// and it is driven by progress arriving from the network. Rendering straight off
// that puts layout work directly in the path of the bytes.
const paintTransfers = coalesce(() =>
  ui.renderTransfers([...transfers.outgoing.values(), ...transfers.incoming.values()]));

network.on('roster', paintPeers);
network.on('link', (link) => {
  link.on('info', paintPeers);
  link.on('trust', (trust) => {
    paintPeers();
    if (trust === 'mismatch') {
      ui.toast(`${link.name} presented a key that does not match this connection. Compare the check code in Diagnostics before sending anything.`, 'bad');
    }
  });
  // The route label belongs on the device row, not only on a transfer, so it is
  // visible before anyone commits to sending something.
  link.on('state', (state) => {
    // The link remembers the route and emits 'info', which is already wired to a
    // repaint above — so this does not need to know what came back.
    if (state === 'connected') link.refreshPath({ retries: 12 });
    refreshDiagnostics();
  });
  refreshDiagnostics();
});

transfers.on('change', paintTransfers);
transfers.on('offer', (transfer) => {
  const count = transfer.items.length;
  ui.toast(`${transfer.link.name} wants to send ${count === 1 ? transfer.items[0].name : `${count} files`}.`);
});

// ── signalling ───────────────────────────────────────────────────────────────

signaling.on('status', (state, detail) => ui.setConnection(state, detail));
signaling.on('room', (room) => {
  roomProblem = '';
  paintRoom();
  // Keep the address bar in step so the page can be reloaded or shared.
  const target = room.kind === 'code' ? `#/r/${room.code}` : '';
  if (location.hash !== target) history.replaceState(null, '', `${location.pathname}${target}`);
  paintPeers();
});

signaling.on('server-error', (code, message) => {
  ui.toast(message, code === 'rate' || code === 'too-many' ? 'bad' : 'warn');
  if (code === 'bad-code') showJoinError(message);
  // If the refusal left us with no room at all, a toast that fades is not enough
  // — the panel would otherwise read "Connecting…" indefinitely.
  if (!signaling.room && (code === 'room-full' || code === 'busy' || code === 'too-many')) {
    roomProblem = message;
    paintRoom();
  }
});

// ── sending ──────────────────────────────────────────────────────────────────

$('#picker').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = ''; // so choosing the same file twice still fires
  if (files.length) {
    if (pendingTarget === ALL) startSendAll(files);
    else if (pendingTarget) startSend(pendingTarget, files);
  }
  pendingTarget = null;
});

$('#send-all').addEventListener('click', () => { pendingTarget = ALL; $('#picker').click(); });

async function startSend(peerId, files) {
  const link = network.linkTo(peerId);
  if (!link) {
    ui.toast('Not connected to the signalling server yet — try again in a moment.', 'warn');
    return;
  }
  await transfers.send(link, files);
}

/**
 * Offer the same files to every device in the room at once. There is no
 * broadcast on the wire — each device gets its own direct transfer it accepts
 * for itself — so this is exactly the per-device send, fanned out. distinctPeers
 * collapses a reconnected phone or a second tab, so nobody is offered it twice.
 */
function startSendAll(files) {
  const peers = network.distinctPeers();
  if (!peers.length) {
    ui.toast('No other devices in the room to send to yet.', 'warn');
    return;
  }
  // Kicked off together rather than awaited in turn, so one slow handshake does
  // not hold up the others.
  for (const peer of peers) startSend(peer.id, files);
  ui.toast(`Offering to ${peers.length} device${peers.length === 1 ? '' : 's'} — each one accepts for itself.`);
}

// ── name ─────────────────────────────────────────────────────────────────────

const nameInput = $('#myname');
nameInput.value = identity.name;
nameInput.addEventListener('change', () => {
  if (identity.rename(nameInput.value)) signaling.rename(identity.name);
  nameInput.value = identity.name; // reflect the sanitised form back
});

// ── dialogs ──────────────────────────────────────────────────────────────────

function openDialog(selector, after) {
  const dialog = $(selector);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
  after?.();
  return dialog;
}

function closeDialog(selector) {
  const dialog = $(selector);
  if (dialog.close) dialog.close();
  else dialog.removeAttribute('open');
}

const showJoinError = (message) => {
  const node = $('#join-error');
  node.textContent = message;
  node.hidden = !message;
};

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = normalizeCode($('#join-code').value);
  if (!code) {
    showJoinError('That is not a five-character room code.');
    return;
  }
  showJoinError('');
  $('#join-code').value = '';
  closeDialog('#join-dialog');
  signaling.joinRoom('code', code);
});
$('#join-cancel').addEventListener('click', () => { showJoinError(''); closeDialog('#join-dialog'); });

$('#copy-link').addEventListener('click', async () => {
  const url = ui.roomUrl(signaling.room?.code ?? '');
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('Link copied.');
  } catch {
    ui.toast(url); // clipboard access refused — showing it is the next best thing
  }
});

/**
 * Back to the room this device would have found on its own.
 *
 * The address bar is cleared here rather than left to the `room` handler that
 * normally keeps it in step. That handler only runs once the server has
 * confirmed the change, and `joinRoom` does nothing but record an intent while
 * signalling is down — so the URL would go on naming a room the user has just
 * left, which is also the URL they would copy, bookmark or reload into.
 */
function goHome() {
  if (location.hash) history.replaceState(null, '', location.pathname);
  signaling.joinRoom('network');
}

$('#leave-room').addEventListener('click', goHome);

// The wordmark is a real link, so it can be opened in a new tab or copied. A
// plain click navigates in place instead: reloading the page would abandon a
// transfer that is in flight, and leaving the room does not — the connection to
// a peer outlives the room it was made in.
$('#home-link').addEventListener('click', (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  goHome();
});

// ── QR scanning ──────────────────────────────────────────────────────────────

let scanAbort = null;

async function startScan() {
  scanAbort?.abort();
  scanAbort = new AbortController();
  const status = $('#scan-status');
  status.textContent = 'Point the camera at the code on the other device.';
  openDialog('#scan-dialog');

  try {
    const code = await scanForCode($('#scan-video'), scanAbort.signal, (text) => {
      status.textContent = text;
    });
    closeDialog('#scan-dialog');
    signaling.joinRoom('code', code);
    ui.toast(`Joining ${code}.`);
  } catch (err) {
    if (err.message === 'aborted') return;
    status.textContent = err.message;
  }
}

$('#scan-cancel').addEventListener('click', () => {
  scanAbort?.abort();
  closeDialog('#scan-dialog');
});

// ── settings ─────────────────────────────────────────────────────────────────

const SETTING_CHECKBOXES = {
  '#set-verify': 'verifyIntegrity',
  '#set-local-only': 'requireLocalRoute',
  '#set-stun': 'useStun',
  '#set-awake': 'keepAwake',
  '#set-background': 'backgroundKeepalive',
  '#set-discard': 'discardReceived',
};

for (const [selector, key] of Object.entries(SETTING_CHECKBOXES)) {
  const input = $(selector);
  input.checked = settings.get(key);
  input.addEventListener('change', () => settings.set(key, input.checked));
}

$('#set-nodialog').checked = settings.get('savePreference') === 'no-dialog';
$('#set-nodialog').addEventListener('change', (event) => {
  settings.set('savePreference', event.target.checked ? 'no-dialog' : 'auto');
});

$('#set-chunk').value = String(settings.get('chunkSizeOverride'));
$('#set-chunk').addEventListener('change', (event) => {
  settings.set('chunkSizeOverride', Number(event.target.value) || 0);
});

$('#open-settings').addEventListener('click', () => openDialog('#settings-dialog'));

$('#forget-devices').addEventListener('click', () => {
  knownDevices.forgetAll();
  for (const link of network.links.values()) link.known = false;
  paintPeers();
  refreshDiagnostics();
  ui.toast('Forgot every remembered device.');
});

settings.on('change:useStun', () => {
  network.setIceServers(iceServers());
  ui.toast('Applies to the next connection. Reload to apply it to existing ones.');
});
settings.on('change:discardReceived', (on) => {
  if (on) ui.toast('Measurement mode: received files will be counted and thrown away.', 'warn');
});

$('#clear-done').addEventListener('click', () => {
  for (const map of [transfers.outgoing, transfers.incoming]) {
    for (const [id, transfer] of map) if (isTerminal(transfer.status)) map.delete(id);
  }
  paintTransfers();
});

// ── diagnostics ──────────────────────────────────────────────────────────────

const refreshDiagnostics = coalesce(async () => {
  if (!$('#diagnostics').open) return;
  const { rows } = await capabilityRows();
  ui.renderCapabilities(rows);
  ui.renderLinks(await Promise.all([...network.links.values()].map(linkSummary)));
});

$('#diagnostics').addEventListener('toggle', () => refreshDiagnostics());

$('#run-bench').addEventListener('click', async () => {
  const button = $('#run-bench');
  const out = $('#bench-out');
  button.disabled = true;
  try {
    const { summary, results } = await loopbackBenchmark(({ stage }) => { out.textContent = stage; });
    out.textContent = `${summary} ${results
      .map((r) => (r.error ? `${r.chunkSize / 1024}K: failed` : `${r.chunkSize / 1024}K: ${(r.bytes / 1048576 / (r.ms / 1000)).toFixed(0)} MB/s`))
      .join(' · ')}`;
  } catch (err) {
    out.textContent = `Could not measure: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

// ── service worker ───────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  // Registration is deliberately not awaited before anything else starts. It
  // buys an offline app shell and one receive tier; nothing depends on it.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── start ────────────────────────────────────────────────────────────────────

async function start() {
  await identity.load();
  nameInput.value = identity.name;

  // Debris from a tab that was closed mid-transfer. Nothing can be in flight
  // yet, so anything sitting in OPFS is dead weight against the storage quota.
  sweepOpfs().then(async (removed) => {
    if (removed) console.info(`cleared ${removed} leftover file(s) from a previous session`);
    // Settles which receive tier this device really has, so Diagnostics can state
    // it rather than guess. Only the diagnostics readout waits on this; a transfer
    // starting sooner just tries the fast path and falls back.
    await probeSyncAccess();
    refreshDiagnostics();
  });

  // Whether this device can decode a QR is not knowable from the interface being
  // present, so it is settled before the first paint decides to offer the button.
  probeScanner().then(paintRoom);

  // Learn the ICE servers (including any TURN relay) before the first
  // connection forms, so a cross-network peer has a relay to fall back on from
  // the start rather than after a reconnect.
  await loadIceServers();

  // A room code in the URL is how a QR scan and a shared link both arrive.
  const fromUrl = codeFromUrl(location.hash);
  if (fromUrl) signaling.joinRoom('code', fromUrl);

  signaling.connect(true);

  if (!window.isSecureContext) {
    ui.toast('This page is not in a secure context, so WebRTC is unavailable. It needs HTTPS or localhost.', 'bad');
  }

  paintRoom();
  paintPeers();
  paintTransfers();
}

// Following a link to a different room in an already-open tab.
addEventListener('hashchange', () => {
  const code = codeFromUrl(location.hash);
  if (code && code !== signaling.room?.code) signaling.joinRoom('code', code);
});

start();
