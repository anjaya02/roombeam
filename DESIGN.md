# RoomBeam — Design Document

**Files, straight across.**

**Status:** M4 delivered — room codes, robust transfer, PWA, diagnostics. M5 (broadcast) and M6 (folders) not started.
**Package / repo name:** `roombeam`
**Licence:** Proprietary — all rights reserved. Not open source.
**Last updated:** 2026-07-26

---

## 1. The problem

Every major platform has built-in nearby sharing. None of them talk to each other.

| Pair | Built-in nearby transfer? |
|---|---|
| Android ↔ Android | Yes — Quick Share |
| iPhone/Mac ↔ iPhone/Mac | Yes — AirDrop |
| Windows ↔ Windows | Yes — Nearby Sharing |
| Android ↔ iPhone/Mac | Partial — Quick Share↔AirDrop interop exists on recent Pixel devices only |
| Android ↔ Windows | Requires installing Google's Quick Share app |
| Mac ↔ Windows | **Nothing.** SMB share setup only |
| iPhone ↔ Windows | **Nothing.** SMB via Files → Connect to Server only |

The missing piece is not "a way to move files" — it's **a way that requires no install, no account, no cloud, and no network configuration, and works between any two devices in the same room.**

### Goal

A web app. You open a URL on both devices, they see each other, you pick a file, it transfers. The file data travels device-to-device over the local network and never touches a server.

### Explicit non-goal

Replacing AirDrop *within* the Apple ecosystem, or Quick Share within Android. Those work. The value is entirely in the cross-vendor pairs — especially **Mac ↔ Windows** and **iPhone ↔ Windows**, which have nothing at all.

---

## 2. The constraint that shapes everything

**A browser cannot discover devices on a local network.** There is no mDNS API, no UDP broadcast, no raw sockets, no port binding. This is the sandbox working as designed, and there is no flag or workaround.

Consequences:

1. **Discovery requires a rendezvous point.** Two browsers on the same Wi-Fi cannot find each other unaided. Something must introduce them — a server they both reach, or a human-mediated channel (QR code, typed room code).
2. **Therefore "zero infrastructure" is impossible for a web app.** Any project claiming otherwise is either a native app or is using a server it isn't telling you about.
3. **But the *data path* can still be fully local.** WebRTC establishes a direct peer-to-peer connection. On the same network, ICE selects local candidates and packets go device→router→device. The signaling server learns that two peers want to talk; it never sees a byte of the file.

### The promise we can actually make

> Discovery uses the internet. **File contents never leave your local network.**

This is precise, honest, and — importantly — **verifiable in code**. See §7.3.

---

## 3. Architecture

```
┌──────────────┐                                    ┌──────────────┐
│   Device A   │                                    │   Device B   │
│  (browser)   │                                    │  (browser)   │
└──────┬───────┘                                    └───────┬──────┘
       │                                                    │
       │  1. WebSocket: join room, exchange SDP + ICE       │
       └────────────────┐                  ┌────────────────┘
                        ▼                  ▼
                  ┌──────────────────────────────┐
                  │   Signaling server (tiny)    │   ← internet
                  │   Sees: IPs, device names,   │
                  │   room membership. No files. │
                  └──────────────────────────────┘

       ┌────────────────────────────────────────────────────┐
       │  2. WebRTC DataChannel — file bytes, DTLS encrypted │  ← LAN only
       │     A ──────────── local router ─────────────── B  │
       └────────────────────────────────────────────────────┘
```

Three components:

| Component | What it is | Where it runs |
|---|---|---|
| **Client** | Installable PWA, static files | Any browser |
| **Signaling server** | ~450 lines, WebSocket, in-memory rooms | Small VPS / Cloudflare / self-hosted |
| **Transport** | WebRTC DataChannel | Peer-to-peer on the LAN |

The signaling server is stateless across restarts, holds no database, and stores nothing on disk. A dropped signaling connection does not interrupt an in-flight transfer — once the DataChannel is open, the server is irrelevant.

---

## 4. Discovery

Two mechanisms, both always available, because each fails in cases the other survives.

### 4.1 Automatic — public IP grouping

On WebSocket connect, the server hashes the client's public IP (salted, never stored) and places the peer in a room keyed by that hash. Devices behind the same NAT auto-appear to each other. Zero user action.

**Fails when:** one device is on cellular; devices are on a VPN; the network uses carrier-grade NAT with rotating egress; IPv6 with per-device addresses; enterprise networks with multiple egress IPs.

### 4.2 Manual — room code + QR

A 5-character code (Crockford base32, ambiguity-free alphabet: no `I`/`L`/`O`/`U`) creates an explicit room. One device displays the code plus a QR encoding `https://app/#/r/ABC12`. Others scan or type.

**Always works**, including across different networks, and is the better UX for the classroom case anyway — the teacher shows a QR on the projector.

### 4.3 Peer identity

- Ephemeral session ID (UUID) per connection.
- Human-readable device name, auto-generated (`Quiet Otter`, `Brass Kettle`) and editable, persisted in `localStorage`.
- A stable per-device key pair in IndexedDB, used to mark devices as "known" on repeat visits.

**No accounts. No sign-in. Ever.** This is a feature, not a shortcut.

### 4.4 Signaling protocol

JSON over WebSocket. Deliberately minimal:

```
→ join          { mode: 'network'|'code'|'new', code?, name, pubkey }
← welcome       { id, room: { kind, code, size }, peers: [{ id, name, pubkey }] }
← room          { room, peers }        // after switching rooms on the same socket
← peer-joined   { peer: { id, name, pubkey } }
← peer-left     { id }
→ rename        { name }               // and ← peer-renamed { id, name }
↔ signal        { to, from, data: <SDP offer|answer|ICE candidate> }
→ ping / ← pong (keepalive; many hosts drop idle WS at 60s)
← error         { code, message, fatal? }
```

`mode: 'new'` asks the server to mint an unused code, because only the server can know which codes are live.

Rooms can be switched on an existing socket rather than by reconnecting — a peer that changes rooms is announced as having left the old one. Reconnecting instead would mean a new session id and a device that appears to vanish and return.

File metadata is **not** sent through signaling — it goes over the DataChannel, so the server never learns filenames.

**One check on the relay matters:** a `signal` is only delivered if the target is in the *same room* as the sender. Without it, a socket could use the relay to reach any peer whose id it could guess, and room membership would be advisory rather than a boundary.

---

## 5. Transport

### 5.1 Connection

Standard WebRTC. `RTCPeerConnection` with a DataChannel:

```js
{ ordered: true, negotiated: false }   // reliable, in-order — simplest correct choice
```

**ICE configuration:**
- Host candidates are sufficient for same-LAN peers. Browsers replace local IPs with mDNS `.local` candidates for privacy; both peers resolve these locally, which works on Windows 10+, macOS, iOS, and Android.
- One STUN server, for the cross-network case.
- **No TURN by default.** TURN relays file bytes through a server on the internet, which breaks the core promise. If ever added it must be opt-in with an unmissable warning.

### 5.2 Chunking and flow control

This is where naive implementations fall over. Non-negotiable details:

- **Chunk size:** `min(pc.sctp.maxMessageSize, 262144)`, with a floor of **16 KiB** for maximum interop. Chrome reports 256 KiB; older stacks are lower. Negotiate, don't assume. Measured: Chromium reports 262,144 and the app uses 248,832 — 95% of the reported limit, because hitting it exactly is historically where interop breaks, and exceeding it closes the channel outright rather than erroring.
- **Backpressure is mandatory.** Writing to a DataChannel in a tight loop buffers in memory and kills the tab.

```js
const HIGH = 8 * 1024 * 1024;   // pause above this
const LOW  = 1 * 1024 * 1024;   // resume below this

dc.bufferedAmountLowThreshold = LOW;
if (dc.bufferedAmount > HIGH) {
  await new Promise(r => dc.addEventListener('bufferedamountlow', r, { once: true }));
}
dc.send(chunk);
```

- **Read the source file incrementally** via `File.stream()` → `ReadableStream`, never `file.arrayBuffer()`. A 2 GB `arrayBuffer()` call is an instant crash on mobile.
- Expected throughput: **10–50 MB/s** over Wi-Fi 5/6, higher on wired. The limit is SCTP overhead and single-threaded JS, not the network.

### 5.3 Wire protocol

Control messages as JSON strings, payload as `ArrayBuffer`, distinguished by `typeof event.data === 'string'`. No custom binary framing needed.

```
↔ hello         { version, name, pubkey, nonce }        // on channel open
↔ hello-proof   { signature }                           // see §7.2
→ offer-files   { transferId, files: [{ id, name, size, mime, mtime }] }
← accept        { transferId, fileIds: [...] }          // or decline
→ file-start    { transferId, fileId, chunkSize, offset }
→ <binary chunk> × n                                    // sequential, in order
→ file-end      { transferId, fileId, bytes, crc }
← file-skip     { transferId, fileId, reason }          // receiver could not take this one
← progress      { transferId, fileId, received }        // the authoritative count
← flow          { transferId, pause }                   // storage backpressure
↔ cancel        { transferId, fileId?, reason }
→ resume-query  { transferId }                          // reconnect path
← resume-from   { transferId, fileId, available, offset }
```

Notes:
- **Receiver never auto-accepts.** Every incoming transfer requires an explicit tap. This is the primary defence against unwanted files from strangers on shared Wi-Fi.
- **Progress flows backwards, from receiver to sender.** The sender only knows what it handed to the network stack, which overstates progress and never matches reality. The receiver's count is the one displayed on both ends.
- **`flow` exists because the two queues are independent.** The sender's backpressure watches the DataChannel buffer; that says nothing about whether the receiver's storage is keeping up. Without a way for the receiver to say "hold on", a slow disk turns into unbounded memory growth on the receiving side over a long transfer.
- Integrity checking is *optional*. SCTP is reliable and checksummed; hashing 1 GB in JS costs real seconds. **Shipped on by default**, because it can be made free: the sender hashes in a worker that reads the file itself rather than being handed copies of every chunk, and the receiver folds the checksum in inside the storage worker on bytes it already holds. Neither competes with the send loop.
- **`resume-from` carries a byte offset, not a chunk index.** SCTP delivers whole messages, so the receiver always holds a chunk boundary — but a byte offset also survives the two ends negotiating a different chunk size after reconnecting, which a chunk index would silently misinterpret.
- **Every message is validated into a known shape at the boundary**, once, so no handler downstream has to wonder. §14.3 records what happens when one of those validators is wrong.

---

## 6. The hard part: writing files on the receiving end

Sending is easy and uniform. **Receiving is where platform differences bite**, and it determines the maximum file size the app supports on each device.

Capability cascade — detect at runtime, use the best available:

| Tier | API | Where | Size limit |
|---|---|---|---|
| 1a | `showDirectoryPicker()`, then one file handle per file | Chromium desktop | Free disk space |
| 1b | `showSaveFilePicker()` + `FileSystemWritableFileStream` | Chromium desktop **and Android Chrome** (measured — see §14) | Free disk space |
| 2 | **OPFS** + `createSyncAccessHandle()` in a Worker, then hand off a `Blob` | Chrome, Edge, Firefox, **Safari 15.2+**, Android Chrome | Storage quota |
| 3 | Service-worker-intercepted streaming download | Chromium, Firefox | Unbounded, fiddly |
| 4 | In-memory `Blob` + `<a download>` | Everything | **RAM — small files only** |

Tier 1a is a late addition and it is not a refinement — it is the difference between a multi-file transfer working and not. A save dialog is only permitted while a user gesture is still active, and the accept tap is the only gesture available, so there is no way to ask twice. One folder dialog covers every file in the offer; without it, a multi-file transfer on Chromium has to fall back to a streaming tier for want of a second gesture. The same constraint has a second consequence: **the code path from the accept tap to the dialog must not `await` anything**, which is why capability detection is split into a synchronous half and an asynchronous one.

**Tier 2 is the workhorse.** The Origin Private File System lets you stream to disk on iOS and Android without holding the file in RAM, then produce a `Blob` for the download at the end. Without it, mobile large-file transfer is not viable. Implement Tier 2 first, not Tier 1.

Storage quota is the real ceiling: Chromium grants roughly 60% of free disk; Safari starts near 1 GB per origin and prompts for more. Query `navigator.storage.estimate()` **before** accepting a transfer and refuse with a clear message rather than failing at 90%.

### 6.1 iOS Safari — the hardest surface

Worth calling out separately, since iPhone ↔ Windows is one of the two pairs with no existing solution and therefore a headline use case:

- No `showSaveFilePicker`. OPFS in a Worker is the only viable large-file path.
- In-memory blobs die somewhere in the low hundreds of MB. Tier 4 is not a real fallback here.
- **Backgrounding the tab suspends the transfer.** Screen Wake Lock exists in Safari 16.4+, but should not be relied on — detect `visibilitychange`, pause cleanly, and use `resume-from` on return.
- Add to Home Screen gives a proper PWA with a cached shell; service workers work.
- Completed files land in Downloads and are reachable via the Files app.

### 6.2 Test matrix

Every combination needs a real device check. Emulators do not reproduce these behaviours.

| | Win Chromium | Win Firefox | macOS Safari | iOS Safari | Android Chrome |
|---|---|---|---|---|---|
| **Win Chromium** | ✔ auto | — | — | — | ✔ M1 |
| **macOS Safari** | ★ — | — | — | — | — |
| **iOS Safari** | ★ — | — | — | — | — |
| **Android Chrome** | ✔ M1 | — | — | — | — |

★ = the pairs that justify the project's existence. Get these right first.
✔ auto = covered by the end-to-end test on every run. ✔ M1 = verified once, by hand.

Both ★ rows are still empty, and no amount of automated Chromium testing will fill them. That is the honest state of this project: the two pairs it exists for have never been tried.

---

## 7. Security and privacy

### 7.1 What each party can see

| Party | Sees |
|---|---|
| Signaling server | Public IP, device name, public key, room membership, timestamps. **Not** filenames, not file contents. |
| Other peers in an auto-IP room | Your device name and that you are present |
| Network operator | Encrypted DTLS packets between two local IPs |
| Us | Nothing persistent — no logs of content, no accounts, no analytics on transfers |

### 7.2 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Stranger on shared Wi-Fi sends unwanted files | Mandatory explicit accept per transfer; never auto-download |
| Stranger enumerates devices in an auto-IP room | Room codes for sensitive contexts; names are user-chosen and non-identifying by default |
| Malicious filename — `../../`, null bytes, RTL-override extension spoofing (`photo.txt‮gpj.exe`) | Strict sanitization: strip path separators and control chars, reject bidi overrides, always display the true final extension |
| Malicious file content | Out of scope to scan; surface true name/size/type prominently and warn on executable extensions |
| Signaling server abuse / spam | Per-IP connection and message rate limits; room size caps; short idle timeouts |
| MITM on the LAN | DataChannel is DTLS-encrypted with fingerprints exchanged via signaling over WSS |
| Malicious *signaling server* substituting DTLS fingerprints | **Mitigated, and it turned out to be cheap.** Two mechanisms, one for each case — see below |

This was originally listed as a residual risk worth designing but not necessarily shipping. It shipped, because once the device key pair from §4.3 exists the rest is about forty lines.

**Devices you have met before.** A peer proves possession of its key by signing a challenge — and what it signs includes **its own DTLS fingerprint**:

```
signature over: prefix | verifier's nonce | verifier's key | prover's key | prover's fingerprint
```

The fingerprint is the load-bearing part. A signature over the nonce alone proves the peer holds its key, which a relay in the middle can pass along unchanged. Binding it to the fingerprint means the verifier checks it against the fingerprint **it actually received** — and a relay, presenting its own encryption to each side, cannot make those agree. A mismatch is reported distinctly from "unverified", because "this key is bound to a different connection" is a different statement from "there was no key to check".

Without this, a public-key device identity is decoration: an identifier anybody could copy, proving nothing.

**First contact**, where there is no remembered key to check against, falls back to two humans comparing a number. A short code derived from both DTLS fingerprints, sorted so both ends compute the same one. Anything sitting in the middle makes the two devices show different codes.

### 7.3 Enforcing the local-only promise

The privacy claim should be a mechanism, not marketing. After ICE completes, inspect the selected candidate pair:

```js
const stats = await pc.getStats();
// find the succeeded candidate-pair, then its local/remote candidate types
// 'host' / 'prflx' → local network. 'srflx' → traversing NAT. 'relay' → through a server.
```

If the selected path is not local, **say so in the UI before transferring** — a small badge distinguishing "Local network" from "Internet route", and a setting to refuse non-local paths entirely. That turns the promise into something the user can check.

---

## 8. Known failure modes

Things that will break in the field, ordered by how often you'll hit them:

1. **Client isolation / AP isolation.** Extremely common on school, café, hotel, and guest Wi-Fi. The access point forbids client-to-client traffic, which silently kills all LAN peer-to-peer. **This is the single biggest real-world blocker.** Detect it (ICE completes but no local candidate pair succeeds) and explain it clearly instead of spinning forever. A recovery path exists — see §10.
2. **Symmetric NAT / restrictive corporate firewalls** — no direct path without TURN.
3. **Device on cellular, other on Wi-Fi** — not actually local; auto-discovery won't group them and no local path exists.
4. **mDNS resolution failures** on hardened or unusual network stacks.
5. **iOS tab suspension** mid-transfer (§6.1).
6. **Storage quota exhaustion** on the receiver (§6).
7. **Firefox ↔ Safari** WebRTC interop quirks — historically the most fragile pair. Test explicitly.

---

## 9. Stack

| Concern | Choice | Why |
|---|---|---|
| Build | **None.** ES modules served directly | *Changed from Vite + TypeScript.* See below |
| UI | **Plain DOM**, one small render module | *Changed from Svelte.* See below |
| PWA | Hand-written service worker | It has a second job anyway — the streaming-download receive tier (§6, tier 3) — and that is not something a generated Workbox config expresses |
| Signaling | **Node + `ws`** | ~450 lines across five files, trivially self-hostable. *Cloudflare Durable Objects is a strong alternative for room state, at the cost of self-hosting simplicity.* |
| QR | **Encoder written from scratch**; native `BarcodeDetector` for scanning, no fallback | See below |
| Tests | Three layers, no framework: unit, signalling integration over a real WebSocket, and end-to-end driving a headless browser over the DevTools Protocol | See §14.2 |
| Hosting | Static host + one small always-on process for signaling | |

**Why no build step.** §9 originally specified Vite, TypeScript and Svelte, and the stated reason for Svelte was that bundle size matters on a phone opening a cold URL. Taken seriously, that argument goes one step further: no framework and no bundler is smaller than any bundle, and the app is a device list, a transfer list and a settings dialog — there is no state-synchronisation problem here that a framework solves. What was given up is real and worth naming: no type checking on the wire protocol, which is exactly where §14.3's most expensive bug lived. The mitigation is that every message is validated into a known shape at one boundary, and that the validators are tested.

The second reason is the development loop. Testing this app means real devices on real Wi-Fi, repeatedly, and a build step sits between every edit and every retest.

**Why the QR encoder is hand-written.** Using `qrcode` from npm would mean either a bundler or vendoring third-party source into the repo. The encoder is about 300 lines, the specification is unambiguous, and — the deciding factor — it can be *verified*: an independently written decoder reads the output back and confirms the payload survives. A QR encoder has no useful middle ground between working and producing a picture that quietly will not scan, so a test that reads it back is worth more than a dependency.

**Why no QR decoder.** Scanning uses `BarcodeDetector` where it exists and typing the five characters everywhere else. Writing a decoder is a far larger problem than an encoder — perspective correction, thresholding, error correction — and iOS does not need it: the system camera scans a QR and opens the link, which is the same journey with fewer steps. Displaying the QR is what has to work everywhere, and that is the encoder's job.

Licence: **proprietary, all rights reserved**. Decided — see §13.

---

## 10. Roadmap

| Milestone | Deliverable | Status |
|---|---|---|
| **M0** | This document | Done |
| **M1** | Proof of concept: two browsers, hardcoded room, one file over the LAN | Done — §14 |
| **M2** | Signaling server; **QR + room code as the primary path**; auto-IP grouping as a bonus that may fail | **Done** — §14.2 |
| **M3** | Robust transfer: negotiated chunk size, backpressure, OPFS receive, **resume**, progress, cancel, multi-file | **Done**, except resume across a page reload — §14.2 |
| **M4** | PWA, device names, accept prompts, local-path badge, **diagnostics panel** | **Done** — §14.2 |
| **M5** | One-to-many broadcast (classroom mode) | Not started — see below |
| **M6** | Folder transfer, self-hosting Compose file + `/health` self-check | `/health` shipped early with M2, because a deployment needs something to point at. The rest not started |

The order held up. Two things are worth recording about *why*:

M2 before M3 was right for a reason that only became visible in testing: room codes are what let two devices be put in the same room *on purpose*, which is a precondition for testing anything else repeatedly. Automatic grouping cannot be pointed at a specific pair.

M4 was not the cosmetic milestone it looks like in this table. The diagnostics work is what found three of the four defects in §14.3 — a panel that reports why something failed also reports when your own code is the reason.

### M5 — classroom broadcast, in more detail

One person sending one file to thirty is a fundamentally different problem from a 1:1 send, not a loop around it — and it is the motivating use case for RoomBeam: a classroom, a workshop, a meeting where everyone needs the same handout.

Naive approach: N parallel DataChannels from the sender. 30 receivers × 50 MB = 1.5 GB of upload from one laptop, and thirty simultaneous streams will collapse Wi-Fi throughput through contention. Mitigation: a queue with bounded parallelism (~4 concurrent) rather than a fan-out.

Better, much harder: **receivers who finish become seeders.** Sender uploads once; the swarm distributes. This is BitTorrent-shaped and a significant complexity jump — correct as a v3 ambition, wrong as a v1 scope.

### The offline escape hatch (post-M6)

For networks where §8.1 client isolation blocks everything, and for genuinely internet-free environments, there's a second architecture worth keeping in mind:

One person runs a small Node binary on their laptop. Everyone else opens `http://thatlaptop.local:8080`. Files relay through the host over plain WebSocket at LAN speed. Crucially this **sidesteps the secure-context requirement** that makes self-hosted WebRTC painful (§11), needs no certificates, and requires no install for anyone but the host. Add WebCrypto with a key derived from the room code so the host machine cannot read what passes through it.

Out of scope for v1 given the "internet is fine for loading" decision — but it's the fallback that survives hostile networks, so don't design the transport layer in a way that forecloses it. **Keep transport behind an interface.**

---

## 11. Development environment

One practical trap, worth knowing before day one because it will otherwise cost an afternoon:

**WebRTC requires a secure context.** `localhost` counts. **A LAN IP does not.** So the obvious dev loop — `vite --host`, open `http://192.168.1.42:5173` on your phone — will fail with WebRTC unavailable, and the error message will not tell you why.

Options, best first:

1. **A quick tunnel** (`cloudflared tunnel --url http://localhost:5173`) — gives a real HTTPS origin, works on every device including iOS, zero certificate wrangling. Best for phone testing.
2. **`vite-plugin-mkcert`** — local CA, real HTTPS on the LAN IP. Desktop-to-desktop is easy; iOS requires manually installing and trusting the CA profile.
3. **Chrome's `--unsafely-treat-insecure-origin-as-secure`** flag — desktop debugging only.

Also on Windows: the first `vite --host` will trigger a Windows Firewall prompt. Allow it on private networks, or the phone gets a connection timeout with no explanation.

---

## 12. Decisions made, and what was rejected

| Decision | Rejected alternative | Reasoning |
|---|---|---|
| Internet for discovery, LAN for data | Fully offline from day one | User's call: "no internet usage for file sharing, loading can still take some internet." Removes the secure-context and self-hosting problems from v1 entirely |
| WebRTC DataChannel | WebSocket relay through a server | Relay means file bytes cross the internet — breaks the core promise |
| WebRTC DataChannel | WebTransport | Needs a server endpoint; not peer-to-peer |
| Explicit accept per transfer | Auto-accept from known devices | Shared Wi-Fi makes auto-accept unsafe; convenience is not worth it |
| No TURN by default | TURN for reliability | TURN routes file data through a server. Reliability is not worth silently breaking the promise |
| OPFS (Tier 2) before `showSaveFilePicker` (Tier 1) | Desktop-first | Mobile is the harder constraint and the primary use case. Build for the hard case first |
| No accounts | Optional sign-in for device memory | Accounts imply a database, which implies liability. Public-key device identity gets the same result |
| **No build step** — ES modules served directly | Vite + TypeScript + Svelte, as §9 originally specified | The stated reason for Svelte was bundle size on a phone opening a cold URL; no bundle is smaller than a small one, and there is no state-synchronisation problem here that a framework solves. Also removes a build from every real-device retest — which is the loop that actually finds bugs in this project. Cost: no type checking on the wire protocol, mitigated by validating every message at one boundary and testing those validators |
| **Both peers may open a DataChannel** | Arbitrating a single shared channel | Two simultaneous sends produce two channels rather than a conflict, and a transfer binds to the channel it started on. Markedly less machinery than electing one, and glare in the *signalling* is already handled by perfect negotiation |
| **Progress reported by the receiver** | Sender-side progress from `bufferedAmount` | The sender only knows what it queued. M1 shipped the optimistic version and it overstated progress; the number the user watches should be the one that is true |
| **Checksums on by default** | Off by default, as §5.2 proposed | The objection was cost. Neither end pays it if neither hashes on the thread doing the work — see §13.3 |

---

## 13. Open questions

1. ~~**Licence**~~ — **resolved: proprietary, all rights reserved.** The repository is private and the project is not being distributed, so no licence grant is made to anyone.

   Worth being precise about why this is not merely "we left the LICENSE file out". A permissive licence is an *irrevocable* grant to every copy already handed over: publishing MIT and then going private does not take the grant back from anyone who received the code in the meantime. So the file states the reservation explicitly rather than relying on the absence of one.

   This closes the open question in the opposite direction from the one it was asked in — it was originally about unblocking outside contributions, and there will not be any. What it does *not* change: the dependency policy in §9 and the provenance claim below still matter, because a proprietary project has more reason to know exactly what third-party code it contains, not less.
2. **Maximum supported file size**, per platform tier — still open, and now the *right* kind of open: the app reports which tier a device landed on and refuses a transfer it cannot fit, so the failure is a message rather than a mystery. What is missing is the measured number per platform.
3. ~~**Integrity checking** — default on or off?~~ — **resolved: on.** The question assumed hashing has to cost throughput. It does not, if neither end hashes on the thread doing the work: the sender's worker reads the file itself rather than being handed copies, and the receiver folds it in inside the storage worker on bytes already in hand.
4. **Name and domain.** Still open.
5. **Does M5's bounded-parallelism queue actually hold up** with 30 devices on one access point? Unknown until tested with real hardware; may force the swarm design earlier than planned.
6. **Signaling server abuse at scale** — if this gets popular, what does hosting cost and how is it funded without ads or accounts?
7. **New: is the receiver's storage the throughput ceiling on real hardware?** §14.4 shows it costs roughly two thirds of receive time in a loopback measurement, which is suggestive and not conclusive. The measurement to run is in §14.4.

---

## 14. Measured results

First real run: **Windows 11 / Edge** ↔ **Android Chrome**, same Wi-Fi, 2026-07-26.

### 14.0 M1 — first real run

Windows 11 / Edge to Android Chrome, same Wi-Fi, 2026-07-26.

#### What worked

| Check | Result |
|---|---|
| Peer discovery over signalling | Both devices appeared to each other |
| WebRTC connection, PC → Android | Established |
| **Data path** | **`local network`** — confirmed via ICE candidate-pair inspection (§7.3). The bytes stayed on the LAN. |
| Receive-side storage tier | `disk (File System Access)` on **both** devices |
| Accept/decline prompt | Worked; gated the transfer as designed |

The central premise is proven: **a browser-to-browser transfer whose data path never leaves the local network works, and the app can prove it did.**

#### Finding 1 — Tier 1 is available on Android Chrome

§6 originally claimed `showSaveFilePicker()` was Chromium-desktop-only. Measured: Android Chrome reported it **available**, and the phone received via `disk (File System Access)`, not OPFS. The table above is corrected.

This is good news, and it narrows the problem: the storage-tier risk is now **specifically an iOS Safari problem**, not a mobile problem. Untested — no iPhone in this run.

#### Finding 2 — throughput is bad: ~2 MB/s

A 1.2 GB file moved PC → Android at **2.0 MB/s** (receiver measured 1.9 MB/s). Expected range was 10–50 MB/s. At this rate that file needs ~10 minutes, which is not shippable.

Unresolved. Candidate causes, roughly in order of suspicion:

1. **Serialized disk writes on the receiver.** Every chunk is `await w.write(chunk)` before the next message is processed, so storage latency, not the network, may set the pace. Android flash writes through the File System Access layer could plausibly cap here.
2. **Actual Wi-Fi link quality.** 2 MB/s ≈ 16 Mbps, entirely plausible for a weak 2.4 GHz link. Needs ruling out before touching any code.
3. Per-chunk `file.slice().arrayBuffer()` overhead — ~4,800 async reads for this file.
4. Main-thread CRC32 competing with the send loop.

**The experiment that separates these:** a discard mode on the receiver that counts bytes without writing them. If throughput jumps, it is cause 1. If it does not, it is cause 2 and no amount of code will fix it. Run a plain LAN speed test between the same two devices first — that bounds what is achievable and costs nothing.

Do not optimise before this measurement. Tuning the wrong layer is how a performance bug becomes permanent.

#### Finding 3 — connection failed in one direction

Android → PC failed to connect while PC → Android succeeded moments later, same devices, same network. Not diagnosed; the failure message was too vague to distinguish "the other side never replied" from "every route was tried and failed" — fixed since (§14.1).

Whether this is a genuine directional asymmetry or ordinary first-attempt flakiness is unknown. Needs repeat runs in both directions.

### 14.1 Fixes made after the M1 run

Three defects the run exposed:

- **`peer-left` tore down live connections.** The handler closed the `RTCPeerConnection` whenever the signalling socket reported a peer gone. Mobile browsers drop WebSockets routinely, so this aborted healthy transfers and directly contradicted the §3 claim that signalling loss cannot interrupt a transfer. Now a connection is only discarded when it is genuinely idle.
- **Status text never advanced past "Waiting to accept."** A transfer showed 58 MB / 1.2 GB moving at 2.0 MB/s while still claiming it was waiting for permission.
- **Failure diagnosis conflated three distinct causes.** "No candidates at all" was reported when the real situation was "no pair was formed." Now separated into no-local-candidates (VPN), no-remote-candidates (other side never replied), no-pair (stalled handshake), and all-pairs-failed (client isolation).

### 14.2 M2–M4 results

Built and verified: room codes and QR, negotiated chunk sizes, real backpressure, flow control, the OPFS worker receive path, resume, cancel, multi-file, the PWA, device verification, and the diagnostics panel.

**Verified how.** Three test layers, because they catch different things:

| Layer | Count | What it can prove |
|---|---|---|
| Unit | 45 | The QR encoder round-trips through an independently written decoder at every version and error level. Room-code folding, filename hygiene, CRC-32 against the standard check value, room membership and caps |
| Signalling integration, over a real WebSocket | 19 | Automatic grouping, codes beating addresses, rate limits, and that the relay will not carry a message to a peer outside the sender's room |
| End-to-end, two tabs in a headless browser | 24 | A file dropped on a device row, accepted on the other side, arriving intact over a route both ends report as local |

The end-to-end layer drives the interface a person uses — a drop event and a tap on Accept — with no test hooks in the app, so nothing can pass because of a back door. It is worth the trouble: **it found four defects that no amount of reading found**, and three of them were invisible from the outside (§14.3).

What the automated layer still cannot reach: any Apple device, Firefox, a hostile network, and real Wi-Fi throughput.

### 14.3 Defects found after the fact

Four came out of the end-to-end test. The rest came from a review pass afterwards
and share a family resemblance worth naming: **every one was a slow leak or a
silent stall, not a crash.** A test suite that only checks for thrown errors would
have passed all of them.

| Defect | Symptom it would have produced |
|---|---|
| A save link minted a fresh `URL.createObjectURL` on every render | One leaked object URL per repaint, each pinning an entire received file in storage |
| The backpressure wait attached a `close` listener per chunk | Thousands of listeners over a large file, and an unhandled rejection when the channel later closed normally |
| Deleting the OPFS file when the user clicked **Save** | A download truncated by tidying up, on exactly the tier that handles the largest files |
| `flow` pause replaced a live gate instead of being idempotent | A sender waiting on an orphaned promise, stalled with nothing to wake it |
| The OPFS worker's open request had no timeout | A hang instead of the fallback to async writes, on any platform where the worker stays silent |
| Remote cancel left the channel's active entry in place | In-flight chunks written to a writer that had already been torn down |
| The room device count came from the join response | "Waiting for someone to join" while somebody was standing there |
| Resume could be triggered twice concurrently | The same file sent twice from two different offsets |

#### The four the end-to-end test found

Recorded because the *shape* of each one is more instructive than the fix.

**1. A validator silently dropped `file-start`.** The chunk-size field was checked with a predicate written for counts, capped at 10,000. The negotiated chunk size is 248,832 bytes, so every `file-start` failed validation and was discarded. The receiver never opened a writer; chunks arrived and were dropped as strays; the sender reported a completed transfer at full speed while the receiver sat at 0 bytes indefinitely.

The bug is unremarkable. What matters is that **the failure was completely silent** — the one thing the design says most clearly must not happen (§ "failures that explain themselves"), happening inside the code meant to prevent it. Rejecting a peer's malformed message and dropping our own valid one look identical when neither is reported. Now an unparseable control message is logged where the diagnostics panel shows it, which would have turned an hour into a minute.

**2. Rendering was tied to `requestAnimationFrame`, so a background tab stopped updating.** A hidden tab gets no frames at all — not delayed, suspended. The device list, transfer progress and diagnostics simply froze while the underlying state stayed perfectly correct. On a phone that locks its screen mid-transfer, that is the normal case. Renderers are now coalesced on a timer, which is throttled in the background but still runs.

**3. The per-IP socket limit contradicted automatic discovery.** Set to 12, tuned as though one address meant one device. But every device behind one router shares a public address — that is the entire premise of §4.1 — so a classroom of thirty is thirty sockets from one IP, and eighteen of them would have been refused with an error that reads like the server being down. The limit now sits above the room caps, and a test asserts that ordering so it cannot silently regress.

**4. `createSyncAccessHandle` is undetectable from the main thread.** Measured: the method is not on `FileSystemFileHandle.prototype` in a browser where it works perfectly inside a worker. The feature test reported "no" and every receive quietly took the slower async path — a performance regression with no symptom. The app now *asks a worker* once, and until the answer arrives it attempts the fast path and falls back. §6's claim that this is worker-only is stronger than it first appears: it is not merely unavailable on the main thread, it is invisible from there.

The common thread in 1, 2 and 4: each was a silent degradation, not a crash. A test that only checks for errors would have passed all three.

### 14.4 Throughput: the measurement §14 asked for

§14 (M1) recorded 2.0 MB/s and listed four candidate causes, with the instruction not to optimise before running the experiment that separates them. That experiment — a discard mode on the receiver that counts bytes without writing them — is now built, and the end-to-end test runs it automatically as an A/B on the same payload.

Loopback, two tabs in one headless browser, 6 MB, same run:

| Receiver | Throughput |
|---|---|
| Writing to OPFS via the synchronous worker | ~1.1 MB/s |
| Discarding (storage removed from the path) | ~3.9 MB/s |

**Storage accounts for roughly two thirds of receive time.** That supports cause 1 from §14 — serialised receive-side writes — and it is the first evidence for it rather than a suspicion.

Two honest caveats, both important:

- **This is not a measurement of anything real.** Two tabs in one browser on one machine share a CPU with both checksum workers and both ends of the transfer. The absolute numbers say nothing about real hardware and should not be quoted as if they did.
- **But the comparison is valid**, because exactly one thing changed between the two rows. That is the whole reason the discard tier exists.

Also fixed structurally, on the reasoning that these were design defects rather than optimisations:

- The source file is read as a **stream** rather than one `slice().arrayBuffer()` per chunk. A 1.2 GB file needed roughly 4,800 async round trips through the file system; now the browser reads ahead at its own pace and the send loop hands out fixed-size messages. This was cause 3.
- Writes **overlap** instead of being awaited one at a time, with a byte cap so a slow disk cannot become unbounded memory. Awaiting each write in turn makes storage latency and network throughput multiply rather than overlap.
- Checksums moved off both hot threads entirely, which removes cause 4 from the picture instead of trading it against verification.

**Still to run, and it is the measurement that matters:** the same A/B on real hardware over real Wi-Fi, preceded by a plain LAN speed test between the same two devices to bound what is achievable. Cause 2 — that the link itself was simply slow — has still not been ruled out, and the loopback figures cannot rule it out. The next lever after that, if storage is confirmed as the limit, is moving the File System Access writes into a worker as well; it is deliberately not done yet, because §14 is right that tuning the wrong layer is how a performance bug becomes permanent.

### 14.5 Still untested

- **Any Apple device.** iPhone ↔ Windows is a headline use case and remains entirely unverified. The OPFS worker path exists specifically for it and has only ever run on Chromium.
- **Firefox**, on either end.
- **A hostile network** — client isolation (§8.1) has not been provoked on purpose, so the code that explains it has never had to.
- **Resume across a page reload.** Resume works while the tab stays open; a closed tab discards the partial file.
- **The service-worker download tier**, which only engages where there is neither a save dialog nor OPFS.
- **Real-hardware throughput** (§14.4).

---

## What RoomBeam is betting on

Four things, in priority order. They are the reason the roadmap is shaped the way it is:

1. **Discovery that always works.** A code the user can read aloud, or a QR on a projector — never a mechanism that silently fails and leaves them guessing.
2. **Transfers that survive.** Backpressure so large files don't die partway, and resume so that when a connection drops the work isn't lost.
3. **Failures that explain themselves.** The ICE data needed to say *why* a connection failed is already available; not surfacing it is a choice, and the wrong one.
4. **A verifiable privacy claim.** The app inspects its own candidate pair and reports whether the bytes stayed local. Checkable, not asserted.

None of these are new features. They are reliability, and reliability is the whole product.

---

## Provenance

Every line of this project is original work, written from scratch for it. RoomBeam incorporates no third-party source, and its only runtime dependencies are `ws` and `selfsigned` — both server-side, both MIT, both declared in `package.json` and neither redistributed from this repository. **The browser loads no dependency at all**, which is also what makes the content-security policy in §7 enforceable: the page cannot reach a third party even if a future edit tried to.

That the codebase is entirely original matters more now that it is proprietary (§13.1) than it would in an open project: there is no inherited licence to comply with, nothing to attribute, and no question about what may be kept closed.

Written from scratch rather than taken from a library, in each case for a stated reason:

- the **QR encoder** (§9), so that no bundler or vendored source is needed, and because it can be verified by reading its own output back;
- the **service worker**, which has a second job — the streaming-download receive tier — that a generated config does not express;
- the **PNG icon generator**, so an installable app does not require a toolchain to produce its own icons;
- the **test harnesses**, including a DevTools Protocol client small enough to be read in one sitting.
