// Integration checks for the signalling server, over a real WebSocket.
//
// These are the behaviours the client depends on and cannot see for itself: that
// two devices behind one address find each other without being told to, that a
// typed code beats the address, and — the one that matters most — that the relay
// will not carry a message to a peer outside the sender's room.

import { createServer } from 'node:http';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { WebSocket } from 'ws';
import { RATE, attachSignaling } from '../src/signaling.js';
import { createRequestHandler } from '../src/http.js';
import { LIMITS } from '../src/rooms.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

let signaling;
const server = createServer(createRequestHandler({
  roots: {},
  stats: () => signaling.stats(),
  startedAt: Date.now(),
}));
signaling = attachSignaling(server, { trustProxy: true, log: () => {} });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

/**
 * A test client that records everything the server sends, so an assertion can
 * wait for a specific message rather than guessing at timing.
 *
 * `forwardedFor` is how one process pretends to be several networks — the server
 * groups by address, and every socket here shares 127.0.0.1 otherwise.
 */
function connect(forwardedFor = '198.51.100.10') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { 'x-forwarded-for': forwardedFor },
  });
  const received = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    for (const [index, waiter] of waiters.entries()) {
      if (waiter.match(msg)) {
        waiters.splice(index, 1);
        waiter.resolve(msg);
        break;
      }
    }
  });

  const client = {
    ws,
    received,
    send: (msg) => ws.send(JSON.stringify(msg)),
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    closed: () => new Promise((resolve) => ws.once('close', (code) => resolve(code))),

    /** Wait for the next message of a type, or one matching a predicate. */
    expect(type, { timeout = 2500 } = {}) {
      const match = typeof type === 'function' ? type : (msg) => msg.t === type;
      const already = received.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) {
            waiters.splice(at, 1);
            reject(new Error(`timed out waiting for ${typeof type === 'function' ? 'a match' : type}`
              + ` (got: ${received.map((m) => m.t).join(', ') || 'nothing'})`));
          }
        }, timeout);
      });
    },

    /** Nothing of this type should arrive. Used for the isolation checks. */
    async expectNothing(type, ms = 350) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      const found = received.find((msg) => msg.t === type);
      ok(!found, `unexpectedly received ${type}: ${JSON.stringify(found)}`);
    },

    close: () => ws.close(),
  };
  return client;
}

const openClients = [];
async function client(ip, join = { mode: 'network' }) {
  const c = connect(ip);
  openClients.push(c);
  await c.open();
  if (join) c.send({ t: 'join', name: join.name ?? 'Device', pubkey: join.pubkey ?? null, ...join });
  return c;
}

// ── tests ────────────────────────────────────────────────────────────────────

console.log('\nSignalling server');

await test('one address, one room — no user action', async () => {
  const a = await client('203.0.113.1', { mode: 'network', name: 'Phone' });
  const welcomeA = await a.expect('welcome');
  strictEqual(welcomeA.room.kind, 'network');
  deepStrictEqual(welcomeA.peers, []);

  const b = await client('203.0.113.1', { mode: 'network', name: 'Laptop' });
  const welcomeB = await b.expect('welcome');
  strictEqual(welcomeB.peers.length, 1);
  strictEqual(welcomeB.peers[0].name, 'Phone');

  const joined = await a.expect('peer-joined');
  strictEqual(joined.peer.name, 'Laptop');
  strictEqual(joined.peer.id, welcomeB.id);
});

await test('different addresses do not see each other', async () => {
  const a = await client('203.0.113.20', { mode: 'network' });
  await a.expect('welcome');
  const b = await client('198.51.100.55', { mode: 'network' });
  const welcomeB = await b.expect('welcome');
  deepStrictEqual(welcomeB.peers, [], 'a different network is a different room');
  await a.expectNothing('peer-joined');
});

await test('a code beats the address, and case does not matter', async () => {
  const a = await client('203.0.113.30', { mode: 'code', code: 'K7M2Q', name: 'Projector' });
  const welcomeA = await a.expect('welcome');
  strictEqual(welcomeA.room.kind, 'code');
  strictEqual(welcomeA.room.code, 'K7M2Q');

  const b = await client('198.51.100.77', { mode: 'code', code: 'k7-m2q', name: 'Student' });
  const welcomeB = await b.expect('welcome');
  strictEqual(welcomeB.room.code, 'K7M2Q');
  strictEqual(welcomeB.peers.length, 1, 'found each other across networks');
  strictEqual(welcomeB.peers[0].name, 'Projector');
});

await test('the server mints a code on request', async () => {
  const a = await client('203.0.113.40', { mode: 'new' });
  const welcome = await a.expect('welcome');
  strictEqual(welcome.room.kind, 'code');
  strictEqual(welcome.room.code?.length, 5);
});

await test('signals are relayed verbatim', async () => {
  const a = await client('203.0.113.50', { mode: 'code', code: 'ABC12' });
  const b = await client('203.0.113.51', { mode: 'code', code: 'ABC12' });
  const welcomeA = await a.expect('welcome');
  const welcomeB = await b.expect('welcome');

  const payload = { desc: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' } };
  a.send({ t: 'signal', to: welcomeB.id, data: payload });

  const relayed = await b.expect('signal');
  strictEqual(relayed.from, welcomeA.id);
  deepStrictEqual(relayed.data, payload, 'not rewritten, not inspected');
});

await test('the relay will not reach outside the room', async () => {
  const inside = await client('203.0.113.60', { mode: 'code', code: 'ROOM1' });
  const outside = await client('203.0.113.60', { mode: 'code', code: 'ROOM2' });
  const welcomeOutside = await outside.expect('welcome');
  await inside.expect('welcome');

  inside.send({ t: 'signal', to: welcomeOutside.id, data: { candidate: 'nope' } });
  await outside.expectNothing('signal');
});

await test('a peer cannot signal itself', async () => {
  const a = await client('203.0.113.65', { mode: 'network' });
  const welcome = await a.expect('welcome');
  a.send({ t: 'signal', to: welcome.id, data: { candidate: 'loop' } });
  await a.expectNothing('signal');
});

await test('renaming is announced', async () => {
  const a = await client('203.0.113.70', { mode: 'network', name: 'Before' });
  const b = await client('203.0.113.70', { mode: 'network', name: 'Other' });
  await b.expect('welcome');
  const welcomeA = await a.expect('welcome');

  a.send({ t: 'rename', name: 'After' });
  const renamed = await b.expect('peer-renamed');
  strictEqual(renamed.id, welcomeA.id);
  strictEqual(renamed.name, 'After');
});

await test('a name is sanitised before anyone else sees it', async () => {
  const hostile = `Ev il‮exe`;
  const a = await client('203.0.113.75', { mode: 'network', name: 'Watcher' });
  await a.expect('welcome');
  const b = await client('203.0.113.75', { mode: 'network', name: hostile });
  await b.expect('welcome');

  const joined = await a.expect('peer-joined');
  ok(!joined.peer.name.includes(' '), 'no control character');
  ok(!joined.peer.name.includes('‮'), 'no bidi override');
  strictEqual(joined.peer.name, 'Evilexe');
});

await test('an invalid code is refused and the device still lands somewhere', async () => {
  const a = await client('203.0.113.80', { mode: 'code', code: 'not-a-code' });
  const error = await a.expect('error');
  strictEqual(error.code, 'bad-code');
  // First join, so there is nothing to fall back from — the client retries.
  a.send({ t: 'join', mode: 'network', name: 'Recovered' });
  const welcome = await a.expect('welcome');
  strictEqual(welcome.room.kind, 'network');
});

await test('switching rooms tells the old room you left', async () => {
  const stayer = await client('203.0.113.90', { mode: 'code', code: 'STAY1' });
  const mover = await client('203.0.113.91', { mode: 'code', code: 'STAY1' });
  await stayer.expect('welcome');
  const welcomeMover = await mover.expect('welcome');
  await stayer.expect('peer-joined');

  mover.send({ t: 'join', mode: 'code', code: 'ZQ9V4', name: 'Device' });
  const left = await stayer.expect('peer-left');
  strictEqual(left.id, welcomeMover.id);

  const moved = await mover.expect('room');
  strictEqual(moved.room.code, 'ZQ9V4');
});

await test('an ambiguous letter in a code folds rather than failing', async () => {
  // O and I are not in the alphabet. A device whose user typed them still has to
  // land in the same room as one that typed the code as printed.
  const a = await client('203.0.113.92', { mode: 'code', code: 'OI2VW' });
  const welcome = await a.expect('welcome');
  strictEqual(welcome.room.code, '012VW');

  const b = await client('203.0.113.93', { mode: 'code', code: '012vw' });
  const welcomeB = await b.expect('welcome');
  strictEqual(welcomeB.peers.length, 1, 'both folded onto the same room');
});

await test('a disconnect is announced', async () => {
  const stayer = await client('203.0.113.95', { mode: 'network' });
  const leaver = await client('203.0.113.95', { mode: 'network' });
  await stayer.expect('welcome');
  const welcomeLeaver = await leaver.expect('welcome');
  await stayer.expect('peer-joined');

  leaver.close();
  const left = await stayer.expect('peer-left');
  strictEqual(left.id, welcomeLeaver.id);
});

await test('ping is answered', async () => {
  const a = await client('203.0.113.100', { mode: 'network' });
  await a.expect('welcome');
  a.send({ t: 'ping' });
  await a.expect('pong');
});

await test('a network room caps out and points at room codes', async () => {
  const ip = '203.0.113.110';
  for (let i = 0; i < LIMITS.networkRoomPeers; i++) {
    const c = await client(ip, { mode: 'network', name: `d${i}` });
    await c.expect('welcome');
  }
  const overflow = await client(ip, { mode: 'network', name: 'unlucky' });
  const error = await overflow.expect('error');
  strictEqual(error.code, 'room-full');
  ok(error.message.includes('room code'), 'the message names the way out');
});

await test('the socket cap leaves room for a whole class behind one router', async () => {
  // Every device behind one NAT shares a public address, so this limit has to
  // clear the room caps or auto-discovery breaks for exactly the crowd it is for.
  ok(RATE.socketsPerIp > LIMITS.codeRoomPeers,
    `socketsPerIp (${RATE.socketsPerIp}) must exceed codeRoomPeers (${LIMITS.codeRoomPeers})`);

  const ip = '203.0.113.120';
  for (let i = 0; i < RATE.socketsPerIp; i++) {
    const c = connect(ip);
    openClients.push(c);
    await c.open();
  }
  const extra = connect(ip);
  openClients.push(extra);
  await extra.open();
  const error = await extra.expect('error');
  strictEqual(error.code, 'too-many');
  strictEqual(await extra.closed(), 1008);
});

await test('a flood is cut off rather than served', async () => {
  const a = await client('203.0.113.130', { mode: 'network' });
  await a.expect('welcome');
  for (let i = 0; i < 400; i++) a.send({ t: 'ping' });
  const error = await a.expect('error', { timeout: 3000 });
  strictEqual(error.code, 'rate');
  strictEqual(await a.closed(), 1008);
});

await test('malformed input is ignored, not fatal', async () => {
  const a = await client('203.0.113.140', { mode: 'network' });
  await a.expect('welcome');
  a.ws.send('not json at all');
  a.ws.send(JSON.stringify([1, 2, 3]));
  a.ws.send(JSON.stringify({ t: 'nonsense' }));
  a.send({ t: 'ping' });
  await a.expect('pong', { timeout: 2000 });
  strictEqual(a.ws.readyState, WebSocket.OPEN);
});

await test('health reflects live state and rooms are released', async () => {
  const before = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  ok(before.ok);

  const a = await client('203.0.113.150', { mode: 'code', code: 'HLTH1' });
  await a.expect('welcome');
  const during = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  ok(during.peers > before.peers, 'the new peer is counted');

  a.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  strictEqual(after.peers, before.peers, 'peer count returns');
});

// ── teardown ─────────────────────────────────────────────────────────────────

for (const c of openClients) {
  try { c.ws.terminate(); } catch { /* already gone */ }
}
signaling.close();
await new Promise((resolve) => server.close(resolve));

console.log(`\n${failed ? 'FAILED' : 'passed'}: ${passed} checks ok, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
