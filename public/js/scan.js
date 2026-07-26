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

export const canScan = () =>
  typeof BarcodeDetector === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Watch the camera until a room code appears.
 *
 * @param {HTMLVideoElement} video
 * @param {AbortSignal} signal
 * @returns {Promise<string>} the normalised code
 */
export async function scanForCode(video, signal) {
  if (!canScan()) throw new Error('This browser cannot scan — type the code instead.');

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

    for (;;) {
      if (signal.aborted) throw new Error('aborted');

      let found = [];
      try {
        found = await detector.detect(video);
      } catch {
        // Fires while the first frames are still arriving. Not worth reporting.
      }

      for (const barcode of found) {
        const code = codeFromUrl(barcode.rawValue);
        if (code) return code;
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
