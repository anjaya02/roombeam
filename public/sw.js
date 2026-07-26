// Two jobs.
//
//  1. Keep an offline app shell so the page opens instantly and survives a flaky
//     network on the way in.
//
//  2. Serve a streaming download. This is the receive tier for browsers with no
//     save dialog and no OPFS: the page pushes chunks through a MessagePort, this
//     worker answers a hidden request with a streaming Response, and the browser
//     writes it straight into Downloads. The file is never held in memory and
//     never counted against the storage quota.
//
// The version string is the cache name. Bumping it is what retires an old shell.

const VERSION = 'roombeam-v4';

const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/main.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/settings.js',
  '/js/identity.js',
  '/js/signaling.js',
  '/js/peer.js',
  '/js/protocol.js',
  '/js/transfer.js',
  '/js/writers.js',
  '/js/opfs-worker.js',
  '/js/crc-worker.js',
  '/js/crc32.js',
  '/js/qr.js',
  '/js/scan.js',
  '/js/diagnostics.js',
  '/shared/code.js',
  '/shared/text.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== VERSION) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// ── streaming downloads ──────────────────────────────────────────────────────

/** @type {Map<string, { name: string, size: number, stream: ReadableStream, opened: number }>} */
const downloads = new Map();
const DOWNLOAD_TTL = 60_000;

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.t !== 'download-open') return;

  const port = event.ports[0];
  if (!port) return;

  // Anything the page registered and never collected.
  const now = Date.now();
  for (const [id, entry] of downloads) {
    if (now - entry.opened > DOWNLOAD_TTL) downloads.delete(id);
  }

  let controller;
  const waitingAcks = [];

  const releaseAcks = () => {
    // Only acknowledge while the consumer still wants data. Holding the ack back
    // is the backpressure: without it the page would push a whole file into this
    // worker's queue as fast as the network delivered it.
    while (waitingAcks.length && controller.desiredSize > 0) {
      waitingAcks.shift();
      port.postMessage({ t: 'wrote' });
    }
  };

  const stream = new ReadableStream({
    start(c) { controller = c; },
    pull() { releaseAcks(); },
    cancel() { downloads.delete(msg.id); },
  }, { highWaterMark: 16, size: () => 1 });

  port.onmessage = ({ data }) => {
    try {
      if (data.t === 'chunk') {
        controller.enqueue(new Uint8Array(data.buf));
        waitingAcks.push(true);
        releaseAcks();
      } else if (data.t === 'end') {
        controller.close();
      } else if (data.t === 'abort') {
        controller.error(new Error('cancelled'));
        downloads.delete(msg.id);
      }
    } catch (err) {
      port.postMessage({ t: 'error', message: err.message });
    }
  };

  downloads.set(msg.id, {
    name: typeof msg.name === 'string' ? msg.name : 'download',
    size: Number.isSafeInteger(msg.size) ? msg.size : null,
    stream,
    opened: Date.now(),
  });

  port.postMessage({ t: 'ready' });
});

/** Both forms, because the plain one is what old clients read and the encoded
 *  one is the only one that survives a non-ASCII filename. */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ── fetch ────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/-/dl/')) {
    const id = url.pathname.slice('/-/dl/'.length);
    event.respondWith(respondWithDownload(id));
    return;
  }

  // Never cache the health endpoint; a stale "ok" is worse than no answer.
  if (url.pathname === '/health') return;

  event.respondWith(networkFirst(request));
});

function respondWithDownload(id) {
  const entry = downloads.get(id);
  if (!entry) {
    return new Response('This download is no longer available.', { status: 410 });
  }
  downloads.delete(id); // one request per registration

  const headers = {
    'content-type': 'application/octet-stream',
    'content-disposition': contentDisposition(entry.name),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (entry.size !== null) headers['content-length'] = String(entry.size);

  return new Response(entry.stream, { headers });
}

/**
 * Network first, cache as the fallback.
 *
 * The other way round would be faster on a warm load and is the usual advice,
 * but there is no build step here and therefore no content-hashed filenames — so
 * a cached module could outlive the peer it has to speak the same protocol as.
 * A stale client and a fresh one failing to understand each other is not a bug
 * anybody could diagnose from the outside.
 */
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline, and this is not in the cache.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
