import { safeFileName, sanitizeText } from '../shared/text.js';

// The DataChannel wire protocol.
//
// Control messages are JSON strings; file payload is binary. They are told apart
// by `typeof event.data === 'string'`, which means no custom framing and no
// length prefixes to get wrong. Because the channel is ordered and reliable, a
// binary message always belongs to whichever file the last `file-start`
// announced, so chunks carry no header at all — the sequence is the framing.
//
// Everything crossing this boundary came from another person's device. Each
// message is validated into a known shape here, once, so that no handler
// downstream has to wonder.

export const PROTOCOL_VERSION = 1;

export const MSG = {
  hello: 'hello',
  helloProof: 'hello-proof',
  offerFiles: 'offer-files',
  accept: 'accept',
  decline: 'decline',
  fileStart: 'file-start',
  fileEnd: 'file-end',
  fileSkip: 'file-skip',
  progress: 'progress',
  flow: 'flow',
  cancel: 'cancel',
  resumeQuery: 'resume-query',
  resumeFrom: 'resume-from',
  text: 'text',
};

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isSize = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * A plausible chunk size, in bytes.
 *
 * Its own predicate rather than a general "positive integer" one, and the range
 * is deliberately generous at the top: a peer may negotiate up from what we would
 * choose, and rejecting a `file-start` for being too large means the receiver
 * never opens a writer while chunks arrive anyway — a stall with nothing
 * whatsoever on screen to explain it.
 */
const isChunkSize = (v) => Number.isSafeInteger(v) && v >= 1024 && v <= 16 * 1024 * 1024;

/** Absolute ceiling on one offer. Not a policy — a guard against a peer
 *  announcing four million files and making the receiver render them. */
export const MAX_FILES_PER_TRANSFER = 500;

/** Longest text message we will carry. A link or a short note, not a document —
 *  and a bound so a peer cannot push an arbitrarily large string onto the page. */
export const MAX_MESSAGE_LEN = 2000;

/**
 * Turn raw channel data into a trusted message, or null.
 * @param {string} raw
 */
export function parseControl(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;

  switch (msg.t) {
    case MSG.hello:
      return {
        t: msg.t,
        version: Number.isInteger(msg.version) ? msg.version : 0,
        name: sanitizeText(msg.name, 40, 'Unknown'),
        pubkey: typeof msg.pubkey === 'string' && msg.pubkey.length <= 256 ? msg.pubkey : null,
        nonce: typeof msg.nonce === 'string' && msg.nonce.length <= 64 ? msg.nonce : null,
      };

    case MSG.helloProof:
      return {
        t: msg.t,
        signature: typeof msg.signature === 'string' && msg.signature.length <= 256 ? msg.signature : null,
      };

    case MSG.offerFiles: {
      if (!isId(msg.transferId) || !Array.isArray(msg.files) || !msg.files.length) return null;
      if (msg.files.length > MAX_FILES_PER_TRANSFER) return null;

      const files = [];
      for (const raw of msg.files) {
        if (!raw || typeof raw !== 'object' || !isId(raw.id) || !isSize(raw.size)) return null;
        files.push({
          id: raw.id,
          // The name is sanitised here, at the boundary, so that nothing
          // downstream can accidentally use the original.
          name: safeFileName(raw.name),
          size: raw.size,
          mime: sanitizeText(raw.mime, 120, ''),
          mtime: isSize(raw.mtime) ? raw.mtime : 0,
        });
      }
      return { t: msg.t, transferId: msg.transferId, files };
    }

    case MSG.accept: {
      if (!isId(msg.transferId) || !Array.isArray(msg.fileIds)) return null;
      const fileIds = msg.fileIds.filter(isId).slice(0, MAX_FILES_PER_TRANSFER);
      if (!fileIds.length) return null;
      return { t: msg.t, transferId: msg.transferId, fileIds };
    }

    case MSG.decline:
    case MSG.cancel:
      if (!isId(msg.transferId)) return null;
      return {
        t: msg.t,
        transferId: msg.transferId,
        fileId: isId(msg.fileId) ? msg.fileId : null,
        reason: sanitizeText(msg.reason, 140, ''),
      };

    case MSG.fileStart:
      if (!isId(msg.transferId) || !isId(msg.fileId) || !isChunkSize(msg.chunkSize)) return null;
      return {
        t: msg.t,
        transferId: msg.transferId,
        fileId: msg.fileId,
        chunkSize: msg.chunkSize,
        offset: isSize(msg.offset) ? msg.offset : 0,
      };

    case MSG.fileEnd:
      if (!isId(msg.transferId) || !isId(msg.fileId)) return null;
      return {
        t: msg.t,
        transferId: msg.transferId,
        fileId: msg.fileId,
        bytes: isSize(msg.bytes) ? msg.bytes : null,
        crc: Number.isInteger(msg.crc) ? msg.crc >>> 0 : null,
      };

    case MSG.fileSkip:
      if (!isId(msg.transferId) || !isId(msg.fileId)) return null;
      return { t: msg.t, transferId: msg.transferId, fileId: msg.fileId, reason: sanitizeText(msg.reason, 140, '') };

    case MSG.progress:
      if (!isId(msg.transferId) || !isId(msg.fileId) || !isSize(msg.received)) return null;
      return { t: msg.t, transferId: msg.transferId, fileId: msg.fileId, received: msg.received };

    case MSG.flow:
      if (!isId(msg.transferId)) return null;
      return { t: msg.t, transferId: msg.transferId, pause: msg.pause === true };

    case MSG.resumeQuery:
      if (!isId(msg.transferId)) return null;
      return { t: msg.t, transferId: msg.transferId, fileId: isId(msg.fileId) ? msg.fileId : null };

    case MSG.resumeFrom:
      if (!isId(msg.transferId) || !isId(msg.fileId)) return null;
      // A byte offset rather than a chunk index. SCTP delivers whole messages, so
      // the receiver always holds a chunk boundary — but a byte offset also
      // survives the two ends negotiating a different chunk size after
      // reconnecting, which a chunk index would silently misinterpret.
      return {
        t: msg.t,
        transferId: msg.transferId,
        fileId: msg.fileId,
        available: msg.available === true,
        offset: isSize(msg.offset) ? msg.offset : 0,
      };

    case MSG.text: {
      // A short note or a URL. The body is sanitised here, at the boundary — the
      // same treatment device names and filenames get — so control characters and
      // bidi overrides are gone before anything downstream renders it. An empty
      // result (a body that was nothing but stripped characters) is not a message.
      if (!isId(msg.messageId)) return null;
      const body = sanitizeText(msg.body, MAX_MESSAGE_LEN, '');
      if (!body) return null;
      return { t: msg.t, messageId: msg.messageId, body };
    }

    default:
      return null; // an unknown type is a newer peer, not an error
  }
}

/**
 * The chunk size both ends will use.
 *
 * Negotiated rather than assumed: Chromium reports 256 KiB, Firefox reports
 * effectively unlimited, and older stacks are far lower. Sending above a peer's
 * limit closes the channel outright, and sending far below it wastes throughput
 * on per-message overhead — which is exactly the shape of a bug that looks like
 * "one direction is slower than the other".
 *
 * @param {RTCPeerConnection} pc
 * @param {number} override 0 for automatic
 */
export function negotiateChunkSize(pc, override = 0) {
  const FLOOR = 16 * 1024;    // safe on every stack we have seen
  const CEILING = 256 * 1024; // above this, gains flatten and buffers get lumpy

  if (override) return Math.max(1024, Math.min(override, CEILING));

  const reported = pc.sctp?.maxMessageSize;
  if (!reported || !Number.isFinite(reported)) return FLOOR;

  // Leave headroom under the reported maximum: it describes the SCTP payload,
  // and hitting it exactly has historically been where interop breaks.
  return Math.max(FLOOR, Math.min(CEILING, Math.floor(reported * 0.95)));
}
