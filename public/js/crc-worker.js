import { crc32 } from './crc32.js';

// Checksums the file being sent, independently of the send loop.
//
// A File survives structured clone, so this worker reads the bytes itself rather
// than being handed copies of every chunk. The send loop and the checksum then
// run on different threads over the same file, and verification costs the
// transfer nothing — which matters, because a checksum computed on the main
// thread competes directly with the loop feeding the network.

self.onmessage = async (event) => {
  const { file, from = 0 } = event.data;

  try {
    const source = from > 0 ? file.slice(from) : file;
    let crc = 0;

    if (typeof source.stream === 'function') {
      const reader = source.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32(value, crc);
      }
    } else {
      // Older Safari has no Blob.stream(). Read in slices instead of calling
      // arrayBuffer() on the whole file, which would be an instant crash on a
      // phone for anything large.
      const STEP = 4 * 1024 * 1024;
      for (let at = 0; at < source.size; at += STEP) {
        crc = crc32(await source.slice(at, at + STEP).arrayBuffer(), crc);
      }
    }

    self.postMessage({ t: 'crc', crc });
  } catch (err) {
    self.postMessage({ t: 'error', message: err?.message ?? String(err) });
  }
};
