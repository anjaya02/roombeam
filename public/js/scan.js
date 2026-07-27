import { normalizeCode } from '../shared/code.js';

// Reading a room code from a QR code with the camera.
//
// A bonus, not a requirement. `BarcodeDetector` is a Chromium feature; Safari
// does not have it, and shipping a QR *decoder* to cover that would be a large
// amount of code for a path iOS users do not need — the system camera already
// scans a QR and opens the link, which is the same journey with fewer steps.
//
// So: use the detector where it exists, and everywhere else the five-character
// code is short enough to type. Displaying the QR is the part that has to work
// on every device, and that is the encoder's job, not this file's.
//
// The one thing this file must never do is fail quietly. On Android the
// constructor is not the capability: `BarcodeDetector` exists on every recent
// Chrome, but the decoding itself is a Play Services module that may not be
// installed, in which case `detect()` rejects on every single frame. Swallowing
// those rejections leaves the camera running against a code it is never going to
// read, with nothing on screen to say so — a live preview is very convincing
// evidence that a scanner is working.

/** null until probed; then true/false. Cached — the probe hits Play Services. */
let qrSupported = null;

const hasApi = () =>
  typeof BarcodeDetector === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Ask the platform whether it can actually decode a QR code, not merely whether
 * it exposes the interface. Safe to call repeatedly; the answer is cached.
 * @returns {Promise<boolean>}
 */
export async function probeScanner() {
  if (qrSupported !== null) return qrSupported;
  if (!hasApi()) return (qrSupported = false);
  try {
    const formats = await BarcodeDetector.getSupportedFormats();
    qrSupported = Array.isArray(formats) && formats.includes('qr_code');
  } catch {
    qrSupported = false;
  }
  return qrSupported;
}

/** Synchronous, for rendering. Optimistic until `probeScanner` has answered. */
export const canScan = () => hasApi() && qrSupported !== false;

/**
 * Watch the camera until a room code appears.
 *
 * @param {HTMLVideoElement} video
 * @param {AbortSignal} signal
 * @param {(note: string) => void} [note] progress for the status line
 * @returns {Promise<string>} the normalised code
 */
export async function scanForCode(video, signal, note = () => {}) {
  if (!hasApi()) throw new Error('This browser cannot scan — type the code instead.');
  if (!(await probeScanner())) {
    throw new Error('This device has no QR decoder installed, so scanning is unavailable. Type the code instead.');
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let stream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? 'Camera access was refused. Type the code instead.'
      : 'No usable camera found. Type the code instead.');
  }

  video.srcObject = stream;
  video.setAttribute('playsinline', ''); // iOS goes fullscreen without this
  video.muted = true;

  const stop = () => {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  try {
    await video.play().catch(() => {});

    // Detecting against a video with no frame yet throws, and those throws are
    // indistinguishable from the ones that mean the decoder is broken. Waiting
    // for the first frame keeps the two apart.
    if (video.readyState < 2) {
      note('Starting the camera…');
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener('loadeddata', done); resolve(); };
        video.addEventListener('loadeddata', done);
        setTimeout(done, 3000);
      });
    }
    note('Point the camera at the code on the other device.');

    // A decoder that is missing rather than merely warming up fails on every
    // frame, forever. Counting consecutive failures tells them apart without
    // needing to know which platform we are on.
    let consecutiveErrors = 0;
    let lastError = '';

    for (;;) {
      if (signal.aborted) throw new Error('aborted');

      let found = null;
      try {
        found = await detector.detect(video);
        consecutiveErrors = 0;
      } catch (err) {
        lastError = err?.message ?? String(err);
        // Roughly three seconds of nothing but failures. The first few are
        // routine while the pipeline settles; twenty-five in a row are not.
        if (++consecutiveErrors >= 25) {
          throw new Error(`This device could not run the QR decoder (${lastError}). Type the code instead.`);
        }
      }

      for (const barcode of found ?? []) {
        const code = codeFromUrl(barcode.rawValue);
        if (code) return code;
        // Something was read and it was not one of ours. Saying so beats a
        // preview that looks identical to not having scanned anything at all.
        note('That QR code is not a RoomBeam room link.');
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } finally {
    stop();
  }
}

/**
 * Pull a room code out of whatever the QR contained — our own URL, someone
 * else's deployment of the same app, or a bare code.
 */
export function codeFromUrl(text) {
  if (typeof text !== 'string') return null;

  const direct = normalizeCode(text);
  if (direct) return direct;

  // The code lives in the fragment, so it never reaches a server log. Accept the
  // query form too, in case a deployment ends up rewriting the URL.
  const match = /[#?/]r[/=]([0-9a-zA-Z-]{5,8})/.exec(text);
  return match ? normalizeCode(match[1]) : null;
}
