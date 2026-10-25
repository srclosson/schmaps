# Schmaps OBD Bridge (Android)

A tiny native Android app that turns a **classic Bluetooth ELM327
adapter** into a live OBD feed the schmaps PWA can read.

```
ELM327 (classic BT, SPP) ──RFCOMM──▶ this app (foreground service)
     ──HTTP──▶ http://127.0.0.1:8080/obd.json ──▶ Chrome ──▶ schmaps gauges
```

## Why this exists

Browsers only expose hardware through Web Bluetooth, which is
BLE/GATT-only. The cheap classic-Bluetooth ELM327 clones (the ones
"compatible with Torque Pro") are invisible to Chrome — forever. A
native app gets the full Android Bluetooth stack, so it holds the
RFCOMM connection and re-serves the data on **localhost**, the one
non-HTTPS target an HTTPS page is allowed to fetch (127.0.0.1 counts
as a "potentially trustworthy origin").

## What it serves

`GET http://127.0.0.1:8080/obd.json` — polled by the PWA once a second:

```json
{
  "rpm": 2145,
  "speedKmh": 87,
  "coolantC": 88,
  "fuelRateLh": 5.4,
  "connected": true
}
```

Standard PIDs only — every car supports them: RPM (0x0C), speed
(0x0D), coolant (0x05), fuel rate (0x5E). "Km till empty" and the
oil-change countdown are computed in the PWA (tank size and oil
interval are user settings there); the bridge just ships raw values.

`GET /health` returns `{"ok":true}` — handy for a quick check from
Chrome on the phone.

## Build (GitHub Actions — no local Java needed)

The repo isn't a git repository yet, so from the project root:

```sh
git init
git add .
git commit -m "schmaps + OBD bridge"
# create an empty repo on GitHub named "shmaps", then:
git remote add origin git@github.com:YOURNAME/shmaps.git
git push -u origin main
```

Then, on GitHub:

1. **Actions → "android-bridge APK" → Run workflow** with
   **"Generate keystore"** ticked. The run creates a fresh signing
   keystore and uploads it as an artifact
   (`schmaps-bridge-keystore`). The password is printed in the run's
   summary — save it.
2. Download the keystore artifact, then add four repo secrets
   (**Settings → Secrets and variables → Actions**):
   - `KEYSTORE_BASE64` — `base64 -i schmaps-bridge.jks` (paste the output)
   - `KEYSTORE_PASSWORD` — the password from step 1
   - `KEY_ALIAS` — `schmapsbridge`
   - `KEY_PASSWORD` — same as `KEYSTORE_PASSWORD`
3. Run the workflow again (no input needed). Download the
   `schmaps-bridge-apk` artifact — that's the signed APK.

Every later push that touches `android-bridge/` rebuilds the APK
automatically, signed with the same key, so updates install right
over the old version.

## Install on the phone

1. Copy the APK to the phone (download it straight from the GitHub
   artifact in Chrome works fine).
2. Tap it → Android asks to allow installs from that source → allow.
3. Open **Schmaps Bridge**, grant Bluetooth + notifications
   permissions when asked.
4. Pair the ELM327 in Android's Bluetooth settings first if you
   haven't (the app auto-picks the paired device whose name looks
   like an adapter — "OBDII", "ELM327", "V-LINK"… — or the only
   paired device).
5. Tap **Start bridge**. The notification "Connected — feeding
   schmaps" means the PWA will pick it up.
6. In schmaps, tap the gauge strip's ⚙ to set tank size and the oil
   interval once.

## Chrome's local-network prompt

The first time schmaps polls the bridge, Chrome shows a one-time
permission prompt ("allow access to local network") — allow it. The
bridge answers the preflight with
`Access-Control-Allow-Private-Network: true`, which is what Chrome
requires for an HTTPS page to reach a loopback server.

## Project layout

```
android-bridge/
├── app/src/main/java/ca/srclos/schmapsbridge/
│   ├── MainActivity.kt      # start/stop switch + status
│   ├── BridgeService.kt     # foreground service: socket + poll loop
│   ├── BridgeState.kt       # process-wide observable state
│   ├── Elm327.kt            # AT commands + PID parsing (clone-tolerant)
│   ├── Poller.kt            # 1 Hz PID polling + JSON snapshot
│   └── BridgeHttpServer.kt  # loopback-only NanoHTTPD server
└── app/src/main/res/…       # layout, strings, adaptive icon
```

## Notes & limits

- **Loopback only.** The HTTP server binds 127.0.0.1 — the feed
  never leaves the phone, and no other device on the car's WiFi can
  reach it.
- **Clone-tolerant protocol layer.** Echo off (ATE0), linefeeds off,
  prompt-terminated reads, NO DATA/SEARCHING stripped, 1.5 s
  timeouts. Cheap clones are slow; the poller just retries next tick.
- **Fuel rate (0x5E)** needs a 2008+ car (CAN bus). On older cars the
  PWA falls back to a configured L/100 km for the range gauge.
- **No oil-life PID exists** — no car exposes it over standard OBD.
  The PWA's oil gauge is an honest km-based countdown you configure.
- This app is the seed of a future schmaps-android (Android Auto)
  app: same repo, same Bluetooth stack, one more surface.