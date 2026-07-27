// RoomBeam — static host + signalling relay.
//
// Two jobs, and a hard line between them:
//
//   1. Serve the client. Over HTTPS with a generated certificate when run on a
//      LAN, because WebRTC refuses to run outside a secure context and a LAN IP
//      is not one. Over plain HTTP when something else terminates TLS.
//   2. Introduce peers to each other, then get out of the way.
//
// File contents never pass through this process. Neither do filenames — those
// travel over the encrypted DataChannel precisely so that they cannot be logged
// here.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from './src/http.js';
import { attachSignaling } from './src/signaling.js';
import { listInterfaces } from './src/interfaces.js';
import { loadOrCreateCert } from './src/cert.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8443;
const HOST = process.env.HOST || '0.0.0.0';

// Behind a reverse proxy or a tunnel, TLS is already handled and a second
// certificate here would only get in the way.
const TLS = (process.env.ROOMBEAM_TLS ?? 'on').toLowerCase() !== 'off';
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY ?? '').toLowerCase());

// ICE configuration the browser fetches from /ice-servers.
//
//   STUN lets a device discover its own public address so two peers can often
//   reach each other directly across networks. It is a lookup, not a relay —
//   no file data passes through it.
//
//   TURN is the fallback for when a direct path cannot be punched through a
//   strict or carrier-grade NAT: the two peers relay through it instead. That
//   means file bytes do traverse the TURN server, so it is off unless the host
//   supplies one. Credentials come from the environment, never the repo:
//
//     TURN_URLS        turn:host:3478,turns:host:5349   (comma or space list)
//     TURN_USERNAME    the TURN username
//     TURN_CREDENTIAL  the TURN password
//     STUN_URLS        optional override; defaults to a public STUN server
const splitList = (value) => String(value ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function buildIceServers() {
  const servers = [];
  const stun = splitList(process.env.STUN_URLS);
  servers.push({ urls: stun.length ? stun : ['stun:stun.l.google.com:19302'] });

  const turn = splitList(process.env.TURN_URLS);
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (turn.length && username && credential) {
    servers.push({ urls: turn, username, credential });
  }
  return servers;
}

const iceServers = buildIceServers();
const hasTurn = iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u)));

const startedAt = Date.now();
const interfaces = listInterfaces();
const primary = interfaces[0]?.address ?? '127.0.0.1';

const rule = '─'.repeat(64);
console.log(`\n${rule}\n  RoomBeam — files, straight across\n${rule}`);
console.log(hasTurn
  ? '\n  TURN relay configured — devices on different networks can connect.'
  : '\n  No TURN relay — cross-network transfers work only when a direct path exists.');

let signaling;
const handler = createRequestHandler({
  // public/shared holds the modules the server and the browser must agree on
  // exactly — room-code rules and text sanitisation. Both import the same file,
  // which is the only way to be certain they cannot drift apart.
  roots: { '/': join(ROOT, 'public') },
  stats: () => signaling?.stats() ?? { rooms: 0, peers: 0 },
  startedAt,
  iceServers,
});

const server = TLS
  ? createHttpsServer(loadOrCreateCert(join(ROOT, 'certs'), interfaces), handler)
  : createHttpServer(handler);

signaling = attachSignaling(server, { trustProxy: TRUST_PROXY });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either stop the other process, or run:  PORT=8444 npm start\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  Not allowed to bind port ${PORT}. Ports below 1024 need elevation.\n`);
  } else {
    console.error(`\n  ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const scheme = TLS ? 'https' : 'http';

  if (!TLS) {
    console.log(`\n  Listening on ${scheme}://${HOST}:${PORT}  (TLS disabled — expecting a proxy in front)`);
    console.log('\n  Reminder: the client needs a secure context. Serve it over HTTPS,');
    console.log('  or WebRTC will be unavailable and the failure will not say why.');
    console.log(`\n  Health check:  ${scheme}://localhost:${PORT}/health\n${rule}\n`);
    return;
  }

  console.log(`\n  This computer:   ${scheme}://localhost:${PORT}`);
  console.log(`  Other devices:   ${scheme}://${primary}:${PORT}\n`);

  if (interfaces.length > 1) {
    console.log('  Other network interfaces found — try these if the above does not load:');
    for (const i of interfaces.slice(1)) {
      console.log(`    ${scheme}://${i.address}:${PORT}   (${i.name})`);
    }
    console.log('');
  }

  console.log(rule);
  console.log('  The certificate is self-signed, so every device objects once:');
  console.log('');
  console.log('    iOS / macOS Safari   Show Details → visit this website');
  console.log('    Android / Windows    Advanced → Proceed');
  console.log('');
  console.log('  On Windows, allow the firewall prompt on private networks, or');
  console.log('  the phone will simply time out with no explanation.');
  console.log(`${rule}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  Shutting down. In-flight transfers are unaffected — once a');
    console.log('  DataChannel is open this process is no longer in the path.\n');
    signaling.close();
    server.close(() => process.exit(0));
    // A lingering keepalive socket should not hold the process open.
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
