import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

// A self-signed certificate exists here for exactly one reason: WebRTC refuses
// to run outside a secure context, `localhost` counts as one and a LAN IP does
// not. Plain HTTP on 192.168.x.y would fail with "RTCPeerConnection is not
// defined" and no hint as to why. An honest certificate warning is better than
// a silent capability gap.
//
// When RoomBeam runs behind a real TLS terminator (see ROOMBEAM_TLS=off) none
// of this is used.

/**
 * @param {string} certDir
 * @param {{ address: string }[]} interfaces
 */
export function loadOrCreateCert(certDir, interfaces) {
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  const metaPath = join(certDir, 'issued-for.txt');

  // The SAN list is baked in at generation time. If the machine has since moved
  // to a different network its address is no longer covered, and browsers get
  // considerably stricter about a name mismatch than about an unknown issuer —
  // some drop the "proceed anyway" affordance entirely. So key the cache on the
  // exact set of addresses it was issued for.
  const want = interfaces.map((i) => i.address).join(',');
  const have = existsSync(metaPath) ? readFileSync(metaPath, 'utf8').trim() : null;

  if (have === want && existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  console.log(have === null
    ? '  Generating a self-signed certificate (first run)...'
    : '  Network addresses changed — reissuing the certificate...');

  const pems = selfsigned.generate([{ name: 'commonName', value: 'RoomBeam' }], {
    days: 365,
    keySize: 2048,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...interfaces.map((i) => ({ type: 7, ip: i.address })),
      ],
    }],
  });

  mkdirSync(certDir, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  writeFileSync(metaPath, want);
  return { key: pems.private, cert: pems.cert };
}
