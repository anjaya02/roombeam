import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { sanitizeText } from '../public/shared/text.js';
import { LIMITS, Rooms, publicView } from './rooms.js';

// The introduction service, and nothing more.
//
// A browser cannot discover devices on a local network — no mDNS, no UDP
// broadcast, no raw sockets. That single sandbox restriction is the entire
// reason this component exists. It exchanges the connection details two
// browsers need in order to find each other, and then it is finished: once the
// DataChannel is open, this process can be restarted mid-transfer without the
// transfer noticing.
//
// It never sees a filename and never sees a byte of file content. Filenames
// travel over the encrypted DataChannel specifically so that they cannot end up
// in a log here.

export const RATE = {
  /** Token bucket per socket. ICE trickling is bursty — a fresh peer connection
   *  emits candidates in a clump — so the bucket is deep and the refill modest. */
  burst: 240,
  perSecond: 60,
  /** Concurrent sockets from one address.
   *
   *  This has to sit well above the room caps, and the reason is easy to get
   *  wrong: every device behind one router shares a public address. A classroom
   *  of thirty is thirty sockets from a single IP, so a limit tuned as though one
   *  address meant one device would lock most of the room out — and it would look
   *  like the server was down rather than like a policy. The protections that
   *  actually bound abuse are the per-socket rate limit, the room caps and the
   *  idle sweep; this only stops one host from exhausting sockets outright. */
  socketsPerIp: 80,
  maxNameLength: 40,
  maxPubkeyLength: 256,
};

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

/** @param {import('node:http').Server|import('node:https').Server} server */
export function attachSignaling(server, { trustProxy = false, log = console.log } = {}) {
  const rooms = new Rooms();
  const socketsByIp = new Map();
  const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });

  const clientIp = (req) => {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    }
    // ::ffff:192.168.1.5 and 192.168.1.5 must hash to the same network room.
    return String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  };

  const clean = (value, max, fallback) => sanitizeText(value, max, fallback);

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);

    const open = socketsByIp.get(ip) ?? 0;
    if (open >= RATE.socketsPerIp) {
      send(ws, { t: 'error', code: 'too-many', message: 'Too many connections from this network.', fatal: true });
      ws.close(1008, 'too many connections');
      return;
    }
    socketsByIp.set(ip, open + 1);

    /** @type {import('./rooms.js').Peer} */
    const peer = {
      id: randomUUID().slice(0, 8),
      name: 'Unknown',
      pubkey: null,
      ws,
      ip,
      roomKey: null,
      lastSeen: Date.now(),
    };

    let tokens = RATE.burst;
    let lastRefill = Date.now();

    const allowed = () => {
      const now = Date.now();
      tokens = Math.min(RATE.burst, tokens + ((now - lastRefill) / 1000) * RATE.perSecond);
      lastRefill = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };

    /** Tell everyone else in the room something, without echoing to the source. */
    const toRoom = (msg) => {
      const room = peer.roomKey && rooms.get(peer.roomKey);
      if (!room) return;
      for (const other of room.peers.values()) {
        if (other.id !== peer.id) send(other.ws, msg);
      }
    };

    const roomView = (room) => ({ kind: room.kind, code: room.code, size: room.peers.size });

    const enterRoom = (mode, code, isFirstJoin) => {
      let requested = null;
      if (mode === 'code') {
        requested = code;
      } else if (mode === 'new') {
        requested = rooms.freshCode();
        if (!requested) {
          send(ws, { t: 'error', code: 'busy', message: 'Could not allocate a room code. Try again.' });
          return;
        }
      }

      const previous = peer.roomKey;
      if (previous) {
        toRoom({ t: 'peer-left', id: peer.id });
        rooms.leave(peer);
      }

      const result = rooms.join(peer, requested);
      if (!result.ok) {
        send(ws, { t: 'error', code: result.code, message: result.message });
        // Falling back to the network room keeps a rejected code from leaving
        // the client in limbo with an empty device list and no explanation.
        if (previous || !isFirstJoin) {
          const retry = rooms.join(peer, null);
          if (retry.ok) {
            send(ws, { t: 'room', room: roomView(retry.room), peers: others(retry.room) });
            toRoom({ t: 'peer-joined', peer: publicView(peer) });
          }
        }
        return;
      }

      const room = result.room;
      send(ws, isFirstJoin
        ? { t: 'welcome', id: peer.id, room: roomView(room), peers: others(room), limits: { idleMs: LIMITS.idleMs } }
        : { t: 'room', room: roomView(room), peers: others(room) });
      toRoom({ t: 'peer-joined', peer: publicView(peer) });

      log(`  ${peer.name} (${peer.id}) → ${room.kind === 'code' ? room.code : 'nearby'}` +
          `  ·  ${rooms.peerCount} peers in ${rooms.size} rooms`);
    };

    const others = (room) =>
      [...room.peers.values()].filter((p) => p.id !== peer.id).map(publicView);

    ws.on('message', (raw) => {
      peer.lastSeen = Date.now();
      if (!allowed()) {
        send(ws, { t: 'error', code: 'rate', message: 'Slow down.', fatal: true });
        ws.close(1008, 'rate limit');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // unparseable input is not worth a reply
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        case 'ping':
          send(ws, { t: 'pong' });
          return;

        case 'join': {
          const first = peer.roomKey === null;
          peer.name = clean(msg.name, RATE.maxNameLength, peer.name);
          peer.pubkey = msg.pubkey ? clean(msg.pubkey, RATE.maxPubkeyLength, null) : peer.pubkey;
          const mode = msg.mode === 'code' || msg.mode === 'new' ? msg.mode : 'network';
          enterRoom(mode, msg.code, first);
          return;
        }

        case 'rename': {
          if (!peer.roomKey) return;
          const next = clean(msg.name, RATE.maxNameLength, peer.name);
          if (next === peer.name) return;
          peer.name = next;
          toRoom({ t: 'peer-renamed', id: peer.id, name: peer.name });
          return;
        }

        case 'signal': {
          // Forwarded verbatim. Not inspected, not logged, not stored. The one
          // check is that the target is in the same room as the sender, so a
          // socket cannot use the relay to reach arbitrary strangers.
          const room = peer.roomKey && rooms.get(peer.roomKey);
          const target = room?.peers.get(String(msg.to ?? ''));
          if (target && target.id !== peer.id) {
            send(target.ws, { t: 'signal', from: peer.id, data: msg.data });
          }
          return;
        }
      }
    });

    ws.on('close', () => {
      socketsByIp.set(ip, (socketsByIp.get(ip) ?? 1) - 1);
      if (socketsByIp.get(ip) <= 0) socketsByIp.delete(ip);
      if (!peer.roomKey) return;
      toRoom({ t: 'peer-left', id: peer.id });
      rooms.leave(peer);
      log(`  ${peer.name} (${peer.id}) left  ·  ${rooms.peerCount} peers in ${rooms.size} rooms`);
    });

    ws.on('error', () => ws.terminate());
  });

  // A socket that has gone away without a close frame — the normal outcome when
  // a phone loses signal — otherwise sits in the room list forever, showing a
  // device that is not there.
  const sweep = setInterval(() => {
    for (const stale of rooms.stale()) stale.ws.close(1001, 'idle');
  }, 30_000);
  sweep.unref?.();

  return {
    stats: () => ({ rooms: rooms.size, peers: rooms.peerCount }),
    close: () => { clearInterval(sweep); wss.close(); },
  };
}
