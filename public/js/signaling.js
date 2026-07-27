import { Emitter } from './util.js';

// The client half of the introduction service.
//
// Everything here is disposable. A dropped signalling socket is a routine event
// — a phone locking its screen does it — and must never disturb a transfer that
// is already running, so this module owns no transfer state and no peer
// connections. It reconnects quietly and re-announces.

const PING_INTERVAL = 25_000;   // comfortably inside the 60s idle cutoff most hosts apply
const BACKOFF_MIN = 800;
const BACKOFF_MAX = 15_000;

// A socket can be open in this tab and long gone on the wire. The server drops
// peers it has not heard from for 90s, and a phone frozen in the background
// stops sending keepalives well before that — but the close never reaches a
// frozen tab, and a radio that changed networks may never deliver it at all. So
// the tab wakes up believing it is still in the room: it does not re-announce,
// the other device never learns it is back, and a transfer waits for a peer that
// is, as far as the server is concerned, gone.
//
// The server checks that it can still hear us. These do the same in the other
// direction.
const SILENCE_LIMIT = 60_000;   // nothing at all from the server: assume the socket is dead
const PONG_TIMEOUT = 5_000;     // after asking outright, on returning to the foreground

export class Signaling extends Emitter {
  /** @type {WebSocket|null} */
  #ws = null;
  #pingTimer = null;
  #retryTimer = null;
  #proveTimer = null;
  #attempts = 0;
  #closedByUs = false;
  /** When the server was last heard from. Any message counts as proof of life. */
  #lastHeard = 0;
  /** True between asking the server to prove it is there and hearing anything. */
  #awaitingProof = false;

  /** Session id assigned by the server. Changes on every reconnect. */
  id = null;
  /** @type {{ kind: 'code'|'network', code: string|null, size: number }|null} */
  room = null;
  /** What we ask for on connect and on every reconnect. */
  #intent = { mode: 'network', code: null };
  #describe = () => ({ name: 'Unknown', pubkey: null });

  /** @param {() => { name: string, pubkey: string|null }} describe */
  constructor(describe) {
    super();
    if (describe) this.#describe = describe;

    // Coming back to a backgrounded tab should feel instant rather than waiting
    // out whatever backoff we had reached.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.connected) return this.connect(true);

      // Open is not the same as alive, and returning from the background is
      // exactly when the difference bites. Ask outright rather than waiting a
      // whole ping interval to find out. A flag rather than comparing timestamps:
      // the question is "did anything answer", which no arithmetic against the
      // delay we just waited can express without a boundary to get wrong.
      this.#awaitingProof = true;
      this.#send({ t: 'ping' });
      clearTimeout(this.#proveTimer);
      this.#proveTimer = setTimeout(() => {
        if (this.#awaitingProof) this.#reconnectNow();
      }, PONG_TIMEOUT);
    });
    addEventListener('online', () => { if (!this.connected) this.connect(true); });
  }

  get connected() { return this.#ws?.readyState === WebSocket.OPEN; }

  get url() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/`;
  }

  connect(immediate = false) {
    if (this.#ws && this.#ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.#retryTimer);
    if (immediate) this.#attempts = 0;
    this.#closedByUs = false;

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.emit('status', 'error', err.message);
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    this.emit('status', 'connecting');

    ws.onopen = () => {
      this.#attempts = 0;
      this.#lastHeard = Date.now();
      this.#awaitingProof = false;
      this.emit('status', 'connecting');
      this.#send({ t: 'join', ...this.#intent, ...this.#describe() });
      clearInterval(this.#pingTimer);
      this.#pingTimer = setInterval(() => {
        // Two pings in a row with nothing back means this socket is not carrying
        // anything, whatever its readyState claims. Replace it rather than going
        // on pinging into it.
        if (Date.now() - this.#lastHeard > SILENCE_LIMIT) return this.#reconnectNow();
        this.#send({ t: 'ping' });
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      this.#lastHeard = Date.now();
      this.#awaitingProof = false;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.t) {
        case 'welcome':
          this.id = msg.id;
          this.room = msg.room;
          this.#rememberIntent(msg.room);
          this.emit('status', 'open');
          this.emit('room', msg.room, msg.peers ?? []);
          break;

        case 'room':
          this.room = msg.room;
          this.#rememberIntent(msg.room);
          this.emit('room', msg.room, msg.peers ?? []);
          break;

        case 'peer-joined': this.emit('peer-joined', msg.peer); break;
        case 'peer-left': this.emit('peer-left', msg.id); break;
        case 'peer-renamed': this.emit('peer-renamed', msg.id, msg.name); break;
        case 'signal': this.emit('signal', msg.from, msg.data); break;
        case 'pong': break;

        case 'error':
          this.emit('server-error', msg.code, msg.message);
          if (msg.fatal) this.#closedByUs = true; // do not hammer a server that just told us to stop
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(this.#pingTimer);
      clearTimeout(this.#proveTimer);
      // A socket we already replaced must not clear the live one's session id or
      // schedule a retry against it.
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.id = null;
      this.emit('status', 'closed');
      if (!this.#closedByUs) this.#scheduleRetry();
    };

    ws.onerror = () => { /* onclose always follows; nothing useful to add here */ };
  }

  /**
   * Throw away a socket that has stopped carrying anything and start again.
   *
   * The old one is detached before it is closed: its `close` event arrives after
   * the replacement is already up, and left attached it would clear the new
   * session id and schedule a retry against a connection that is fine.
   */
  #reconnectNow() {
    const dead = this.#ws;
    this.#awaitingProof = false;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#proveTimer);
    this.#ws = null;
    this.id = null;
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try { dead.close(); } catch { /* already gone */ }
    }
    this.emit('status', 'closed');
    this.connect(true);
  }

  /** Once the server has told us which room we are in, that is what we rejoin. */
  #rememberIntent(room) {
    this.#intent = room?.kind === 'code' && room.code
      ? { mode: 'code', code: room.code }
      : { mode: 'network', code: null };
  }

  #scheduleRetry() {
    const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.#attempts++) * (0.75 + Math.random() * 0.5);
    this.#retryTimer = setTimeout(() => this.connect(), delay);
    this.emit('retry-in', Math.round(delay));
  }

  #send(msg) {
    if (this.connected) this.#ws.send(JSON.stringify(msg));
  }

  /** @param {'network'|'code'|'new'} mode */
  joinRoom(mode, code = null) {
    this.#intent = mode === 'code' ? { mode: 'code', code } : { mode, code: null };
    if (this.connected) this.#send({ t: 'join', mode, code, ...this.#describe() });
    else this.connect(true);
  }

  rename(name) { this.#send({ t: 'rename', name }); }

  signal(to, data) { this.#send({ t: 'signal', to, data }); }

  close() {
    this.#closedByUs = true;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#proveTimer);
    this.#ws?.close();
    this.#ws = null;
  }
}
