// CRC-32 (IEEE 802.3), incremental.
//
// SCTP already checksums every chunk and retransmits what does not arrive, so
// this is not what makes a transfer correct — it is what makes a transfer
// *checkable*. "Received intact" is a claim the receiver can only make if it
// verified something end to end.
//
// Imported by both the page and the workers, so it must stay free of any
// window/document reference.

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[i] = c >>> 0;
}

/**
 * Fold more bytes into a running checksum. Pass the previous return value back
 * in as `prev`; start from 0.
 *
 * @param {ArrayBuffer|ArrayBufferView} data
 * @param {number} prev
 */
export function crc32(data, prev = 0) {
  const bytes = data instanceof Uint8Array
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

  let c = ~prev >>> 0;
  const n = bytes.length;

  // Unrolled by four. At the throughputs this has to keep up with, the loop
  // overhead is a measurable fraction of the work.
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    c = TABLE[(c ^ bytes[i + 1]) & 0xff] ^ (c >>> 8);
    c = TABLE[(c ^ bytes[i + 2]) & 0xff] ^ (c >>> 8);
    c = TABLE[(c ^ bytes[i + 3]) & 0xff] ^ (c >>> 8);
  }
  for (; i < n; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);

  return ~c >>> 0;
}

/** Same value, as the 8-character hex a user could compare by eye. */
export const crcHex = (crc) => (crc >>> 0).toString(16).padStart(8, '0');
