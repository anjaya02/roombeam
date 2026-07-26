# RoomBeam — M1 proof of concept

**Files, straight across.**

Browser-to-browser file transfer over the local network. See [DESIGN.md](DESIGN.md) for the full plan; this is milestone M1, which exists to **measure** rather than to ship.

## Run it

```powershell
npm install
npm start
```

The first run generates a self-signed certificate into `certs/`. The console prints two URLs:

```
This computer:   https://localhost:8443
Other devices:   https://192.168.8.150:8443
```

Open the first on this PC, the second on your phone. **Both devices must be on the same Wi-Fi.**

### The certificate warning is expected

Every device will refuse the page once, because the certificate is self-signed:

| Device | What to tap |
|---|---|
| iOS Safari | **Show Details** → **visit this website** → **Visit Website** |
| Android Chrome | **Advanced** → **Proceed to … (unsafe)** |
| Desktop Chrome/Edge | **Advanced** → **Proceed** |

This is unavoidable at this stage and it is *why* HTTPS is here at all: **WebRTC refuses to run outside a secure context, and a LAN IP is not a secure context.** Plain HTTP would fail with a confusing error instead of an honest warning. M2 replaces this with a proper hosted origin.

### If the phone can't reach the page

Windows Firewall blocks the inbound connection by default. In an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "RoomBeam M1" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```

Still nothing? The server prints every network interface it found — if your Wi-Fi adapter isn't the first one listed, try the others. VPNs and virtual adapters (VirtualBox, WSL, Hyper-V) are the usual culprits.

## Using it

1. Both devices show up in each other's **Devices on this network** list.
2. Tap a device → pick a file.
3. The receiving device shows an **Accept / Decline** prompt.
4. On accept, the transfer runs. Both sides show live progress and throughput.

## What to record

M1's job is to answer five questions on *your* hardware. Every answer is on screen — no dev tools needed.

| # | Question | Where to look |
|---|---|---|
| 1 | Does the connection establish at all? | Devices appear, transfer starts |
| 2 | **Did the bytes stay local?** | Note under a completed transfer: `local network` (good), `internet route`, or `relayed through a server` (bad) |
| 3 | What throughput do you get? | MB/s, live and on completion |
| 4 | Did the file arrive intact? | `checksum verified` on the receiving side |
| 5 | **Which storage tier does each device use?** | `via disk (File System Access)` / `via OPFS stream` / `via memory` |

Question 5 is the important one. It decides the maximum practical file size per platform: the memory tier holds the whole file in RAM, which is what makes large receives fail on iOS. The **Diagnostics** panel at the bottom of the page reports each device's capabilities independently.

### Worth testing deliberately

- **A large file** (500 MB+) from **phone → PC**. Most likely to expose a backpressure problem — the failure mode is a transfer that dies partway with no error.
- **Both directions** with the same file. A direction-dependent slowdown is easy to miss and only shows up if you test both.
- **iPhone as receiver**, if you have one. That's the platform with the least headroom.
- **A hostile network** — school or café Wi-Fi. Expect failure, and check the app *explains* it instead of hanging.

## What M1 deliberately does not do

Known and intentional; not bugs to report:

- **One global room.** Everyone connected sees everyone else. Room codes and QR are M2.
- **No resume.** A dropped connection loses the transfer. M3.
- **Memory tier on Safari.** M1 tries `createWritable()` on OPFS and falls back to RAM if absent. If Safari lands on the memory tier, that is the finding — M3 adds the Worker + `createSyncAccessHandle` path that fixes it. Measure first, then build.
- **No glare handling.** Both devices sending to each other at the exact same moment will misbehave.
- **Sender progress is optimistic.** It shows bytes queued, not bytes confirmed received. The receiver's number is the true one.
- Renaming your device reloads the page.

## Layout

```
server.js            HTTPS static server + WebSocket signalling relay (~200 lines)
public/index.html    the entire client — UI, WebRTC, chunking, storage tiers
certs/               generated on first run; do not commit
DESIGN.md            architecture, researched complaints, roadmap
```

The signalling server never sees file data. Its only job is to let two browsers exchange the connection details they need, because **a browser cannot discover devices on a local network** — no mDNS, no UDP broadcast, no raw sockets. That constraint is the reason this component exists at all.
