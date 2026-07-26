import { crc32 } from './crc32.js';

// The receive path that has to carry large files on the platforms without a save
// dialog — which is to say, iOS.
//
// `createSyncAccessHandle` exists only inside a worker, and that restriction is
// the whole reason this file exists. The write call is synchronous, so a chunk
// is on its way to storage the instant it arrives, and nothing about disk latency
// reaches the page's main thread. On the main thread the same work becomes an
// awaited promise per chunk, which quietly turns storage latency into the
// transfer's speed limit.
//
// The checksum is folded in here too, on the bytes we already hold, so verifying
// a file costs no extra pass and no main-thread time.

/** @type {FileSystemFileHandle|null} */
let handle = null;
/** @type {FileSystemSyncAccessHandle|null} */
let sync = null;
let offset = 0;
let crc = 0;
let verify = true;

const post = (msg) => self.postMessage(msg);

async function incomingDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('incoming', { create: true });
}

self.onmessage = async (event) => {
  const msg = event.data;

  try {
    switch (msg.t) {
      case 'open': {
        const dir = await incomingDir();
        handle = await dir.getFileHandle(msg.key, { create: true });
        sync = await handle.createSyncAccessHandle();
        // A key can be reused on resume, so never assume the file is empty.
        offset = msg.resumeAt > 0 ? Math.min(msg.resumeAt, sync.getSize()) : 0;
        sync.truncate(offset);
        crc = msg.resumeCrc >>> 0;
        verify = msg.verify !== false;
        post({ t: 'opened', offset });
        return;
      }

      case 'write': {
        if (!sync) throw new Error('no open file');
        const view = new Uint8Array(msg.buf);
        let written = 0;
        // A short write is legal. Looping is the difference between a file that
        // is correct and one that is quietly truncated under memory pressure.
        while (written < view.byteLength) {
          const n = sync.write(view.subarray(written), { at: offset + written });
          if (n <= 0) throw new Error('storage refused the write');
          written += n;
        }
        if (verify) crc = crc32(view, crc);
        offset += written;
        // The sequence number goes back untouched so the page can settle the
        // right queued chunk; without it the byte accounting drifts under load.
        post({ t: 'wrote', seq: msg.seq, bytes: written, offset });
        return;
      }

      case 'close': {
        if (sync) { sync.flush(); sync.close(); sync = null; }
        post({ t: 'closed', offset, crc });
        return;
      }

      case 'abort': {
        if (sync) { try { sync.close(); } catch { /* already closed */ } sync = null; }
        if (msg.remove && handle) {
          const dir = await incomingDir();
          await dir.removeEntry(handle.name).catch(() => {});
        }
        post({ t: 'aborted' });
        return;
      }

      // Files left behind by a tab that was closed mid-transfer. Nothing can be
      // in flight at page load, so anything here is debris.
      case 'sweep': {
        const dir = await incomingDir();
        let removed = 0;
        for await (const name of dir.keys()) {
          if (msg.keep?.includes(name)) continue;
          await dir.removeEntry(name).catch(() => {});
          removed++;
        }
        post({ t: 'swept', removed });
        return;
      }
    }
  } catch (err) {
    post({ t: 'error', message: err?.message ?? String(err) });
  }
};
