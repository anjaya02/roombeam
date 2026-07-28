import { Emitter, uuid } from './util.js';
import { MSG, MAX_MESSAGE_LEN } from './protocol.js';
import { sanitizeText } from '../shared/text.js';

// Sending a short note or a link across, alongside the files.
//
// This is deliberately a separate module from the file transfer. A message needs
// none of that machinery — no offer/accept, no chunking, no resume — and, more to
// the point, `TransferManager` is an intricate state machine that has no reason to
// grow a second responsibility. It rides the same DataChannel (a `text` control
// message interleaves harmlessly with any file bytes in flight, because the
// channel is ordered and reliable) and the same `control` event, which `Emitter`
// lets more than one listener hear.
//
// Nothing here writes to disk, runs anything, or opens a link. A received message
// is only ever text on the page — so unlike a file, there is nothing to gate
// behind an accept prompt.

/** Newest-first cap. A message costs almost nothing to hold, but an unbounded
 *  list is a lever a peer on shared Wi-Fi could lean on. */
const MAX_KEPT = 100;

/**
 * The body as an openable link, or null.
 *
 * Only `http`/`https` — never `javascript:`, `data:` or anything else that turns
 * "open this" into "run this". Requires the whole body to parse as a URL, so a
 * sentence that merely contains a link is copied, not linkified.
 *
 * @param {string} body
 */
export function httpUrl(body) {
  let url;
  try { url = new URL(body); } catch { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

export class Messenger extends Emitter {
  /** Newest first. Both directions, so the sender sees a local echo of what it
   *  sent and the receiver sees what arrived. */
  messages = [];

  #network;

  constructor(network) {
    super();
    this.#network = network;
    network.on('link', (link) => this.#watch(link));
    for (const link of network.links.values()) this.#watch(link);
  }

  #watch(link) {
    link.on('control', (channel, msg) => {
      if (msg.t === MSG.text) this.#receive(link, msg);
    });
  }

  /**
   * @param {import('./peer.js').PeerLink} link
   * @param {string} body
   */
  async send(link, body) {
    // Sanitised on the way out as well as in. The receiver validates at its own
    // boundary regardless, but there is no reason to put a control character on
    // the wire, and this keeps the local echo identical to what lands over there.
    const clean = sanitizeText(body, MAX_MESSAGE_LEN, '');
    if (!clean) return null;

    const channel = await link.ensureChannel();
    const messageId = uuid().slice(0, 12);
    link.send(channel, { t: MSG.text, messageId, body: clean });

    this.#record({
      id: messageId,
      direction: 'out',
      peerName: link.name,
      peerId: link.id,
      body: clean,
    });
    return messageId;
  }

  #receive(link, msg) {
    this.#record({
      id: msg.messageId,
      direction: 'in',
      peerName: link.name,
      peerId: link.id,
      body: msg.body,
    });
    this.emit('message', this.messages[0]);
  }

  #record(entry) {
    entry.url = httpUrl(entry.body);
    entry.at = Date.now();
    this.messages.unshift(entry);
    if (this.messages.length > MAX_KEPT) this.messages.length = MAX_KEPT;
    this.emit('change');
  }

  clear() {
    this.messages = [];
    this.emit('change');
  }
}
