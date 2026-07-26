import { createHash, randomBytes } from 'node:crypto';
import { generateCode, normalizeCode } from '../public/shared/code.js';

// Room state lives here and nowhere else: in memory, never on disk, gone on
// restart. There is no database because a database would mean retaining who
// talked to whom, and the only honest way to promise we do not keep that is to
// have nowhere to put it.

export const LIMITS = {
  /** A network room is whoever happens to share your public IP. Cap it low — a
   *  university NAT could otherwise put thousands of strangers in one list. */
  networkRoomPeers: 16,
  /** A code room is deliberate, so it can be classroom-sized. */
  codeRoomPeers: 64,
  rooms: 5000,
  /** Drop a socket that has stopped sending keepalives. Many hosts and phone
   *  radios kill idle WebSockets around 60s, so the client pings well inside
   *  this and a miss means genuinely gone. */
  idleMs: 90_000,
};

// Salted so that a leaked room key cannot be walked back to an IP address, and
// regenerated every boot so the mapping is not even stable across restarts.
// §4.1 promises the IP is hashed and never stored; this is that mechanism.
const IP_SALT = randomBytes(32);

const networkKeyFor = (ip) =>
  'net:' + createHash('sha256').update(IP_SALT).update(String(ip)).digest('hex').slice(0, 16);

/**
 * @typedef {{ id: string, name: string, pubkey: string|null, ws: import('ws').WebSocket,
 *             ip: string, roomKey: string|null, lastSeen: number }} Peer
 * @typedef {{ key: string, kind: 'code'|'network', code: string|null,
 *             peers: Map<string, Peer>, createdAt: number }} Room
 */

export class Rooms {
  /** @type {Map<string, Room>} */
  #rooms = new Map();

  get size() { return this.#rooms.size; }
  get peerCount() { let n = 0; for (const r of this.#rooms.values()) n += r.peers.size; return n; }

  /** @returns {Room|undefined} */
  get(key) { return this.#rooms.get(key); }

  /** A code that is not currently in use. */
  freshCode() {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = generateCode((n) => randomBytes(n));
      if (!this.#rooms.has(code)) return code;
    }
    return null; // absurdly unlikely; caller reports it rather than looping forever
  }

  /**
   * Place a peer. `requested` is a room code, or null to be grouped with
   * whoever shares this public IP.
   *
   * @param {Peer} peer
   * @param {string|null} requested
   * @returns {{ ok: true, room: Room } | { ok: false, code: string, message: string }}
   */
  join(peer, requested) {
    let key, kind, code = null;

    if (requested === null || requested === undefined) {
      key = networkKeyFor(peer.ip);
      kind = 'network';
    } else {
      code = normalizeCode(requested);
      if (!code) {
        return { ok: false, code: 'bad-code', message: 'That is not a valid room code.' };
      }
      key = code;
      kind = 'code';
    }

    let room = this.#rooms.get(key);
    if (!room) {
      if (this.#rooms.size >= LIMITS.rooms) {
        return { ok: false, code: 'busy', message: 'The server is at capacity. Try again shortly.' };
      }
      room = { key, kind, code, peers: new Map(), createdAt: Date.now() };
      this.#rooms.set(key, room);
    }

    const cap = room.kind === 'network' ? LIMITS.networkRoomPeers : LIMITS.codeRoomPeers;
    if (room.peers.size >= cap) {
      if (!room.peers.size) this.#rooms.delete(key);
      return {
        ok: false,
        code: 'room-full',
        message: room.kind === 'network'
          ? `Too many devices share this network's address to list them all. Use a room code instead.`
          : `That room already has ${cap} devices in it.`,
      };
    }

    room.peers.set(peer.id, peer);
    peer.roomKey = key;
    return { ok: true, room };
  }

  /** @param {Peer} peer @returns {Room|null} the room they were in, if any */
  leave(peer) {
    if (!peer.roomKey) return null;
    const room = this.#rooms.get(peer.roomKey);
    peer.roomKey = null;
    if (!room) return null;
    room.peers.delete(peer.id);
    if (!room.peers.size) this.#rooms.delete(room.key);
    return room;
  }

  /** Every peer whose keepalive has lapsed. */
  *stale(now = Date.now()) {
    for (const room of this.#rooms.values()) {
      for (const peer of room.peers.values()) {
        if (now - peer.lastSeen > LIMITS.idleMs) yield peer;
      }
    }
  }
}

/** What one peer is allowed to learn about another. Nothing else crosses. */
export const publicView = (peer) => ({ id: peer.id, name: peer.name, pubkey: peer.pubkey });
