import { Emitter, waitFor } from './util.js';
import { MSG, PROTOCOL_VERSION, parseControl } from './protocol.js';
import { freshNonce, identity, knownDevices } from './identity.js';

// One RTCPeerConnection per peer, and the negotiation dance around it.
//
// Two things here earn their complexity:
//
//   * Perfect negotiation. If both devices try to open a connection at the same
//     instant, a naive implementation ends up with both offers rejected and no
//     connection at all — and it looks exactly like a network fault, because one
//     direction works and the other does not. One side is designated polite and
//     yields; the roles are derived from the two session ids so both sides
//     always agree without asking.
//
//   * Fingerprint-bound device proof. The signalling server is trusted to
//     introduce peers, and a dishonest one could substitute its own DTLS
//     fingerprints and sit in the middle. So a peer proves possession of its
//     key by signing *the fingerprint it is presenting*, and we check that
//     against the fingerprint we actually received. A relay in the middle
//     cannot satisfy both.

const CHANNEL_LABEL = 'roombeam';

/** Parse the candidate type out of a candidate line, for the diagnostics log. */
const candidateType = (candidate) => /\btyp (\w+)/.exec(candidate ?? '')?.[1] ?? '?';

/**
 * The DTLS fingerprint out of an SDP blob, normalised. This is the value that
 * identifies the far end of the encrypted channel, and the value a
 * man-in-the-middle would have to substitute.
 */
export function dtlsFingerprint(sdp) {
  const match = /^a=fingerprint:(\S+)\s+(\S+)/im.exec(sdp ?? '');
  if (!match) return null;
  return `${match[1].toLowerCase()} ${match[2].toLowerCase().replace(/:/g, '')}`;
}

export class PeerLink extends Emitter {
  /** @type {RTCPeerConnection} */
  pc;
  /** @type {Set<RTCDataChannel>} */
  channels = new Set();

  id;
  name;
  pubkey;

  /** 'unknown' until the handshake finishes, then 'verified' | 'unverified' |
   *  'mismatch'. 'mismatch' is the interesting one: it means the key checked out
   *  but was bound to a different fingerprint than the one we are talking to. */
  trust = 'unknown';
  known = false;

  /** Rolling diagnostics. Kept small — this is for explaining a failure, not
   *  for archiving one. */
  iceLog = [];

  #polite;
  #signal;
  #makingOffer = false;
  #ignoreOffer = false;
  #pendingCandidates = [];
  #myNonce = freshNonce();
  #greetings = 0;
  #closed = false;
  #restartTimer = null;

  /**
   * @param {object} opts
   * @param {string} opts.id remote session id
   * @param {string} opts.myId our session id — decides politeness
   * @param {(data: unknown) => void} opts.signal
   */
  constructor({ id, myId, name, pubkey, signal, iceServers }) {
    super();
    this.id = id;
    this.name = name ?? id;
    this.pubkey = pubkey ?? null;
    this.known = knownDevices.has(this.pubkey);
    this.#signal = signal;

    // Any total order works as long as both ends compute the same one.
    this.#polite = String(myId) < String(id);

    this.pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    });

    this.#wirePeerConnection();
  }

  get polite() { return this.#polite; }
  get state() { return this.pc.connectionState; }

  /** Any channel we can send on right now. */
  get openChannel() {
    for (const channel of this.channels) if (channel.readyState === 'open') return channel;
    return null;
  }

  #log(kind, detail) {
    this.iceLog.push({ at: Date.now(), kind, detail });
    if (this.iceLog.length > 60) this.iceLog.shift();
    this.emit('ice-log', kind, detail);
  }

  #wirePeerConnection() {
    const pc = this.pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        // No-argument setLocalDescription picks offer or answer correctly and
        // avoids the rollback races that hand-rolled versions run into.
        await pc.setLocalDescription();
        this.#signal({ desc: pc.localDescription });
      } catch (err) {
        this.#log('error', `negotiation: ${err.message}`);
      } finally {
        this.#makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return this.#log('ice', 'gathering complete');
      this.#signal({ candidate: candidate.toJSON() });
      this.#log('ice', `local ${candidateType(candidate.candidate)}`);
    };

    pc.onicecandidateerror = (event) => {
      // Routinely non-fatal — a STUN server that did not answer still leaves the
      // host candidates, which are the ones that matter on a LAN.
      this.#log('ice-error', `${event.errorCode ?? ''} ${event.errorText ?? ''}`.trim());
    };

    pc.oniceconnectionstatechange = () => this.#log('ice-state', pc.iceConnectionState);

    pc.onconnectionstatechange = () => {
      this.#log('state', pc.connectionState);
      this.emit('state', pc.connectionState);

      if (pc.connectionState === 'connected') {
        clearTimeout(this.#restartTimer);
        this.#verify();
      }

      // 'disconnected' often recovers on its own — a Wi-Fi roam, a phone
      // switching bands. An ICE restart is the documented remedy, but firing it
      // immediately would abort a connection that was about to come back.
      if (pc.connectionState === 'disconnected') {
        clearTimeout(this.#restartTimer);
        this.#restartTimer = setTimeout(() => {
          if (this.#closed || pc.connectionState !== 'disconnected') return;
          this.#log('ice', 'restarting ICE');
          try { pc.restartIce(); } catch { /* older stacks: nothing to do */ }
        }, 3000);
      }

      if (pc.connectionState === 'failed') this.emit('failed');
    };

    pc.ondatachannel = ({ channel }) => this.#adopt(channel, 'remote');
  }

  // ── channels ───────────────────────────────────────────────────────────────

  /**
   * A channel to send on, opening one if necessary.
   *
   * Both peers are allowed to create a channel. If they do so simultaneously the
   * result is two channels rather than a conflict, and since each transfer binds
   * to the channel it started on, two channels are simply two independent
   * conversations. That is markedly less machinery than arbitrating a single one.
   */
  async ensureChannel({ timeout = 20_000, signal } = {}) {
    const existing = this.openChannel;
    if (existing) return existing;

    let channel = [...this.channels].find((c) => c.readyState === 'connecting');
    if (!channel) {
      channel = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
      this.#adopt(channel, 'local');
    }

    if (channel.readyState !== 'open') {
      // Everything hangs off one controller so that whichever outcome arrives
      // first takes the listeners with it. Left attached, they accumulate on every
      // send, and the losing promise rejects later — when the channel eventually
      // closes at the end of a perfectly successful transfer — as an unhandled
      // rejection with no context.
      const done = new AbortController();
      const { signal: until } = done;

      const failure = new Promise((_, reject) => {
        const onState = () => {
          if (this.pc.connectionState === 'failed') reject(new Error('connection-failed'));
        };
        this.pc.addEventListener('connectionstatechange', onState, { signal: until });
        channel.addEventListener('close', () => reject(new Error('channel-closed')), { signal: until });
        if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { signal: until });
      });
      failure.catch(() => {}); // settled below; this only stops the console noise

      try {
        await Promise.race([waitFor(channel, 'open', { timeout, signal }), failure]);
      } finally {
        done.abort();
      }
    }
    return channel;
  }

  #adopt(channel, origin) {
    channel.binaryType = 'arraybuffer';
    this.channels.add(channel);
    this.#log('channel', `${origin} channel ${channel.readyState}`);

    channel.addEventListener('open', () => {
      this.#log('channel', 'open');
      this.#greet(channel);
      this.emit('channel-open', channel);
    });

    channel.addEventListener('close', () => {
      this.channels.delete(channel);
      this.emit('channel-close', channel);
    });

    channel.addEventListener('error', (event) => {
      // A channel error is usually a symptom of the transport going away; the
      // close handler does the actual cleanup.
      this.#log('error', event.error?.message ?? 'channel error');
    });

    channel.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.emit('binary', channel, event.data);
        return;
      }
      const msg = parseControl(event.data);
      if (!msg) {
        // A control message the validator would not accept. Dropping it silently
        // is how a transfer ends up stalled with nothing on screen to explain it,
        // so it goes in the log where the diagnostics panel will show it.
        const kind = /"t"\s*:\s*"([\w-]{1,32})"/.exec(event.data)?.[1] ?? 'unknown';
        this.#log('protocol', `rejected a "${kind}" message from ${this.name}`);
        return;
      }
      if (this.#handshake(channel, msg)) return;
      this.emit('control', channel, msg);
    });

    if (channel.readyState === 'open') {
      this.#greet(channel);
      this.emit('channel-open', channel);
    }
  }

  send(channel, msg) {
    if (channel?.readyState === 'open') channel.send(JSON.stringify(msg));
  }

  // ── identity handshake ─────────────────────────────────────────────────────

  #greet(channel) {
    this.#greetings++;
    this.send(channel, {
      t: MSG.hello,
      version: PROTOCOL_VERSION,
      name: identity.name,
      pubkey: identity.publicKey,
      nonce: this.#myNonce,
    });
  }

  /** @returns {boolean} true if the message was part of the handshake */
  #handshake(channel, msg) {
    if (msg.t === MSG.hello) {
      if (msg.name) this.name = msg.name;
      if (msg.pubkey) {
        this.pubkey = msg.pubkey;
        this.known = knownDevices.has(msg.pubkey);
      }
      this.#answerChallenge(channel, msg.nonce);
      this.emit('info');
      return true;
    }

    if (msg.t === MSG.helloProof) {
      this.#checkProof(msg.signature);
      return true;
    }

    return false;
  }

  async #answerChallenge(channel, theirNonce) {
    if (!theirNonce || !this.pubkey) return;
    // What we sign is our own fingerprint — the one the peer will see on the far
    // end of the channel. Signing only the nonce would prove we hold the key
    // while saying nothing about who is relaying. If the description is not set
    // yet there is nothing honest to sign; the retry below covers it.
    const fingerprint = dtlsFingerprint(this.pc.localDescription?.sdp);
    if (!fingerprint) return;
    const signature = await identity.proveTo(theirNonce, this.pubkey, fingerprint);
    if (signature) this.send(channel, { t: MSG.helloProof, signature });
  }

  async #checkProof(signature) {
    // No key on one side or the other means there is nothing to check — that is
    // a final answer, not a pending one.
    if (!signature || !this.pubkey || !identity.publicKey) {
      this.trust = 'unverified';
      this.emit('trust', this.trust);
      return;
    }

    // Not knowable yet. Stay 'unknown' so the retry path still fires; settling on
    // a verdict here would make the state permanent for the wrong reason.
    const seen = dtlsFingerprint(this.pc.remoteDescription?.sdp);
    if (!seen) return;

    const ok = await identity.verifyPeer(this.pubkey, this.#myNonce, signature, seen);
    if (ok) {
      this.trust = 'verified';
      knownDevices.remember(this.pubkey, this.name);
      this.known = true;
    } else {
      // Either the key does not match what we remembered, or it was bound to a
      // different fingerprint than the one we are actually talking to. The
      // second case is the one worth shouting about.
      this.trust = 'mismatch';
    }
    this.emit('trust', this.trust);
  }

  /** Retry the handshake once descriptions exist and fingerprints are knowable.
   *  Bounded, so a peer that never answers cannot keep us greeting forever. */
  #verify() {
    if (this.trust !== 'unknown' || this.#greetings >= 3) return;
    const channel = this.openChannel;
    if (channel) this.#greet(channel);
  }

  /**
   * A short code both users can compare out loud on first contact, when there is
   * no remembered key to check against. Derived from both DTLS fingerprints, so
   * anything sitting in the middle makes the two devices show different codes.
   */
  async shortAuthString() {
    const mine = dtlsFingerprint(this.pc.localDescription?.sdp);
    const theirs = dtlsFingerprint(this.pc.remoteDescription?.sdp);
    if (!mine || !theirs) return null;
    // Sorted so both devices hash the same string regardless of role.
    const material = [mine, theirs].sort().join('|');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
    return [...digest.slice(0, 3)].map((b) => String(b % 100).padStart(2, '0')).join(' ');
  }

  // ── signalling ─────────────────────────────────────────────────────────────

  async handleSignal(data) {
    if (this.#closed || !data) return;
    const pc = this.pc;

    try {
      if (data.desc) {
        const collision = data.desc.type === 'offer'
          && (this.#makingOffer || pc.signalingState !== 'stable');

        this.#ignoreOffer = !this.#polite && collision;
        if (this.#ignoreOffer) {
          this.#log('negotiation', 'ignored a colliding offer');
          return;
        }

        await pc.setRemoteDescription(data.desc);
        if (data.desc.type === 'offer') {
          await pc.setLocalDescription();
          this.#signal({ desc: pc.localDescription });
        }

        for (const candidate of this.#pendingCandidates.splice(0)) {
          await pc.addIceCandidate(candidate).catch(() => {});
        }
        // The remote fingerprint is only knowable now, so a proof that arrived
        // early could not be checked. Restart the exchange.
        this.#verify();
      } else if (data.candidate) {
        this.#log('ice', `remote ${candidateType(data.candidate.candidate)}`);
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else this.#pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      if (!this.#ignoreOffer) this.#log('error', `signal: ${err.message}`);
    }
  }

  // ── route inspection ───────────────────────────────────────────────────────

  /**
   * Which way the bytes are actually going. The privacy claim is only worth
   * making if it is checked, and this is the check: 'host' and 'prflx'
   * candidates mean the packets stayed on the local network.
   */
  async describePath() {
    let stats;
    try { stats = await this.pc.getStats(); } catch { return UNKNOWN_PATH; }

    const byId = new Map();
    let pair = null;
    stats.forEach((report) => {
      byId.set(report.id, report);
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated ?? true)) {
        // Prefer the most recently active pair if several succeeded.
        if (!pair || (report.lastPacketSentTimestamp ?? 0) >= (pair.lastPacketSentTimestamp ?? 0)) pair = report;
      }
    });
    if (!pair) return UNKNOWN_PATH;

    const localType = byId.get(pair.localCandidateId)?.candidateType;
    const remoteType = byId.get(pair.remoteCandidateId)?.candidateType;
    const isLocal = (type) => type === 'host' || type === 'prflx';
    const rtt = Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null;

    if (localType === 'relay' || remoteType === 'relay') {
      return { kind: 'relay', label: 'relayed through a server', tone: 'bad', localType, remoteType, rtt };
    }
    if (isLocal(localType) && isLocal(remoteType)) {
      return { kind: 'local', label: 'local network', tone: 'ok', localType, remoteType, rtt };
    }
    return {
      kind: 'internet',
      label: 'internet route',
      tone: 'warn',
      localType, remoteType, rtt,
    };
  }

  /**
   * Why a connection failed. Four causes that look identical from the outside
   * and have nothing in common as fixes; reporting one message for all of them
   * tells the user nothing they can act on.
   */
  async diagnose() {
    let local = 0, remote = 0, pairs = 0, failed = 0;
    let hostLocal = 0;
    try {
      const stats = await this.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'local-candidate') {
          local++;
          if (report.candidateType === 'host') hostLocal++;
        }
        if (report.type === 'remote-candidate') remote++;
        if (report.type === 'candidate-pair') {
          pairs++;
          if (report.state === 'failed') failed++;
        }
      });
    } catch { /* fall through to the generic message */ }

    if (local === 0) {
      return {
        cause: 'no-local-candidates',
        message: 'This device produced no network routes at all, so there was nothing to try. '
          + 'A VPN, a privacy extension, or a disabled network interface is the usual reason.',
      };
    }
    if (remote === 0) {
      return {
        cause: 'no-remote-candidates',
        message: `We offered ${local} route${local === 1 ? '' : 's'}, but the other device never sent any of its own, `
          + 'so nothing was ever attempted. Both pages need to be open at the same time — reload both and retry.',
      };
    }
    if (pairs === 0) {
      return {
        cause: 'no-pairs',
        message: `Both sides exchanged routes (${local} here, ${remote} there) but no pair was formed. `
          + 'That is a stalled handshake; reloading both pages clears it.',
      };
    }
    if (hostLocal === 0) {
      return {
        cause: 'no-host-candidates',
        message: 'This device never offered a local-network address, only routes through the internet. '
          + 'That is what a VPN does. Disconnect it and retry to keep the transfer on the LAN.',
      };
    }
    return {
      cause: 'all-pairs-failed',
      message: `Every route was tried (${failed || pairs} of ${pairs} failed) and none connected. This network `
        + 'is almost certainly blocking device-to-device traffic — "client isolation", standard on school, café, '
        + 'hotel and guest Wi-Fi. A phone hotspot will confirm it in under a minute.',
    };
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#restartTimer);
    for (const channel of this.channels) {
      try { channel.close(); } catch { /* already gone */ }
    }
    this.channels.clear();
    try { this.pc.close(); } catch { /* already gone */ }
  }
}

const UNKNOWN_PATH = { kind: 'unknown', label: 'route not established yet', tone: '', localType: null, remoteType: null, rtt: null };

/**
 * The roster of peers in the room, and the connections to them.
 *
 * Signalling tells us who is present; this decides what to do about it. The one
 * rule that matters: a peer disappearing from signalling does not close its
 * connection. Phones drop WebSockets constantly, and tearing down a healthy
 * DataChannel because the introduction service blinked would break the very
 * promise that a transfer survives signalling loss.
 */
export class PeerNetwork extends Emitter {
  /** @type {Map<string, { id: string, name: string, pubkey: string|null }>} */
  roster = new Map();
  /** @type {Map<string, PeerLink>} */
  links = new Map();

  #signaling;
  #iceServers;

  constructor(signaling, iceServers = []) {
    super();
    this.#signaling = signaling;
    this.#iceServers = iceServers;

    signaling.on('room', (room, peers) => {
      this.roster = new Map(peers.map((p) => [p.id, p]));
      this.#reconcile();
      this.emit('roster');
    });

    signaling.on('peer-joined', (peer) => {
      this.roster.set(peer.id, peer);
      this.emit('roster');
      // A device that vanished and came back is usually the same device with a
      // new session id. Anything that was waiting on it can now retry.
      this.emit('peer-available', peer);
    });

    signaling.on('peer-left', (id) => {
      this.roster.delete(id);
      const link = this.links.get(id);
      if (link && !link.openChannel && link.state !== 'connected') {
        link.close();
        this.links.delete(id);
      }
      this.emit('roster');
    });

    signaling.on('peer-renamed', (id, name) => {
      const peer = this.roster.get(id);
      if (peer) peer.name = name;
      const link = this.links.get(id);
      if (link) link.name = name;
      this.emit('roster');
    });

    signaling.on('signal', (from, data) => {
      const link = this.links.get(from) ?? this.#create(from);
      if (link) link.handleSignal(data);
    });
  }

  setIceServers(servers) { this.#iceServers = servers; }

  /** Drop links to peers that are gone and idle. Live ones are left alone. */
  #reconcile() {
    for (const [id, link] of this.links) {
      if (this.roster.has(id)) continue;
      if (link.openChannel || link.state === 'connected' || link.state === 'connecting') continue;
      link.close();
      this.links.delete(id);
    }
  }

  /** @returns {PeerLink|null} */
  #create(id) {
    if (!this.#signaling.id) return null; // no session yet; nothing to be polite about
    const peer = this.roster.get(id);
    const link = new PeerLink({
      id,
      myId: this.#signaling.id,
      name: peer?.name,
      pubkey: peer?.pubkey,
      iceServers: this.#iceServers,
      signal: (data) => this.#signaling.signal(id, data),
    });
    this.links.set(id, link);
    this.emit('link', link);
    return link;
  }

  /** @returns {PeerLink|null} */
  linkTo(id) {
    return this.links.get(id) ?? this.#create(id);
  }

  closeAll() {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }
}
