// Checks for the parts that can be tested without a browser.
//
// The QR test is the one that earns its keep. A QR encoder either works or
// produces a picture that quietly will not scan, and there is no middle ground
// and no error message. So rather than trusting the tables, this decodes the
// encoder's own output: read the format information back, recover the mask,
// unmask, walk the same zigzag, de-interleave the blocks, confirm every
// Reed–Solomon syndrome is zero, and read the payload. If any table, the parity
// maths, the interleave order, the layout or the mask were wrong, the text does
// not come back.

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { encodeQr } from '../public/js/qr.js';
import { crc32, crcHex } from '../public/js/crc32.js';
import { ALPHABET, CODE_LENGTH, formatCode, generateCode, normalizeCode } from '../public/shared/code.js';
import { isExecutable, safeFileName, sanitizeText, trueExtension } from '../public/shared/text.js';
import { LIMITS, Rooms } from '../src/rooms.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ── QR: decode what we encoded ───────────────────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = v; GF_LOG[v] = i; v <<= 1; if (v & 0x100) v ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const VERSIONS = {
  1: { total: 26, L: [7, 1], M: [10, 1] },
  2: { total: 44, L: [10, 1], M: [16, 1] },
  3: { total: 70, L: [15, 1], M: [26, 1] },
  4: { total: 100, L: [20, 1], M: [18, 2] },
  5: { total: 134, L: [26, 1], M: [24, 2] },
  6: { total: 172, L: [18, 2], M: [16, 4] },
};

/** Undo formatBits: brute-force the 32 valid format words and take the match. */
function readFormat(qr) {
  let raw = 0;
  for (let i = 0; i <= 5; i++) raw |= (qr.get(8, i) ? 1 : 0) << i;
  raw |= (qr.get(8, 7) ? 1 : 0) << 6;
  raw |= (qr.get(8, 8) ? 1 : 0) << 7;
  raw |= (qr.get(7, 8) ? 1 : 0) << 8;
  for (let i = 9; i <= 14; i++) raw |= (qr.get(14 - i, 8) ? 1 : 0) << i;

  for (let indicator = 0; indicator < 4; indicator++) {
    for (let mask = 0; mask < 8; mask++) {
      const data = (indicator << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = ((rem << 1) ^ (((rem >>> 9) & 1) * 0x537)) & 0x3ff;
      if (((((data << 10) | rem) ^ 0x5412) & 0x7fff) === raw) return { indicator, mask };
    }
  }
  throw new Error('format information does not decode to a valid word');
}

/** The reserved-module map, derived independently of the encoder. */
function functionMap(size, version) {
  const reserved = new Uint8Array(size * size);
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) reserved[r * size + c] = 1; };

  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(top + dr, left + dc);
  }
  for (let i = 8; i <= size - 9; i++) { mark(6, i); mark(i, 6); }
  if (version >= 2) {
    const centre = size - 7;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(centre + dr, centre + dc);
  }
  for (let i = 0; i <= 8; i++) if (i !== 6) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  for (let i = 0; i < 7; i++) mark(size - 1 - i, 8);
  mark(size - 8, 8);
  return reserved;
}

function decodeQr(qr) {
  const { size, version } = qr;
  const { mask } = readFormat(qr);
  const reserved = functionMap(size, version);

  // Read the zigzag, unmasking as we go.
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2, upward = !upward) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row * size + col]) continue;
        const dark = qr.get(row, col) ? 1 : 0;
        bits.push(MASKS[mask](row, col) ? dark ^ 1 : dark);
      }
    }
  }

  const spec = VERSIONS[version];
  const level = qr.level;
  const [parityPerBlock, blockCount] = spec[level];
  const codewords = new Uint8Array(spec.total);
  for (let i = 0; i < spec.total; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    codewords[i] = byte;
  }

  // De-interleave into blocks, then check each is a valid RS codeword.
  const dataTotal = spec.total - parityPerBlock * blockCount;
  const perBlock = dataTotal / blockCount;
  const blocks = Array.from({ length: blockCount }, () => []);

  let at = 0;
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < blockCount; b++) blocks[b].push(codewords[at++]);
  for (let i = 0; i < parityPerBlock; i++) for (let b = 0; b < blockCount; b++) blocks[b].push(codewords[at++]);
  strictEqual(at, spec.total, 'de-interleave consumed every codeword');

  for (const [index, block] of blocks.entries()) {
    for (let s = 0; s < parityPerBlock; s++) {
      let syndrome = 0;
      for (const byte of block) syndrome = mul(syndrome, GF_EXP[s]) ^ byte;
      strictEqual(syndrome, 0, `block ${index} syndrome ${s} is non-zero — parity is wrong`);
    }
  }

  // Payload: mode nibble, 8-bit length, then the bytes.
  const stream = blocks.flatMap((block) => block.slice(0, perBlock));
  let bit = 0;
  const take = (n) => {
    let value = 0;
    for (let i = 0; i < n; i++, bit++) {
      value = (value << 1) | ((stream[bit >> 3] >>> (7 - (bit & 7))) & 1);
    }
    return value;
  };

  strictEqual(take(4), 0b0100, 'mode indicator is byte mode');
  const length = take(8);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = take(8);
  return new TextDecoder().decode(out);
}

console.log('\nQR encoder — round trip through an independent decoder');

for (const level of ['L', 'M']) {
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const capacity = (VERSIONS[version].total - VERSIONS[version][level][0] * VERSIONS[version][level][1]) - 2;
    // Exactly at capacity is the interesting size: it exercises the terminator
    // and padding edge where an off-by-one would land.
    const text = 'A'.repeat(capacity);
    test(`v${version}${level} at capacity (${capacity} bytes)`, () => {
      const qr = encodeQr(text, { level, minVersion: version });
      strictEqual(qr.version, version);
      strictEqual(qr.level, level);
      strictEqual(qr.size, 17 + 4 * version);
      strictEqual(decodeQr(qr), text);
    });
  }
}

test('a realistic room URL', () => {
  const url = 'https://roombeam.example.com/#/r/K7M2Q';
  strictEqual(decodeQr(encodeQr(url)), url);
});

test('short code, smallest symbol', () => {
  const qr = encodeQr('https://10.0.0.5:8443/#/r/AB12X');
  strictEqual(decodeQr(qr), 'https://10.0.0.5:8443/#/r/AB12X');
});

test('random payloads of every length up to 100', () => {
  for (let length = 1; length <= 100; length++) {
    const text = randomBytes(length).toString('base64').slice(0, length);
    strictEqual(decodeQr(encodeQr(text)), text, `length ${length}`);
  }
});

test('non-ASCII survives as UTF-8', () => {
  const text = 'café — naïve — 日本語';
  strictEqual(decodeQr(encodeQr(text)), text);
});

test('finder, timing and dark modules are where a scanner looks', () => {
  const qr = encodeQr('https://example.com/#/r/ABCDE');
  const { size } = qr;
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    ok(qr.get(top + 3, left + 3), 'finder centre is dark');
    ok(!qr.get(top + 3, left + 1), 'finder inner ring is light');
    ok(qr.get(top, left), 'finder outer ring is dark');
  }
  ok(qr.get(6, 8) && !qr.get(6, 9) && qr.get(6, 10), 'horizontal timing alternates');
  ok(qr.get(8, 6) && !qr.get(9, 6) && qr.get(10, 6), 'vertical timing alternates');
  ok(qr.get(size - 8, 8), 'the always-dark module is dark');
});

test('overlong input falls back to level L, then reports honestly', () => {
  // 120 bytes exceeds v6-M (106) but fits v6-L (134).
  const long = 'x'.repeat(120);
  const qr = encodeQr(long, { level: 'M' });
  strictEqual(qr.level, 'L', 'dropped to L rather than failing');
  strictEqual(decodeQr(qr), long);

  let threw = null;
  try { encodeQr('x'.repeat(200)); } catch (err) { threw = err; }
  strictEqual(threw?.name, 'QrTooLong');
});

// ── CRC-32 ───────────────────────────────────────────────────────────────────

console.log('\nCRC-32');

test('the standard check value', () => {
  strictEqual(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  strictEqual(crcHex(0xcbf43926), 'cbf43926');
});

test('empty input is zero', () => {
  strictEqual(crc32(new Uint8Array(0)), 0);
});

test('incremental equals one-shot at every split point', () => {
  const data = randomBytes(3000);
  const oneShot = crc32(data);
  for (const split of [1, 4, 255, 256, 999, 1024, 2999]) {
    const partial = crc32(data.subarray(0, split));
    strictEqual(crc32(data.subarray(split), partial), oneShot, `split at ${split}`);
  }
});

test('accepts ArrayBuffer, views and offset views alike', () => {
  const bytes = randomBytes(64);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 64);
  strictEqual(crc32(buffer), crc32(new Uint8Array(buffer)));
  const padded = new Uint8Array(80);
  padded.set(new Uint8Array(buffer), 16);
  strictEqual(crc32(padded.subarray(16)), crc32(buffer), 'a view with an offset');
});

// ── room codes ───────────────────────────────────────────────────────────────

console.log('\nRoom codes');

test('the alphabet excludes everything ambiguous', () => {
  strictEqual(ALPHABET.length, 32);
  for (const ch of 'ILOU') ok(!ALPHABET.includes(ch), `${ch} is excluded`);
});

test('ambiguous input folds onto the real code', () => {
  strictEqual(normalizeCode('abc12'), 'ABC12');
  strictEqual(normalizeCode('  ab-c12 '), 'ABC12');
  strictEqual(normalizeCode('AOC1I'), 'A0C11', 'O to 0, I to 1');
  strictEqual(normalizeCode('AULC1'), 'AVLC1'.replace('L', '1'), 'U to V, L to 1');
});

test('anything that is not a code is rejected', () => {
  for (const bad of ['', 'ABC1', 'ABC123', 'AB!12', null, undefined, 42, 'AB C1 2X']) {
    strictEqual(normalizeCode(bad), null, JSON.stringify(bad));
  }
});

test('generated codes are always valid and normalise to themselves', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateCode((n) => randomBytes(n));
    strictEqual(code.length, CODE_LENGTH);
    strictEqual(normalizeCode(code), code);
  }
});

test('generated codes use the whole alphabet', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i++) for (const ch of generateCode((n) => randomBytes(n))) seen.add(ch);
  strictEqual(seen.size, 32, 'every symbol appears — no dead range in the sampling');
});

test('display formatting is reversible', () => {
  strictEqual(normalizeCode(formatCode('K7M2Q')), 'K7M2Q');
});

// ── text and filename hygiene ────────────────────────────────────────────────

console.log('\nText and filename hygiene');

const RLO = String.fromCharCode(0x202e);
const LRO = String.fromCharCode(0x202d);
const NUL = String.fromCharCode(0);

test('bidi overrides cannot survive into a filename', () => {
  const spoofed = `invoice.txt${RLO}exe.gpj`;
  const safe = safeFileName(spoofed);
  ok(!safe.includes(RLO), 'the override character is gone');
  strictEqual(trueExtension(safe), 'gpj', 'the real extension is what is reported');
  ok(!safe.includes(LRO));
});

test('control characters are stripped', () => {
  strictEqual(sanitizeText(`Quiet${NUL} Otter`, 40, 'x'), 'Quiet Otter');
  strictEqual(safeFileName(`re${NUL}port.pdf`), 'report.pdf');
});

test('a path collapses to just the filename', () => {
  strictEqual(safeFileName('../../autorun.inf'), 'autorun.inf');
  strictEqual(safeFileName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
  strictEqual(safeFileName('/etc/passwd'), 'passwd');
  strictEqual(safeFileName('a/b/c'), 'c');
  strictEqual(safeFileName('deck.pdf/'), 'deck.pdf', 'a trailing separator is not a directory');
  strictEqual(safeFileName('../..'), 'received-file', 'nothing but traversal leaves nothing');
});

test('names Windows refuses are nudged rather than dropped', () => {
  strictEqual(safeFileName('CON'), '_CON');
  strictEqual(safeFileName('nul.txt'), '_nul.txt');
  strictEqual(safeFileName('report.pdf '), 'report.pdf', 'trailing space Windows would drop');
  strictEqual(safeFileName('report.'), 'report');
});

test('empty and hostile input still yields something writable', () => {
  strictEqual(safeFileName(''), 'received-file');
  strictEqual(safeFileName(null), 'received-file');
  strictEqual(safeFileName('...'), '_');
  strictEqual(safeFileName('   '), 'received-file');
});

test('truncation keeps the extension', () => {
  const name = safeFileName(`${'a'.repeat(400)}.pdf`);
  ok(name.length <= 180, `length ${name.length}`);
  strictEqual(trueExtension(name), 'pdf', 'still opens');
});

test('emoji in a device name survive whole', () => {
  strictEqual(sanitizeText('Anjaya 🎉', 40, 'x'), 'Anjaya 🎉');
  const clipped = sanitizeText('🎉'.repeat(60), 40, 'x');
  ok(!clipped.includes('�'), 'no half surrogate left behind');
});

test('executables are recognised for the warning', () => {
  for (const name of ['setup.exe', 'run.BAT', 'thing.apk', 'x.command', 'a.dmg']) {
    ok(isExecutable(name), name);
  }
  for (const name of ['photo.jpg', 'notes.txt', 'deck.pdf', 'archive.zip']) {
    ok(!isExecutable(name), name);
  }
});

// ── rooms ────────────────────────────────────────────────────────────────────

console.log('\nRooms');

const peer = (id, ip = '203.0.113.7') => ({ id, name: id, pubkey: null, ws: null, ip, roomKey: null, lastSeen: Date.now() });

test('devices behind one address are grouped without asking', () => {
  const rooms = new Rooms();
  const a = peer('a');
  const b = peer('b');
  ok(rooms.join(a, null).ok);
  const joined = rooms.join(b, null);
  ok(joined.ok);
  strictEqual(joined.room.peers.size, 2);
  strictEqual(joined.room.kind, 'network');
});

test('different addresses are different rooms', () => {
  const rooms = new Rooms();
  rooms.join(peer('a', '198.51.100.1'), null);
  const other = rooms.join(peer('b', '203.0.113.9'), null);
  strictEqual(other.room.peers.size, 1);
  strictEqual(rooms.size, 2);
});

test('a code room ignores the address entirely', () => {
  const rooms = new Rooms();
  const first = rooms.join(peer('a', '198.51.100.1'), 'K7M2Q');
  const second = rooms.join(peer('b', '203.0.113.9'), 'k7m2q'); // typed in lower case
  ok(first.ok && second.ok);
  strictEqual(second.room.peers.size, 2, 'the code wins over the network');
  strictEqual(second.room.code, 'K7M2Q');
});

test('a malformed code is refused, not silently coerced', () => {
  const rooms = new Rooms();
  const result = rooms.join(peer('a'), 'nope');
  strictEqual(result.ok, false);
  strictEqual(result.code, 'bad-code');
  strictEqual(rooms.size, 0, 'no room was created for it');
});

test('a network room caps out and says why', () => {
  const rooms = new Rooms();
  for (let i = 0; i < LIMITS.networkRoomPeers; i++) ok(rooms.join(peer(`p${i}`), null).ok);
  const overflow = rooms.join(peer('one-too-many'), null);
  strictEqual(overflow.ok, false);
  strictEqual(overflow.code, 'room-full');
  ok(overflow.message.includes('room code'), 'points at the way out');
});

test('an empty room disappears', () => {
  const rooms = new Rooms();
  const a = peer('a');
  rooms.join(a, 'ABC12');
  strictEqual(rooms.size, 1);
  rooms.leave(a);
  strictEqual(rooms.size, 0, 'no state left behind');
  strictEqual(rooms.peerCount, 0);
});

test('leaving twice is harmless', () => {
  const rooms = new Rooms();
  const a = peer('a');
  rooms.join(a, null);
  rooms.leave(a);
  strictEqual(rooms.leave(a), null);
});

test('a fresh code never collides with a live room', () => {
  const rooms = new Rooms();
  const taken = new Set();
  for (let i = 0; i < 200; i++) {
    const code = rooms.freshCode();
    ok(!taken.has(code));
    taken.add(code);
    rooms.join(peer(`p${i}`), code);
  }
});

test('idle peers are the ones swept', () => {
  const rooms = new Rooms();
  const fresh = peer('fresh');
  const stale = peer('stale');
  rooms.join(fresh, null);
  rooms.join(stale, null);
  stale.lastSeen = Date.now() - LIMITS.idleMs - 1000;
  deepStrictEqual([...rooms.stale()].map((p) => p.id), ['stale']);
});

// ── the offline shell lists what the app actually loads ──────────────────────
//
// Adding a module and forgetting to cache it costs nothing online — the worker
// is network-first — and breaks the app completely offline, because one missing
// import stops the whole graph from evaluating. Nothing about the failure points
// at the service worker, so it is worth deriving the list rather than trusting
// that someone remembered.

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** Every module reachable from an entry point by static import. */
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);

    const source = readFileSync(join(PUBLIC, rel), 'utf8');
    const imports = source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/g);
    for (const [, spec] of imports) {
      if (spec.startsWith('.')) queue.push(normalize(join(dirname(rel), spec)));
    }
  }
  return seen;
}

test('every module the app imports is in the offline shell', () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
  ok(block, 'sw.js should still declare a SHELL array');

  const shell = new Set([...block[1].matchAll(/'([^']+)'/g)].map(([, path]) => path));
  const missing = [...reachableFrom('js/main.js')].filter((rel) => !shell.has(`/${rel}`));

  deepStrictEqual(missing, [], `not cached: ${missing.join(', ')}`);
});

test('the shell does not list modules that no longer exist', () => {
  const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
  const shell = [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'([^']+)'/g)]
    .map(([, path]) => path)
    .filter((path) => path.endsWith('.js'));

  const gone = shell.filter((path) => {
    try { readFileSync(join(PUBLIC, path.slice(1))); return false; } catch { return true; }
  });
  deepStrictEqual(gone, [], `listed but missing: ${gone.join(', ')}`);
});

// ── result ───────────────────────────────────────────────────────────────────

console.log(`\n${failed ? 'FAILED' : 'passed'}: ${passed} checks ok, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
