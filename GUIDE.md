# How to use RoomBeam

A walkthrough for the two situations it is built for, plus what to do when it does
not work. If you only read one thing: **both devices must be on the same Wi-Fi for
the file data to stay local**, and the app will tell you whether it did.

- [Start the server](#start-the-server)
- [Get past the certificate warning](#get-past-the-certificate-warning)
- [Send a file: same network](#send-a-file-same-network)
- [Send a file: a room code](#send-a-file-a-room-code)
- [Where the file ends up](#where-the-file-ends-up)
- [Checking it really stayed local](#checking-it-really-stayed-local)
- [Settings](#settings)
- [When it does not work](#when-it-does-not-work)
- [Measuring throughput](#measuring-throughput)
- [Install it as an app](#install-it-as-an-app)
- [Hosting it for other people](#hosting-it-for-other-people)

---

## Start the server

One machine runs it. Everything else just opens a URL.

```powershell
npm install
npm start
```

You get two addresses:

```
This computer:   https://localhost:8443
Other devices:   https://192.168.8.150:8443
```

Use the first on the machine running the server, the second everywhere else. If
several addresses are listed, the first is the best guess — try the others if the
phone cannot load the page.

> The certificate is generated on first run into `certs/`, and regenerated if your
> machine moves to a different network. It is never committed.

## Get past the certificate warning

Every device objects once. This is expected, and it is the reason HTTPS is here at
all: **WebRTC will not run outside a secure context, and a LAN IP address is not
one.** Over plain HTTP the page would load and then quietly have no ability to
connect to anything.

| Device | What to tap |
|---|---|
| iPhone / iPad / Mac (Safari) | **Show Details** → **visit this website** → **Visit Website** |
| Android (Chrome) | **Advanced** → **Proceed to … (unsafe)** |
| Windows (Chrome / Edge) | **Advanced** → **Proceed to …** |
| Firefox | **Advanced** → **Accept the Risk and Continue** |

You only do this once per device.

## Send a file: same network

The zero-effort path. Nothing to type.

1. Open the page on both devices.
2. Each appears in the other's **Devices** list within a second or two, under a
   name like *Quiet Otter*. Rename yourself in the **you are** box if you like —
   it updates on the other device immediately.
3. **Tap the device you want to send to**, and pick your files. On a desktop you
   can also **drag files straight onto the device's row**, which skips the file
   dialog entirely.
4. The other device shows the filename, the size, and **Accept / Decline**.
   Nothing is ever accepted automatically.
5. Tap **Accept**. Both sides show live progress, the route, and the throughput.

When it finishes, the receiving device says something like:

```
local network · 2 ms · via disk (File System Access) · 243 KB chunks · checksum verified
```

That line is the whole point. In order: the bytes stayed on your network, the
round trip was 2 ms, the file was streamed to disk rather than held in memory,
and it was verified end to end.

### Sending several files

Select more than one in the file picker, or drag a group. They are offered as one
transfer, accepted with one tap, and sent one after another — deliberately, since
parallel streams on one Wi-Fi radio just make each other slower.

On Chromium you will be asked for a **folder** rather than a filename when there
is more than one file, and all of them land in it.

## Send a file: a room code

Use this when the devices are not grouped automatically — one is on cellular, one
is on a VPN, you are on guest Wi-Fi, or you simply want to be certain who you are
talking to.

**On the sending device:**

1. Tap **Create a room code**.
2. A five-character code and a QR code appear.

**On the other device, either:**

- **Scan the QR** with the phone's normal camera app. It opens the link directly —
  this is the fastest route on an iPhone, and no in-app scanning is needed.
- Tap **Scan QR** inside RoomBeam (Android Chrome).
- Tap **Join a code** and type the five characters.

The code is deliberately unambiguous: there is no `I`, `L`, `O` or `U` in it, so
nothing can be confused with `1` or `0`. Case does not matter, dashes do not
matter, and if you type `O` where the code has `0` it still works.

Then send exactly as above. **Back to nearby** returns you to automatic grouping.

> A room code is the right tool for a classroom or a meeting: put the QR on the
> projector and everyone joins the same room, regardless of how the network is
> arranged.

## No Wi-Fi worth trusting: use a hotspot

Apps like SHAREit make their own network — the sender becomes a Wi-Fi hotspot and
the receiver joins it. A web page cannot do that: there is no browser API to
create a hotspot or to join a network, and there is unlikely ever to be one. That
is the actual price of not having to install anything.

You can build the same arrangement by hand in about thirty seconds, and it is the
one setup that always works, because two devices on a hotspot are on the same
network by construction:

1. Turn on the hotspot on one phone.
2. Join it from the other device.
3. Open RoomBeam on both.

Transfers then run over the hotspot at local speed — the route line will say
**local network**, and you can check it rather than take our word for it.

### With no internet at all

The hotspot alone still needs a working internet connection, because the two
devices have to be introduced to each other before they can connect directly. If
the phone providing the hotspot has mobile data, that is taken care of.

If it does not — a plane, a basement, a field trip, a country with no roaming —
run the introduction service yourself. It is the same `npm start` from the top of
this guide, on a laptop joined to the hotspot:

1. Turn on the phone's hotspot. Mobile data can stay off.
2. Join it from the laptop.
3. `npm start` on the laptop.
4. Open the `Other devices:` address it prints, on every phone.

Nothing leaves the hotspot at any point — not the file, not the filenames, and
not the introduction either. You will have to
[get past the certificate warning](#get-past-the-certificate-warning) once per
device, which is the whole cost.

> Hotspots usually cap out lower than a good access point, and the phone
> providing one is doing two jobs at once. Expect it to be slower than a proper
> 5 GHz network — it is the arrangement for when there is no proper network, not
> a faster one.

## Where the file ends up

This depends on the browser, and it decides the **largest file the device can
receive**. The transfer line always names the one in use, and **Diagnostics →
Files will land in** tells you before you start.

| What you will see | Where the file goes | Practical limit |
|---|---|---|
| `disk (folder you chose)` | Straight into a folder you picked | Free disk space |
| `disk (File System Access)` | Straight to where you chose in the save dialog | Free disk space |
| `OPFS, synchronous worker writes` | Streamed to browser storage, then a **Save** link | Storage quota (usually plenty) |
| `OPFS, async writes` | Same, on a slower write path | Storage quota |
| `streamed to Downloads` | Straight into Downloads | Unlimited |
| `memory — small files only` | Held in RAM until you save it | A few hundred MB, then the tab dies |

If a tier shows a **Save** link when the transfer finishes, click it — that is the
step that puts the file where you want it. RoomBeam does not delete the temporary
copy until the next time you load the page, so a slow save cannot be cut short.

If the transfer will not fit, it is **refused up front with the numbers**, rather
than failing at 90%.

## Checking it really stayed local

Two independent things are worth checking, and both are on screen.

**The route.** Every transfer and every device row carries one of:

| Badge | Meaning |
|---|---|
| `local network` | The bytes went device → router → device. What you want. |
| `internet route` | A direct connection, but not a local one — the devices are not on the same network. |
| `relayed through a server` | Should never happen: RoomBeam configures no relay. |

To make this a rule rather than a report, turn on **Settings → Local network
only** and RoomBeam will refuse to send over anything else.

**Who you are talking to.** After the first transfer, a device shows `known`, and
`verified` once it has proved it holds the same key as last time — and that the key
belongs to *this* connection's encryption. If you ever see **`key mismatch`**, stop:
something is sitting between the two devices. On first contact there is no stored
key to check against, so **Diagnostics → Connections** shows a short *check code*
instead; if it reads the same on both screens, nothing is in the middle.

## Settings

Behind the gear icon.

| Setting | Default | What it does |
|---|---|---|
| **Verify every file** | On | Checksums both ends. Runs on separate threads, so it costs no speed. |
| **Local network only** | Off | Refuses to send over a non-local route instead of reporting it. |
| **Use a STUN server** | On | Only needed when the devices are *not* on the same network. Turning it off is the strictest setting: local addresses only, and nothing is asked of any third party. |
| **Skip the save dialog** | Off | Accept with one tap and save afterwards, rather than choosing a location first. |
| **Keep the screen awake** | On | A locked screen suspends the page on iOS. Transfers resume by themselves either way. |
| **Discard received files** | Off | Measurement only — see below. |
| **Chunk size override** | Automatic | Diagnostics only. Leave it alone unless you are testing. |

**Forget remembered devices** clears the `known` and `verified` history. Nothing
else is stored: there is no account, and the server has no database.

## When it does not work

Work down this list; it is ordered by how often each thing is the cause.

### The phone cannot load the page at all

Windows Firewall blocks the inbound connection by default. In an **Administrator**
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "RoomBeam" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```

If it still will not load, the address is probably the wrong one. The server prints
every network interface it found — try the others. VPNs and virtual adapters
(VirtualBox, WSL, Hyper-V) are the usual reason the first guess is wrong.

### The other device never appears

- Confirm both are on the **same Wi-Fi** — not one on 5 GHz and one on a guest
  network, which are often separate networks entirely.
- Some networks give every device its own public address, which defeats automatic
  grouping. **Use a room code**; it does not care how the network is arranged.
- On a VPN, your traffic leaves from somewhere else. Either disconnect it or use a
  room code.

### It says "this network is blocking device-to-device traffic"

This is *client isolation*, and it is standard on school, café, hotel and guest
Wi-Fi: the access point deliberately forbids devices from talking to each other.
Nothing in a browser can work around it.

Confirm it in a minute: turn on a phone hotspot, put both devices on it, and try
again. If it works there, the original network was the problem. See
[No Wi-Fi worth trusting](#no-wi-fi-worth-trusting-use-a-hotspot) for the full
arrangement.

### The connection fails with something else

**Diagnostics** distinguishes four causes, because they have nothing in common as
fixes:

| What it says | What to do |
|---|---|
| *This device produced no network routes at all* | A VPN or privacy extension is hiding the network. Disconnect it. |
| *The other device never sent any of its own* | Both pages must be open at the same time. Reload both. |
| *No pair was formed* | A stalled handshake. Reload both pages. |
| *Every route was tried and none connected* | Client isolation — see above. |
| *This device never offered a local-network address* | A VPN. Disconnect it to keep the transfer on the LAN. |

### The transfer stopped partway

It will say **Paused** and pick up by itself when the other device comes back — it
asks the receiver how much arrived and continues from there. Locking a phone or
walking out of range is expected and handled.

The one thing that does lose it: **closing the tab**. The partial file is discarded.

### The file arrived but says the checksum does not match

The file is corrupt; send it again. This should not happen — the transport is
already checksummed — so if it happens repeatedly, that is worth reporting.

### "Not enough room"

The receiving browser's storage quota is too small for the transfer. Free up disk
space, or send fewer files at once. The message includes both numbers.

## Measuring throughput

If a transfer feels slow, find out what is slow before changing anything.

**1. What is this device capable of?** *Diagnostics → Throughput ceiling →
Measure.* This moves data between two connections inside the page, with no
network involved, at three chunk sizes. It is the upper bound; a real transfer
cannot beat it.

**2. Is storage the bottleneck, or the network?** Turn on **Settings → Discard
received files** and receive the same file again. Bytes are counted and thrown
away.

- **Much faster** → writing to storage was the limit.
- **No different** → the network is the limit, and no setting will help. Run a
  plain speed test between the two devices to see what the link can actually do.

Remember to turn discard mode back off — while it is on, **received files are not
saved.** The transfer line says `discarded (measurement mode)` throughout.

## Install it as an app

RoomBeam is a PWA, so it can live on the home screen and open without browser
chrome. The app shell is cached, so it starts instantly.

| Device | How |
|---|---|
| iPhone / iPad | Share → **Add to Home Screen** |
| Android Chrome | menu → **Add to Home screen** / **Install app** |
| Desktop Chrome / Edge | The install icon in the address bar |

It still needs the server reachable to *discover* devices — installing does not
change that. See [DESIGN.md §2](DESIGN.md) for why that is unavoidable in a
browser.

## Hosting it for other people

The signalling server keeps room membership in memory and writes nothing to disk.
Restarting it does not interrupt transfers already running, because once a
connection is established the server is no longer in the path.

```
PORT=8443              listening port
HOST=0.0.0.0           bind address
ROOMBEAM_TLS=off       skip the generated certificate — something else terminates TLS
TRUST_PROXY=1          read X-Forwarded-For, so automatic grouping sees real addresses
```

Behind a reverse proxy you need **both** of the last two, and the proxy must
forward the **WebSocket upgrade**. If it forwards HTTP but not the upgrade, the
page loads perfectly and no device ever discovers another — which is a genuinely
baffling way to be broken, so point a health check at it:

```
GET /health  →  {"ok":true,"service":"roombeam-signaling","uptimeSeconds":…,"rooms":…,"peers":…}
```

Serve it over **HTTPS**. Without a secure context the client has no WebRTC and no
way to say so clearly.

---

Something behaving differently from this guide is worth reporting. What is *not* a
bug: one-to-many broadcast and folder transfer are not built yet, and resume does
not survive closing the tab. See the end of [README.md](README.md) for the full
list of gaps and what remains untested.
