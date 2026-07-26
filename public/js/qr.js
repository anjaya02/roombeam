// A QR encoder, byte mode, versions 1–6.
//
// Six versions is not a limitation in practice: version 6 at error level M holds
// 106 bytes, and the longest thing this app ever encodes is an origin plus
// `/#/r/ABC12`. Stopping below version 7 also means no version-information
// blocks, which removes a whole class of thing to get wrong.
//
// The structure follows ISO/IEC 18004 directly: build the bit stream, split it
// into blocks, add Reed–Solomon parity, interleave, lay the modules out, then
// pick the mask that scores best. The one invariant worth stating is checked at
// the end of layout — the number of modules available for data has to equal the
// codeword count exactly, and if a table here were wrong that count would not
// balance. A wrong table would otherwise produce a code that looks plausible
// and does not scan.

/** total codewords, and [parity per block, block count] per error level */
const VERSIONS = {
  1: { total: 26, L: [7, 1], M: [10, 1] },
  2: { total: 44, L: [10, 1], M: [16, 1] },
  3: { total: 70, L: [15, 1], M: [26, 1] },
  4: { total: 100, L: [20, 1], M: [18, 2] },
  5: { total: 134, L: [26, 1], M: [24, 2] },
  6: { total: 172, L: [18, 2], M: [16, 4] },
};

/** Unused modules left over after the codewords, per version. */
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7 };

/** The two-bit level indicator that goes into the format information. */
const ECC_INDICATOR = { L: 0b01, M: 0b00 };

const MODE_BYTE = 0b0100;
const PAD_CODEWORDS = [0xec, 0x11];

// ── GF(256) ──────────────────────────────────────────────────────────────────
// Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d), generator 2. Built
// rather than tabulated, which is both shorter and impossible to typo.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** g(x) = ∏ (x − α^i) for i < degree. */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);          // × x
      next[j + 1] ^= gfMul(poly[j], EXP[i]); // × α^i
    }
    poly = next;
  }
  return poly;
}

/** The parity codewords for one block. */
function parityFor(data, count) {
  const gen = generatorPoly(count);
  const work = new Uint8Array(data.length + count);
  work.set(data);

  for (let i = 0; i < data.length; i++) {
    const lead = work[i];
    if (!lead) continue;
    for (let j = 1; j <= count; j++) work[i + j] ^= gfMul(gen[j], lead);
  }
  return work.subarray(data.length);
}

// ── bit stream ───────────────────────────────────────────────────────────────

class BitWriter {
  bytes = [];
  #bit = 0;

  push(value, width) {
    for (let i = width - 1; i >= 0; i--) {
      if (this.#bit === 0) this.bytes.push(0);
      if ((value >>> i) & 1) this.bytes[this.bytes.length - 1] |= 0x80 >>> this.#bit;
      this.#bit = (this.#bit + 1) & 7;
    }
  }

  get length() { return this.bytes.length * 8 - ((8 - this.#bit) & 7); }
}

/** Data capacity in bytes, byte mode. Twelve bits go to the mode and the count. */
const byteCapacity = (version, level) => dataCodewords(version, level) - 2;

function dataCodewords(version, level) {
  const spec = VERSIONS[version];
  const [parity, blocks] = spec[level];
  return spec.total - parity * blocks;
}

export class QrTooLong extends Error {
  constructor(bytes, limit) {
    super(`${bytes} bytes will not fit in a version 6 QR code (limit ${limit}).`);
    this.name = 'QrTooLong';
  }
}

/**
 * @param {string} text
 * @param {{ level?: 'L'|'M', minVersion?: number }} [options]
 * @returns {{ size: number, version: number, level: string, mask: number, get(row: number, col: number): boolean }}
 */
export function encodeQr(text, { level = 'M', minVersion = 1 } = {}) {
  const data = new TextEncoder().encode(text);

  let version = 0;
  for (let candidate = Math.max(1, minVersion); candidate <= 6; candidate++) {
    if (data.length <= byteCapacity(candidate, level)) { version = candidate; break; }
  }
  // Level L carries less parity and therefore more payload; trying it before
  // giving up turns a hard failure into a slightly less robust code.
  if (!version && level !== 'L') return encodeQr(text, { level: 'L', minVersion });
  if (!version) throw new QrTooLong(data.length, byteCapacity(6, 'L'));

  const codewords = buildCodewords(data, version, level);
  return layout(codewords, version, level);
}

function buildCodewords(data, version, level) {
  const capacity = dataCodewords(version, level);
  const writer = new BitWriter();

  writer.push(MODE_BYTE, 4);
  writer.push(data.length, 8); // 8-bit count is correct for versions 1–9
  for (const byte of data) writer.push(byte, 8);

  // Terminator, then to a byte boundary, then alternating pad codewords.
  writer.push(0, Math.min(4, capacity * 8 - writer.length));
  while (writer.length % 8 !== 0) writer.push(0, 1);

  const stream = writer.bytes;
  for (let i = 0; stream.length < capacity; i++) stream.push(PAD_CODEWORDS[i % 2]);

  // Split into equal blocks, parity each, then interleave. Versions 1–6 divide
  // evenly at both levels, so there is no short-block case to handle.
  const [parityPerBlock, blockCount] = VERSIONS[version][level];
  const perBlock = capacity / blockCount;
  if (!Number.isInteger(perBlock)) throw new Error(`version ${version}${level}: uneven blocks`);

  const dataBlocks = [];
  const parityBlocks = [];
  for (let b = 0; b < blockCount; b++) {
    const block = Uint8Array.from(stream.slice(b * perBlock, (b + 1) * perBlock));
    dataBlocks.push(block);
    parityBlocks.push(parityFor(block, parityPerBlock));
  }

  const out = new Uint8Array(VERSIONS[version].total);
  let at = 0;
  for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) out[at++] = block[i];
  for (let i = 0; i < parityPerBlock; i++) for (const block of parityBlocks) out[at++] = block[i];
  return out;
}

// ── module layout ────────────────────────────────────────────────────────────

function layout(codewords, version, level) {
  const size = 17 + 4 * version;
  const modules = new Uint8Array(size * size);  // 1 = dark
  const reserved = new Uint8Array(size * size); // 1 = a function pattern, not data

  const at = (row, col) => row * size + col;
  const set = (row, col, dark, isFunction = true) => {
    modules[at(row, col)] = dark ? 1 : 0;
    if (isFunction) reserved[at(row, col)] = 1;
  };

  // Finder patterns, with their separators. Drawing the 8×8 block including the
  // separator in one pass means the separator cannot be forgotten.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = top + dr;
        const col = left + dc;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(row, col, ring !== 2 && ring <= 3);
      }
    }
  }

  // Timing patterns fill the gap between finders on row 6 and column 6.
  for (let i = 8; i <= size - 9; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // One alignment pattern from version 2 onward, at the bottom right. The other
  // grid positions coincide with finders and are omitted by the standard.
  if (version >= 2) {
    const centre = size - 7;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        set(centre + dr, centre + dc, ring !== 1);
      }
    }
  }

  // Reserve the format-information strips before laying out data. Their contents
  // are written last, once the mask is chosen.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { reserved[at(8, i)] = 1; reserved[at(i, 8)] = 1; }
  }
  for (let i = 0; i < 8; i++) reserved[at(8, size - 1 - i)] = 1;
  for (let i = 0; i < 7; i++) reserved[at(size - 1 - i, 8)] = 1;

  set(size - 8, 8, true); // the module that is always dark

  // Data, in two-module columns from the right, alternating up and down and
  // stepping over column 6 because the timing pattern owns it.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let placed = 0;

  // An explicit toggle rather than arithmetic on the column index: the direction
  // has to keep alternating across the skipped timing column, and a formula that
  // happens to work for one symbol size is not worth the risk.
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2, upward = !upward) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[at(row, col)]) continue;
        placed++;
        if (bitIndex < totalBits) {
          const bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
          modules[at(row, col)] = bit;
          bitIndex++;
        }
      }
    }
  }

  // The invariant. If a capacity or block table above were wrong, this is where
  // it shows up — loudly, instead of as a code that will not scan.
  const expected = totalBits + REMAINDER_BITS[version];
  if (placed !== expected) {
    throw new Error(`QR layout mismatch: ${placed} data modules for ${expected} bits`);
  }

  const mask = chooseMask(modules, reserved, size);
  applyMask(modules, reserved, size, mask);
  writeFormat(modules, size, ECC_INDICATOR[level], mask);

  return {
    size,
    version,
    level,
    mask,
    get: (row, col) => modules[at(row, col)] === 1,
  };
}

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

function applyMask(modules, reserved, size, mask) {
  const rule = MASKS[mask];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (reserved[row * size + col]) continue;
      if (rule(row, col)) modules[row * size + col] ^= 1;
    }
  }
}

/** Try all eight, keep the least penalised. Masking is what stops large blank
 *  areas and accidental finder look-alikes from confusing a scanner. */
function chooseMask(modules, reserved, size) {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, size, mask);
    const score = penalty(modules, size);
    applyMask(modules, reserved, size, mask); // XOR is its own inverse
    if (score < bestScore) { bestScore = score; best = mask; }
  }
  return best;
}

const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1];

function penalty(modules, size) {
  const dark = (row, col) => modules[row * size + col] === 1;
  let score = 0;

  // Rule 1: runs of five or more.
  for (let i = 0; i < size; i++) {
    for (const line of [
      (j) => dark(i, j),
      (j) => dark(j, i),
    ]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line(j) === line(j - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: same-coloured 2×2 blocks.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const first = dark(row, col);
      if (first === dark(row, col + 1) && first === dark(row + 1, col) && first === dark(row + 1, col + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the 1:1:3:1:1 finder signature with four light modules beside it.
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 7; j++) {
      for (const line of [(k) => dark(i, k), (k) => dark(k, i)]) {
        let matches = true;
        for (let k = 0; k < 7; k++) {
          if (line(j + k) !== (FINDER_LIKE[k] === 1)) { matches = false; break; }
        }
        if (!matches) continue;

        const clearBefore = j < 4 || ![1, 2, 3, 4].some((d) => line(j - d));
        const clearAfter = j + 10 >= size || ![1, 2, 3, 4].some((d) => line(j + 6 + d));
        if (clearBefore || clearAfter) score += 40;
      }
    }
  }

  // Rule 4: drift away from an even balance of dark and light.
  let darkCount = 0;
  for (let i = 0; i < modules.length; i++) darkCount += modules[i];
  const percent = (darkCount * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) over the level and mask, then the constant mask the spec applies so
 *  that an all-zero format is not a valid one. */
function formatBits(eccIndicator, mask) {
  const data = (eccIndicator << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = ((remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537)) & 0x3ff;
  }
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

function writeFormat(modules, size, eccIndicator, mask) {
  const bits = formatBits(eccIndicator, mask);
  const bit = (i) => (bits >>> i) & 1;
  const put = (row, col, value) => { modules[row * size + col] = value; };

  // Copy one, wrapped around the top-left finder, skipping the timing lines.
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i <= 14; i++) put(14 - i, 8, bit(i));

  // Copy two: seven modules up the left edge of the bottom-left finder, then
  // eight along the top of the bottom-right one.
  for (let i = 0; i <= 6; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 7; i <= 14; i++) put(8, size - 15 + i, bit(i));
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * An SVG element. One path for every dark module keeps the DOM to a single node,
 * which matters because this is re-rendered whenever the room code changes.
 *
 * The quiet zone is not decoration — scanners need four modules of clear space
 * and will simply fail without it.
 */
export function qrToSvg(qr, { quietZone = 4, title = 'Room QR code' } = {}) {
  const span = qr.size + quietZone * 2;
  const parts = [];

  for (let row = 0; row < qr.size; row++) {
    let col = 0;
    while (col < qr.size) {
      if (!qr.get(row, col)) { col++; continue; }
      let width = 1;
      while (col + width < qr.size && qr.get(row, col + width)) width++;
      parts.push(`M${col + quietZone} ${row + quietZone}h${width}v1h-${width}z`);
      col += width;
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);
  svg.setAttribute('shape-rendering', 'crispEdges');

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', String(span));
  background.setAttribute('height', String(span));
  background.setAttribute('fill', '#ffffff');
  svg.append(background);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', parts.join(''));
  path.setAttribute('fill', '#000000');
  svg.append(path);

  return svg;
}
