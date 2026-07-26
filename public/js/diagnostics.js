import { MIB, fmtBytes, fmtRate } from './util.js';
import { TIER_LABELS, freeStorage, probeCapabilities } from './writers.js';
import { canScan } from './scan.js';
import { settings } from './settings.js';
import { identity, knownDevices } from './identity.js';

// A failure the user cannot explain is indistinguishable from a broken product,
// and the information needed to explain it is already sitting in getStats().
// Not surfacing it is a choice.
//
// This module answers three questions:
//   * what can this device do
//   * what route did this connection actually take
//   * how fast could this device possibly go

export async function capabilityRows() {
  const caps = await probeCapabilities();
  const free = freeStorage(caps);

  const rows = [
    ['Secure context', caps.secureContext ? 'yes' : 'NO — WebRTC is unavailable here',
      caps.secureContext ? '' : 'bad'],
    ['WebRTC', caps.webrtc ? 'available' : 'MISSING', caps.webrtc ? '' : 'bad'],
    ['Save dialog', caps.savePicker ? 'yes' : 'no'],
    ['Folder dialog', caps.directoryPicker ? 'yes' : 'no'],
    ['OPFS', caps.opfs ? (caps.opfsSync ? 'yes, with synchronous writes' : 'yes, async writes only') : 'no',
      caps.opfs ? '' : 'warn'],
    ['Files will land in', TIER_LABELS[bestTier(caps)], bestTier(caps) === 'memory' ? 'warn' : ''],
    ['Browser storage free', free === null ? 'not reported' : `${fmtBytes(free)} of ${fmtBytes(caps.quota)}`],
    ['Service worker', caps.swController ? 'active' : caps.serviceWorker ? 'registered, not yet controlling' : 'no'],
    ['QR scanning', canScan() ? 'yes' : 'no — type the code instead'],
    ['Screen wake lock', caps.wakeLock ? 'yes' : 'no'],
    ['This device', identity.ephemeral
      ? 'no stable key (private browsing?) — devices cannot be remembered'
      : `key ${identity.fingerprint}`, identity.ephemeral ? 'warn' : ''],
    ['Devices remembered', String(knownDevices.count())],
    ['Origin', location.origin],
  ];

  return { caps, rows };
}

/**
 * Which tier a received file would land on *right now* — the thing that decides
 * this device's maximum file size.
 *
 * Takes the save preference into account rather than reporting the best tier the
 * browser could manage. A readout that says "disk" while every transfer actually
 * lands in OPFS is worse than no readout: it is the answer to a question nobody
 * asked.
 */
export function bestTier(caps, preference = settings.get('savePreference')) {
  if (settings.get('discardReceived')) return 'discard';
  if (preference !== 'no-dialog' && (caps.savePicker || caps.directoryPicker)) return 'disk';
  if (caps.opfs && caps.opfsSync) return 'opfs';
  if (caps.opfs) return 'opfs-async';
  if (caps.swController) return 'download';
  return 'memory';
}

/** A compact readout for one peer connection, for the diagnostics list. */
export async function linkSummary(link) {
  const path = await link.describePath();
  const sas = await link.shortAuthString();

  return {
    id: link.id,
    name: link.name,
    state: link.pc.connectionState,
    iceState: link.pc.iceConnectionState,
    polite: link.polite,
    trust: link.trust,
    known: link.known,
    path,
    sas,
    maxMessageSize: link.pc.sctp?.maxMessageSize ?? null,
    log: link.iceLog.slice(-12),
  };
}

// ── the throughput ceiling ───────────────────────────────────────────────────

/**
 * Move data between two peer connections inside this one page.
 *
 * No network, no second device, no Wi-Fi. What comes out is the ceiling imposed
 * by SCTP framing and single-threaded JavaScript on this hardware — the number a
 * real transfer is measured against. If a transfer over Wi-Fi runs at a fifth of
 * this, the link is the problem; if it runs close to it, the code is.
 *
 * Sweeping the chunk size in the same run answers the other question worth
 * asking, which is whether the message size is costing anything.
 *
 * @param {(update: {stage: string, detail?: string}) => void} report
 */
export async function loopbackBenchmark(report = () => {}) {
  const sizes = [16 * 1024, 64 * 1024, 256 * 1024];
  const payload = 24 * MIB;
  const results = [];

  for (const chunkSize of sizes) {
    report({ stage: `measuring ${fmtBytes(chunkSize)} chunks…` });
    try {
      results.push({ chunkSize, ...await runOnce(chunkSize, payload) });
    } catch (err) {
      results.push({ chunkSize, error: err.message });
    }
  }

  const best = results.filter((r) => !r.error).sort((a, b) => b.bytes / b.ms - a.bytes / a.ms)[0];
  return {
    results,
    best,
    summary: best
      ? `Ceiling on this device: ${fmtRate(best.bytes, best.ms)} with ${fmtBytes(best.chunkSize)} chunks.`
      : 'Could not complete the measurement.',
  };
}

async function runOnce(chunkSize, payload) {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });

  try {
    a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate).catch(() => {});
    b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate).catch(() => {});

    let received = 0;
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });

    b.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (event) => {
        received += event.data.byteLength;
        if (received >= payload) finished();
      };
    };

    const channel = a.createDataChannel('bench', { ordered: true });
    channel.bufferedAmountLowThreshold = 1 * MIB;

    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);

    await withTimeout(new Promise((resolve) => {
      if (channel.readyState === 'open') return resolve();
      channel.addEventListener('open', () => resolve(), { once: true });
    }), 10_000, 'the loopback channel never opened');

    // Cap the chunk to whatever this stack will actually carry, the same way a
    // real transfer does, so the numbers are comparable.
    const limit = Math.min(chunkSize, a.sctp?.maxMessageSize || chunkSize);
    const buffer = new Uint8Array(limit);
    crypto.getRandomValues(buffer.subarray(0, Math.min(limit, 65536)));

    const startedAt = performance.now();
    let sent = 0;
    while (sent < payload) {
      if (channel.bufferedAmount > 8 * MIB) {
        await new Promise((resolve) => channel.addEventListener('bufferedamountlow', resolve, { once: true }));
      }
      channel.send(buffer);
      sent += buffer.byteLength;
    }

    await withTimeout(done, 30_000, 'the loopback transfer did not finish');
    return { bytes: received, ms: performance.now() - startedAt, chunkUsed: limit };
  } finally {
    a.close();
    b.close();
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
