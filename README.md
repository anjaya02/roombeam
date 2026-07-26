# RoomBeam

**Files, straight across.**

Open a URL on two devices. They see each other. Pick a file, it transfers. The file
data travels device-to-device over your local network and never touches a server —
and the app inspects its own connection and tells you whether it actually did.

No install. No account. No cloud storage. Works between a Mac and a Windows PC, or
an iPhone and a Windows PC, which have no built-in way to do this at all.

- **[GUIDE.md](GUIDE.md)** — how to use it, and what to do when it does not work.
- **[DESIGN.md](DESIGN.md)** — the architecture, the reasoning, and what has actually been measured.

## Run it

```powershell
npm install
npm start
```

The console prints two URLs:

```
This computer:   https://localhost:8443
Other devices:   https://192.168.8.150:8443
```

Open the first on this machine and the second on your phone, or create a room code
and scan the QR. **Both devices need to be on the same Wi-Fi** for the transfer to
stay local.

### The certificate warning is expected

Every device objects once, because the certificate is generated on first run and
signed by nobody:

| Device | What to tap |
|---|---|
| iOS / macOS Safari | **Show Details** → **visit this website** |
| Android Chrome | **Advanced** → **Proceed to … (unsafe)** |
| Desktop Chrome / Edge | **Advanced** → **Proceed** |

This is *why* HTTPS is here: **WebRTC refuses to run outside a secure context, and a
LAN IP is not one.** Plain HTTP would fail with "RTCPeerConnection is not defined"
and no hint as to why. An honest warning beats a silent missing feature.

### If the phone cannot reach the page

Windows Firewall blocks the inbound connection by default. In an **Administrator**
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "RoomBeam" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```

Still nothing? The server prints every interface it found, ranked. If your Wi-Fi
adapter is not the one listed first, try the others — VPNs and virtual adapters
(VirtualBox, WSL, Hyper-V) are the usual culprits.

## Using it

**Two ways to find each other, because each one fails where the other works.**

- **Automatically.** Devices sharing a public IP address are grouped without being
  asked. Nothing to type. Breaks on cellular, on a VPN, behind carrier-grade NAT,
  and on networks with several egress addresses.
- **With a room code.** A five-character code and a QR. Works across networks, on
  guest Wi-Fi, and behind any NAT — and it is the better experience anyway when a
  teacher can put the QR on a projector.

Then: tap a device (or drag files onto it), and the other device gets an
**Accept / Decline** prompt. Nothing is ever accepted automatically — on shared
Wi-Fi that prompt is the only thing between you and files from a stranger.

## What it tells you

Everything below is on screen. No developer tools needed.

| | Where |
|---|---|
| **Did the bytes stay local?** | Under each transfer, and on each device row: `local network`, `internet route`, or `relayed through a server` |
| Throughput | Live, and on completion. The receiver's number is the true one |
| Did the file arrive intact? | `checksum verified` |
| Where a received file went | `via disk (File System Access)`, `via OPFS…`, `via memory` — this sets the maximum file size the device can handle |
| Is this the device I sent to last time? | A `verified` badge, which means the peer signed a challenge with the key you saw before **and** that key is bound to this connection's encryption |
| Why a connection failed | Four separate diagnoses, because "no local routes", "the other side never replied", "a stalled handshake" and "this network blocks device-to-device traffic" have nothing in common as fixes |

The **Diagnostics** panel adds each device's capabilities, per-connection ICE
detail, and a **throughput ceiling** measurement that moves data between two
connections inside the page — no network involved — so a slow transfer can be
blamed on the right thing.

## Settings worth knowing

- **Local network only** — refuse to send unless the selected route is local.
  Turns the privacy claim from something reported into something enforced.
- **Use a STUN server** — only needed when the two devices are *not* on the same
  network. Off is the strictest posture: local addresses only, nothing asked of
  anyone else.
- **Verify every file** — on by default. Both ends checksum on separate threads,
  so it costs no throughput.
- **Discard received files** — a measurement tool. Count the bytes and throw them
  away; if the rate jumps, storage was the bottleneck rather than the network.

## Tests

```powershell
npm run check        # everything
npm run check:unit   # no browser needed
npm run check:e2e    # drives a headless Chromium
```

Three layers:

- **45 unit checks.** The QR encoder is the interesting one — it is verified by an
  independently written decoder that reads the format information back, unmasks,
  de-interleaves the blocks, confirms every Reed–Solomon syndrome is zero and
  recovers the payload, at every version and error level. A QR encoder otherwise
  either works or produces a picture that quietly will not scan.
- **19 signalling integration checks** over a real WebSocket: automatic grouping,
  room codes, rate limits, and that the relay will not carry a message to a peer
  outside the sender's room.
- **24 end-to-end checks** driving a headless browser: two tabs discover each
  other, a file is dropped onto a device row, accepted on the other side, and both
  ends confirm it arrived intact over a verified local route. It goes through the
  interface a person uses — a drop event and a tap on Accept — so nothing can pass
  because of a test hook.

`npm run check:e2e` skips itself if no Chromium-based browser is installed.

## Layout

```
server.js              entry point: TLS or plain HTTP behind a proxy
src/
  http.js              static files, /health, security headers
  signaling.js         WebSocket relay, rate limits, room membership
  rooms.js             room registry: codes and salted IP grouping
  cert.js              self-signed certificate, regenerated when the LAN moves
  interfaces.js        which address to tell the user about
public/
  index.html           the app shell
  app.css
  sw.js                offline shell, and the streaming-download receive tier
  shared/              modules the server and browser must agree on exactly
  js/
    main.js            wiring
    signaling.js       client half of the relay
    peer.js            perfect negotiation, device proof, route inspection
    protocol.js        the DataChannel wire protocol and its validators
    transfer.js        chunking, backpressure, flow control, resume, cancel
    writers.js         the receive-side storage tiers
    opfs-worker.js     synchronous writes, the large-file path on iOS
    crc-worker.js      checksums off the send loop's thread
    qr.js              QR encoder, written from scratch
    diagnostics.js     capabilities, ICE detail, throughput ceiling
tools/
  check*.mjs           the three test layers
  make-icons.mjs       PNG icons, generated
```

## Self-hosting

The signalling server holds no database and writes nothing to disk. Room state is
in memory and gone on restart — which is safe, because once a DataChannel is open
the server is no longer in the path.

```
PORT=8443              listening port
HOST=0.0.0.0           bind address
ROOMBEAM_TLS=off       skip the generated certificate; something else terminates TLS
TRUST_PROXY=1          read X-Forwarded-For for the automatic grouping
```

`GET /health` returns live room and peer counts. Point a deploy check at it: a
reverse proxy that forwards HTTP but not the WebSocket upgrade breaks discovery
while the page itself loads perfectly, which is otherwise a baffling way to be
broken.

## What is not built yet

Honest gaps, not bugs to report:

- **One-to-many broadcast** (M5) and **folder transfer** (M6).
- **Resume across a page reload.** Resume works while the tab stays open — a
  dropped connection reconnects and picks up from the receiver's byte count. Close
  the tab and the partial file is discarded.
- **In-app QR scanning on Safari**, which has no `BarcodeDetector`. The system
  camera scans the QR and opens the link, so the code is typed or the camera app
  is used.

## Untested

Stated plainly because "untested" and "working" are easy to confuse:

- **Any Apple device.** iPhone ↔ Windows is a headline use case and remains
  entirely unverified. The OPFS worker path exists specifically for it.
- **Firefox**, on either end.
- **A hostile network.** Client isolation has not been provoked on purpose; the
  code that explains it has never had to.
- **The service-worker download tier**, which only engages on a browser with no
  save dialog and no OPFS.
- **Real-hardware throughput.** The only measurements so far are two tabs in one
  headless browser on one machine — see DESIGN.md §14.

## Licence

**Proprietary — all rights reserved.** Not open source. See [LICENSE](LICENSE).

The two runtime dependencies (`ws`, `selfsigned`) are MIT and permit private and
commercial use freely. Their notices only need to travel with the software if it
is ever distributed as a bundle, installer or image.
