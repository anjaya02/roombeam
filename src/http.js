import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Nothing here is loaded from anywhere but this origin, so say so. The
// interesting directive is connect-src: it is the mechanism behind the privacy
// claim on the signalling side, because it means this page cannot phone home to
// a third party even if a future edit tried to.
//
// blob: appears in worker-src (the OPFS writer and the checksum worker) and in
// img-src (received image previews). data: is needed for the manifest icons.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

/**
 * Static files plus /health. Deliberately not a framework: the whole surface is
 * "read a file from one of two directories, or answer a health probe".
 *
 * @param {{ roots: Record<string, string>, stats: () => object, startedAt: number }} opts
 *   roots maps a URL prefix to a directory. Longest prefix wins.
 */
export function createRequestHandler({ roots, stats, startedAt }) {
  const mounts = Object.entries(roots).sort((a, b) => b[0].length - a[0].length);

  return function handle(req, res) {
    const finish = (status, headers, body) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      if (req.method === 'HEAD' || body === undefined) res.end();
      else res.end(body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return finish(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }, 'Method not allowed');
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return finish(400, { 'content-type': 'text/plain' }, 'Bad request');
    }

    // A self-check for whoever is hosting this. A reverse proxy that forwards
    // HTTP but not the WebSocket upgrade breaks discovery while the page itself
    // loads perfectly, which is a genuinely baffling way to be broken; this
    // gives a deploy something to point at.
    if (pathname === '/health') {
      const body = JSON.stringify({
        ok: true,
        service: 'roombeam-signaling',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        ...stats(),
      });
      return finish(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }, body);
    }

    const mount = mounts.find(([prefix]) => pathname === prefix || pathname.startsWith(prefix));
    if (!mount) return finish(404, { 'content-type': 'text/plain' }, 'Not found');

    const [prefix, dir] = mount;
    let rel = pathname.slice(prefix.length).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    // normalize() first, then confirm the result is still inside the mount.
    // Checking the raw path for '..' instead would miss encoded variants.
    const file = normalize(join(dir, rel));
    if (file !== dir && !file.startsWith(dir + sep)) {
      return finish(403, { 'content-type': 'text/plain' }, 'Forbidden');
    }

    let info;
    try {
      info = statSync(file);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      return finish(404, { 'content-type': 'text/plain' }, 'Not found');
    }

    // No build step means no content-hashed filenames, so every response
    // revalidates. An ETag makes that a 304 rather than a re-download, and it
    // guarantees a device never runs a stale client against a newer peer —
    // which would show up as a protocol mismatch nobody could explain.
    const etag = `"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      return finish(304, { etag, 'cache-control': 'no-cache' });
    }

    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'cache-control': 'no-cache',
      etag,
    };

    if (req.method === 'HEAD') return finish(200, headers);

    res.writeHead(200, { ...SECURITY_HEADERS, ...headers });
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };
}
