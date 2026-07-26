# RoomBeam — Design Document

**Files, straight across.**

**Status:** Draft v1
**Package / repo name:** `roombeam`
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
| **Signaling server** | ~300 lines, WebSocket, in-memory rooms | Small VPS / Cloudflare / self-hosted |
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
→ join          { room?, name, pubkey }
← peers         [{ id, name, pubkey }]
← peer-joined   { id, name, pubkey }
← peer-left     { id }
↔ signal        { to, from, data: <SDP offer|answer|ICE candidate> }
→ ping / ← pong (keepalive; many hosts drop idle WS at 60s)
```

File metadata is **not** sent through signaling — it goes over the DataChannel, so the server never learns filenames.

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

- **Chunk size:** `min(pc.sctp.maxMessageSize, 262144)`, defaulting to **16 KiB** for maximum interop. Chrome reports 256 KiB; older stacks are lower. Negotiate, don't assume.
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
→ offer-files   { transferId, files: [{ id, name, size, mime, mtime }] }
← accept        { transferId, fileIds: [...] }        // or decline
→ file-start    { fileId, chunkSize, chunkCount }
→ <binary chunk> × chunkCount                          // sequential, in order
→ file-end      { fileId, crc32? }
↔ cancel        { transferId, fileId?, reason }
← resume-from   { fileId, chunkIndex }                 // reconnect path
```

Notes:
- **Receiver never auto-accepts.** Every incoming transfer requires an explicit tap. This is the primary defence against unwanted files from strangers on shared Wi-Fi.
- Progress needs no messages — the receiver counts chunks, the sender watches `bufferedAmount` drain.
- Integrity checking is *optional*. SCTP is reliable and checksummed; hashing 1 GB in JS costs real seconds. Offer CRC32 (fast, incremental, in a Worker) as a verification toggle rather than a default.
- `resume-from` makes the protocol resumable even if v1 doesn't implement it. Designing it in now costs nothing; retrofitting it costs a rewrite.

---

## 6. The hard part: writing files on the receiving end

Sending is easy and uniform. **Receiving is where platform differences bite**, and it determines the maximum file size the app supports on each device.

Capability cascade — detect at runtime, use the best available:

| Tier | API | Where | Size limit |
|---|---|---|---|
| 1 | `showSaveFilePicker()` + `FileSystemWritableFileStream` | Chromium desktop **and Android Chrome** (measured — see §15) | Free disk space |
| 2 | **OPFS** + `createSyncAccessHandle()` in a Worker, then hand off a `Blob` | Chrome, Edge, Firefox, **Safari 15.2+**, Android Chrome | Storage quota |
| 3 | Service-worker-intercepted streaming download | Chromium, Firefox | Unbounded, fiddly |
| 4 | In-memory `Blob` + `<a download>` | Everything | **RAM — small files only** |

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

| | Win Chrome | Win Firefox | macOS Safari | iOS Safari | Android Chrome |
|---|---|---|---|---|---|
| **Win Chrome** | | | | | |
| **macOS Safari** | ★ | | | | |
| **iOS Safari** | ★ | | | | |
| **Android Chrome** | | | | | |

★ = the pairs that justify the project's existence. Get these right first.

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
| Malicious *signaling server* substituting DTLS fingerprints | Real residual risk. Mitigate with an optional out-of-band short authentication string both users compare — worth designing, not necessarily shipping in v1 |

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
| Build | **Vite + TypeScript** | Fast, minimal config, first-class PWA plugin |
| UI | **Svelte** | Small bundle matters on a phone opening a cold URL; less ceremony than React. *Tradeoff: React has a wider contributor pool for an open-source project — reconsider if community contribution is a priority.* |
| PWA | `vite-plugin-pwa` (Workbox) | Offline app shell, installable |
| Signaling | **Node + `ws`** | ~300 lines, trivially self-hostable. *Cloudflare Durable Objects is a strong alternative for room state, at the cost of self-hosting simplicity.* |
| QR | `qrcode` to generate; native `BarcodeDetector` with `jsQR` fallback (Safari lacks it) | |
| Tests | Vitest (unit) + Playwright (two browser contexts, real DataChannel) | Playwright can drive both peers in one test |
| Hosting | Static host + one small always-on process for signaling | |

Licence: **AGPL-3.0** or **MIT** — decide early. AGPL keeps hosted forks open; MIT maximizes adoption. This affects contributors, so settle it before the first PR.

---

## 10. Roadmap

| Milestone | Deliverable | Why this order |
|---|---|---|
| **M0** | This document | |
| **M1** | Proof of concept: two browsers, hardcoded room, one file over the LAN | Validates WebRTC on *your* actual hardware and network before any investment in structure |
| **M2** | Signaling server; **QR + room code as the primary path**; auto-IP grouping as a bonus that may fail | Reordered per §14.1 — unreliable discovery is the loudest complaint against existing tools |
| **M3** | Robust transfer: negotiated chunk size, backpressure, OPFS receive, **resume**, progress, cancel, multi-file | The engineering core. Resume promoted from M6 per §14.2 |
| **M4** | PWA, device names, accept prompts, local-path badge, **diagnostics panel** | Diagnostics added per §14.5 — cheapest differentiator available |
| **M5** | One-to-many broadcast (classroom mode) | The feature differentiator — see below |
| **M6** | Folder transfer, self-hosting Compose file + `/health` self-check | Per §14.6 |

### M5 — classroom broadcast, in more detail

Existing tools are built around 1:1. One person sending one file to thirty is a distinct and underserved problem, and it's the use case you described.

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

---

## 13. Open questions

1. **Licence** — AGPL vs MIT. Blocks the first external contribution.
2. **Maximum supported file size**, per platform tier — needs measurement on real devices during M1/M3, then a documented limit rather than a mystery failure.
3. **Integrity checking** — default on or off? Depends on measured CRC32 throughput on a mid-range phone.
4. **Name and domain.**
5. **Does M5's bounded-parallelism queue actually hold up** with 30 devices on one access point? Unknown until tested with real hardware; may force the swarm design earlier than planned.
6. **Signaling server abuse at scale** — if this gets popular, what does hosting cost and how is it funded without ads or accounts?

---

## 14. Validated pain points (researched, not assumed)

Complaints against PairDrop and Snapdrop, gathered from their issue trackers and user forums. These are the *actual* gaps — they reorder the roadmap and they're the honest justification for building anything at all.

### 14.1 Discovery is unreliable — the loudest complaint by far

Reported repeatedly and across years: [#99](https://github.com/schlagmichdoch/PairDrop/issues/99), [#310](https://github.com/schlagmichdoch/PairDrop/issues/310), [#352](https://github.com/schlagmichdoch/PairDrop/issues/352), [#21](https://github.com/schlagmichdoch/PairDrop/issues/21), [#356](https://github.com/schlagmichdoch/PairDrop/discussions/356), and [LinuxServer's forum](https://discourse.linuxserver.io/t/issue-with-not-being-able-to-detect-devices-pairdrop-image/8964). Symptoms:

- Devices on the same Wi-Fi simply don't appear
- Sometimes appear after 1–2 minutes, usually never
- Paired devices show as `undefined`; "devices are not persistent" errors
- Works on pairdrop.net but not on a self-hosted instance
- Android on mobile data can't pair with a computer

Root cause is architectural: **automatic discovery depends on public-IP grouping**, which breaks under IPv6, carrier-grade NAT, VPNs, multiple egress IPs, and — very commonly — reverse proxies that don't forward the real client IP.

> **Design consequence — this is the big one.** Auto-IP grouping cannot be the primary discovery mechanism. **QR code and room code become the default path**, with auto-discovery as a bonus that's allowed to fail silently. This inverts the priority in §4 and is the single most important lesson from the research.

### 14.2 Large transfers die mid-flight, with no error

[#120](https://github.com/schlagmichdoch/PairDrop/issues/120): a 500 MB video reaches roughly one third, then "just ends prematurely" with no message. Open and unresolved.

> **Design consequence:** validates backpressure (§5.2) and `resume-from` (§5.3) as v1 requirements rather than nice-to-haves. A transfer that dies at 33% and can resume is an inconvenience; one that silently restarts is why people give up on a tool.

### 14.3 Slow, and asymmetrically so

[#359](https://github.com/schlagmichdoch/PairDrop/issues/359): Android → Windows becomes "unusable" above ~100 MB, while Windows → Android is fine. Same asymmetry on both pairdrop.net and self-hosted.

In [an independent 2 GB benchmark](https://www.makeuseof.com/file-transfer-speed-test-localsend-blip-pairdrop/), PairDrop came last: **1:38 vs LocalSend's 1:20** — not a catastrophe, but consistently slowest, and LocalSend is native.

> **Design consequence:** a direction-dependent slowdown points at sender-side chunk sizing and buffer tuning, not the network. Negotiate chunk size against `pc.sctp.maxMessageSize` rather than hardcoding it, and treat the high/low watermarks in §5.2 as values to *measure per platform*, not guess once. Benchmark both directions separately — the asymmetry only shows up if you test both.

### 14.4 iOS receive failures

Long-standing on Snapdrop ([#61](https://github.com/RobinLinus/snapdrop/issues/61), [#83](https://github.com/RobinLinus/snapdrop/issues/83), [#247](https://github.com/RobinLinus/snapdrop/issues/247)): discovery succeeds, then receiving fails with **blob resource errors**.

> **Design consequence:** this is precisely the in-memory-`Blob` ceiling described in §6. It's the strongest evidence that the OPFS tier is the correct first build target. The bug is a direct consequence of an architecture that assembles files in RAM.

### 14.5 Failures are silent and unexplainable

A theme running through every thread above: when it doesn't work, **users have no idea why**, so the advice degrades into folklore — clear your cache, disable your VPN, turn off your ad blocker, try another browser.

> **Design consequence — cheapest differentiator available.** The candidate-pair inspection in §7.3 already yields the data to say what actually went wrong. Build a real diagnostics panel:
> - "Your network blocks device-to-device traffic (client isolation) — try a mobile hotspot"
> - "These devices are on different networks — scan the QR code instead"
> - "The receiver has 400 MB free but this file is 1.2 GB"
> - A self-host checklist that verifies proxy headers and `wss://` and reports what's misconfigured
>
> Almost no engineering cost. Addresses the complaint underlying all the others.

### 14.6 Self-hosting is fragile

[#310](https://github.com/schlagmichdoch/PairDrop/issues/310) is a misconfigured Apache proxy — `http`/`ws` instead of `https`/`wss`, real client IP not forwarded — which silently breaks discovery while everything else appears to work.

> **Design consequence:** ship one Docker Compose file that works unmodified, plus a `/health` page that self-diagnoses proxy headers, WSS upgrade, and detected client IP.

### 14.7 Summary — what actually differentiates this project

| Their complaint | Our answer |
|---|---|
| Devices don't show up | QR/code-first discovery; auto-IP is a bonus, not the mechanism |
| Big files die at 33% | Backpressure + resumable transfers from v1 |
| Too slow, worse in one direction | Negotiated chunk size, measured watermarks, both directions benchmarked |
| iOS can't receive large files | OPFS streaming to disk, built first, not retrofitted |
| No idea why it failed | Diagnostics panel naming the actual cause |
| Self-hosting silently breaks | One working Compose file + self-check endpoint |

Note that **none of these are new features.** They are all reliability and honesty. That is genuinely where the room is.

---

## 15. M1 measured results

First real run: **Windows 11 / Edge** ↔ **Android Chrome**, same Wi-Fi, 2026-07-26.

### What worked

| Check | Result |
|---|---|
| Peer discovery over signalling | Both devices appeared to each other |
| WebRTC connection, PC → Android | Established |
| **Data path** | **`local network`** — confirmed via ICE candidate-pair inspection (§7.3). The bytes stayed on the LAN. |
| Receive-side storage tier | `disk (File System Access)` on **both** devices |
| Accept/decline prompt | Worked; gated the transfer as designed |

The central premise is proven: **a browser-to-browser transfer whose data path never leaves the local network works, and the app can prove it did.**

### Finding 1 — Tier 1 is available on Android Chrome

§6 originally claimed `showSaveFilePicker()` was Chromium-desktop-only. Measured: Android Chrome reported it **available**, and the phone received via `disk (File System Access)`, not OPFS. The table above is corrected.

This is good news, and it narrows the problem: the storage-tier risk is now **specifically an iOS Safari problem**, not a mobile problem. Untested — no iPhone in this run.

### Finding 2 — throughput is bad: ~2 MB/s

A 1.2 GB file moved PC → Android at **2.0 MB/s** (receiver measured 1.9 MB/s). Expected range was 10–50 MB/s. At this rate that file needs ~10 minutes, which is worse than the tools in §14.3 and not shippable.

Unresolved. Candidate causes, roughly in order of suspicion:

1. **Serialized disk writes on the receiver.** Every chunk is `await w.write(chunk)` before the next message is processed, so storage latency, not the network, may set the pace. Android flash writes through the File System Access layer could plausibly cap here.
2. **Actual Wi-Fi link quality.** 2 MB/s ≈ 16 Mbps, entirely plausible for a weak 2.4 GHz link. Needs ruling out before touching any code.
3. Per-chunk `file.slice().arrayBuffer()` overhead — ~4,800 async reads for this file.
4. Main-thread CRC32 competing with the send loop.

**The experiment that separates these:** a discard mode on the receiver that counts bytes without writing them. If throughput jumps, it is cause 1. If it does not, it is cause 2 and no amount of code will fix it. Run a plain LAN speed test between the same two devices first — that bounds what is achievable and costs nothing.

Do not optimise before this measurement. Guessing here is how §14.3 happens.

### Finding 3 — connection failed in one direction

Android → PC failed to connect while PC → Android succeeded moments later, same devices, same network. Not diagnosed; the failure message was too vague to distinguish "the other side never replied" from "every route was tried and failed" — fixed since (§15.1).

Whether this is a genuine directional asymmetry or ordinary first-attempt flakiness is unknown. Needs repeat runs in both directions.

### 15.1 Fixes made after the run

Three defects the run exposed:

- **`peer-left` tore down live connections.** The handler closed the `RTCPeerConnection` whenever the signalling socket reported a peer gone. Mobile browsers drop WebSockets routinely, so this aborted healthy transfers and directly contradicted the §3 claim that signalling loss cannot interrupt a transfer. Now a connection is only discarded when it is genuinely idle.
- **Status text never advanced past "Waiting to accept."** A transfer showed 58 MB / 1.2 GB moving at 2.0 MB/s while still claiming it was waiting for permission.
- **Failure diagnosis conflated three distinct causes.** "No candidates at all" was reported when the real situation was "no pair was formed." Now separated into no-local-candidates (VPN), no-remote-candidates (other side never replied), no-pair (stalled handshake), and all-pairs-failed (client isolation).

### 15.2 Still untested

- **Any Apple device.** iPhone ↔ Windows is a headline use case and remains entirely unverified.
- **Firefox**, on either end.
- **A hostile network** — client isolation (§8.1) has not been provoked on purpose.
- **Resume**, which does not exist yet.

---

## Prior art

Read these before writing code. Not to be discouraged — to avoid re-deriving solved problems.

- **[PairDrop](https://github.com/schlagmichdoch/PairDrop)** — the closest existing thing to this design: web app, WebRTC, public-IP room grouping, room codes. Actively maintained. Study its ICE handling and its receive-side code.
- **[Snapdrop](https://github.com/RobinLinus/snapdrop)** — the original; PairDrop's ancestor.
- **[LocalSend](https://github.com/localsend/localsend)** — native, Flutter, genuinely offline with real mDNS discovery. What you'd build if you weren't constrained to a browser. Good reference for the protocol design and for what the sandbox costs you.

**Where the room actually is:** one-to-many broadcast, large files on iOS, honest local-path verification, and the offline host mode. Those are the gaps in the existing tools — not basic 1:1 transfer, which is well covered.

### What RoomBeam owes to PairDrop and Snapdrop

Stated plainly, because the repo is public and this needs to be unambiguous.

**Code taken: none.** Not a line. Their source was not read or copied, and RoomBeam carries no code derived from either project. Everything in `server.js` and `public/index.html` was written from scratch. This matters legally — Snapdrop and PairDrop are GPL-family licensed, and copied code would bind this project to those terms. It does not, because there is none.

**Concepts adopted** — theirs first, and RoomBeam uses them knowingly:

| Idea | Origin |
|---|---|
| A *web app* (not a native app) doing local WebRTC file transfer | Snapdrop originated the whole category |
| Grouping peers automatically by public IP so same-network devices auto-appear (§4.1) | Snapdrop / PairDrop's discovery mechanism |
| Room codes for pairing across networks (§4.2) | PairDrop's addition over Snapdrop |
| Generated human-readable device names instead of accounts (§4.3) | Snapdrop's convention |

**What came from their bug reports** — this is the larger debt, and it is entirely about priorities rather than implementation. Every item in §14 is a decision made *because* users reported it broken elsewhere:

| Their reported failure | What it changed here |
|---|---|
| Devices don't appear (§14.1) | QR/room code promoted to the primary path; auto-IP demoted to a bonus |
| Large files die partway, silently (§14.2) | Backpressure and resume moved into v1 scope |
| Slow, and asymmetrically so (§14.3) | Chunk size negotiated from `sctp.maxMessageSize`; both directions benchmarked separately |
| iOS "blob resource" errors (§14.4) | Tiered storage cascade, built before the desktop-only convenience path |
| Nobody can tell why it failed (§14.5) | Diagnostics panel and ICE candidate-pair path reporting |
| Self-hosting breaks silently (§14.6) | One working Compose file plus a `/health` self-check |

Their issue trackers were, in effect, years of free user research. The honest summary is that **PairDrop and Snapdrop defined the category and RoomBeam is trying to be the reliable version** — which is only possible because their users documented precisely where it breaks.
