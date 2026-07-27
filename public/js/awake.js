import { settings } from './settings.js';

// Keeping a transfer running when nobody is looking at it.
//
// Two different problems, two partial remedies, and it is worth being exact
// about which covers what — because "it keeps going in the background" is not
// something a web page can simply be granted.
//
//   screen off      A screen wake lock, which transfer.js holds. The platform
//                   releases it the moment the page is hidden and refuses to
//                   grant one while it is. So it covers "left on screen and
//                   walked away" — not a locked phone, and not another app.
//
//   another app     Nothing in the platform offers this outright. What does keep
//                   a page running is audio: a tab producing sound is exempt
//                   from the freezing and timer throttling that otherwise
//                   suspend a backgrounded page. It is why a web music player
//                   carries on when you leave it, and holding a near-silent loop
//                   open for the length of a transfer borrows that exemption.
//
// The second is a real cost rather than a free trick. Android shows a media
// notification while it runs, and it may take audio focus from whatever else is
// playing. So it is off unless asked for, and it stops with the last transfer.
//
// It is also the least certain thing in this codebase. What counts as "playing
// audio" is a heuristic, it is not specified anywhere, and it differs between
// Chrome, Safari and Android WebView. iOS suspends a backgrounded tab regardless
// and no arrangement of audio changes that. Resume is what actually makes a
// transfer survive being left alone; this only tries to make resuming
// unnecessary.

/** ~-72 dBFS: inaudible in practice, but not digital silence. A tab emitting
 *  nothing measurable is not "playing audio" as far as the platform is
 *  concerned, and the exemption is the entire point. */
const AMPLITUDE = 8;
const SAMPLE_RATE = 8000;

let audio = null;
let sourceUrl = null;

/** A one-second mono PCM loop, built here rather than shipped as an asset. */
function buildLoop() {
  const samples = SAMPLE_RATE;
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // format: uncompressed
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Alternating rather than constant, so it is a signal and not a DC offset that
  // a resampler would flatten back to silence.
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, i % 2 ? AMPLITUDE : -AMPLITUDE, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

/**
 * Ask the page to keep running while it is in the background.
 *
 * Idempotent rather than reference counted. The caller already knows whether
 * anything is in flight and asks on that basis, several times over the life of
 * one transfer — counting those calls would need a matching release for each,
 * and a single missed one would leave the loop playing for the rest of the
 * session.
 */
export function holdBackground() {
  if (!settings.get('backgroundKeepalive') || audio) return;

  try {
    sourceUrl = buildLoop();
    audio = new Audio(sourceUrl);
    audio.loop = true;
    // Accepting or sending is a user gesture, which is what buys the right to
    // play at all. If that has expired the play is simply refused, and the
    // transfer carries on without the exemption.
    audio.play().catch(() => {});
  } catch {
    audio = null; // no audio support here; nothing else to try
  }
}

/** Stop. Called when nothing is in flight any more. */
export function releaseBackground() {
  if (!audio) return;
  try { audio.pause(); } catch { /* already gone */ }
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  audio = null;
  sourceUrl = null;
}

/** For diagnostics: whether the loop is actually running right now. */
export const holdingBackground = () => Boolean(audio) && !audio.paused;
