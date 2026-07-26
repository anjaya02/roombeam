// M1 signaling + static server.
//
// Two jobs, nothing more:
//   1. Serve public/ over HTTPS. WebRTC refuses to run in a non-secure context,
//      and a LAN IP is not a secure context, so plain HTTP would fail on the
//      phone with an unhelpful error. Self-signed cert, generated on first run.
//   2. Relay signalling messages between peers. Never sees file data.
//
// Single global room. Everyone who connects sees everyone else. Room codes
// arrive in M2.

import { createServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';

const PORT = Number(process.env.PORT) || 8443;
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CERT_DIR = join(ROOT, 'certs');

// ---------------------------------------------------------------- LAN address

function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Prefer real Wi-Fi/Ethernet over virtual adapters (VirtualBox, WSL,
      // Hyper-V, VPNs) which are almost never the interface the phone is on.
      const virtual = /virtual|vmware|vbox|hyper-v|wsl|loopback|docker|tailscale|zerotier/i.test(name);
      candidates.push({ name, address: a.address, virtual });
    }
  }
  candidates.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return candidates;
}

const interfaces = lanAddress();
const primary = interfaces[0]?.address ?? '127.0.0.1';

// ----------------------------------------------------------------- TLS certs

function loadOrCreateCert() {
  const keyPath = join(CERT_DIR, 'key.pem');
  const certPath = join(CERT_DIR, 'cert.pem');
  const metaPath = join(CERT_DIR, 'issued-for.txt');

  // Regenerate if the LAN IP changed, otherwise the SAN won't match and some
  // browsers get stricter than a simple "proceed anyway".
  const issuedFor = existsSync(metaPath) ? readFileSync(metaPath, 'utf8').trim() : null;

  if (existsSync(keyPath) && existsSync(certPath) && issuedFor === primary) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  console.log('Generating self-signed certificate...');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...interfaces.map((i) => ({ type: 7, ip: i.address })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: primary }], {
    days: 365,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  mkdirSync(CERT_DIR, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  writeFileSync(metaPath, primary);
  return { key: pems.private, cert: pems.cert };
}

// -------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(loadOrCreateCert(), (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));

  // Reject traversal outright rather than trying to sanitize it.
  if (rel.startsWith('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store', // M1 is for iterating; never serve a stale client
  });
  res.end(readFileSync(file));
});

// ---------------------------------------------------------------- signalling

const wss = new WebSocketServer({ server });

/** @type {Map<string, { ws: import('ws').WebSocket, name: string }>} */
const peers = new Map();

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const publicView = (id) => ({ id, name: peers.get(id)?.name ?? '?' });

wss.on('connection', (ws) => {
  const id = randomUUID().slice(0, 8);
  let joined = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (joined) return;
      joined = true;
      peers.set(id, { ws, name: String(msg.name ?? 'Unknown').slice(0, 40) });

      send(ws, {
        type: 'welcome',
        id,
        peers: [...peers.keys()].filter((p) => p !== id).map(publicView),
      });
      for (const [pid, peer] of peers) {
        if (pid !== id) send(peer.ws, { type: 'peer-joined', peer: publicView(id) });
      }
      console.log(`+ ${peers.get(id).name} (${id}) — ${peers.size} connected`);
      return;
    }

    // Forward SDP and ICE verbatim. The server does not inspect or store it.
    if (msg.type === 'signal' && joined) {
      const target = peers.get(msg.to);
      if (target) send(target.ws, { type: 'signal', from: id, data: msg.data });
    }
  });

  ws.on('close', () => {
    if (!peers.delete(id)) return;
    for (const peer of peers.values()) send(peer.ws, { type: 'peer-left', id });
    console.log(`- ${id} — ${peers.size} connected`);
  });
});

// -------------------------------------------------------------------- listen

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log('  RoomBeam — M1 proof of concept');
  console.log(line);
  console.log(`\n  This computer:   https://localhost:${PORT}`);
  console.log(`  Other devices:   https://${primary}:${PORT}\n`);
  if (interfaces.length > 1) {
    console.log('  Other interfaces detected (try these if the above fails):');
    for (const i of interfaces.slice(1)) console.log(`    https://${i.address}:${PORT}  (${i.name})`);
    console.log('');
  }
  console.log(line);
  console.log('  The certificate is self-signed, so every device will show a');
  console.log('  security warning the first time. That is expected here.');
  console.log('');
  console.log('    iOS Safari    Show Details -> visit this website');
  console.log('    Android/Win   Advanced -> Proceed');
  console.log('');
  console.log('  Both devices must be on the same Wi-Fi.');
  console.log(`${line}\n`);
});
