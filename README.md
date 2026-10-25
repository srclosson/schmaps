# 🍁 Schmaps

An **all-Canadian**, voice-driven, traffic-aware mapping application you can
install on your phone. Tap the mic, say an address, and Schmaps resolves it,
draws the route, and tells you when you'll actually arrive — with live
provincial traffic incidents and typical rush-hour congestion baked into the
ETA.

## The all-Canadian stack

| Concern | Service | Notes |
| --- | --- | --- |
| Geocoding | [geocoder.ca](https://geocoder.ca/api) | Toronto, ON. Free JSON port; optional auth token for unthrottled use. |
| Vector maps | [OpenFreeMap](https://openfreemap.org) + [MapLibre GL](https://maplibre.org/) | OpenStreetMap data, no API key, no limits. MapLibre is vendored locally. |
| Routing | [OSRM](https://project-osrm.org/) @ [FOSSGIS](https://routing.openstreetmap.de/) | Open-source routing on OpenStreetMap data, no API key, EU-hosted (Germany). Its trip service also plans errands visiting order. |
| ETA consensus | [TomTom Routing](https://developer.tomtom.com/routing-api) + [Stadia Maps](https://docs.stadiamaps.com/routing/) | Independent travel-time witnesses for the ETA; keys held server-side by `server.js`. |
| POI search | [Nominatim](https://nominatim.org/) | OpenStreetMap businesses for errands mode; usage policy max 1 req/s. |
| Live traffic | [Ontario 511](https://511on.ca/developers/resources) | Government of Ontario, Open Government Licence. Proxied + cached by `server.js`. |
| Voice input | Web Speech API (`en-CA`) | Built into the browser — no third party. |

> **Why the proxy?** The Ontario 511 API sends no CORS headers and throttles
> to 10 requests per 60 seconds. `server.js` fetches it once per minute,
> caches it, and serves it same-origin at `/api/traffic/events`. That same
> backend is the foundation for the planned Android Auto build.

## Quick start

Requires Node.js 18+ (no npm dependencies — zero-install).

```bash
npm start
# 🍁 Schmaps listening on http://localhost:3000
```

Open <http://localhost:3000> in your browser.

## Install on your phone

Schmaps is a PWA (Progressive Web App). For install + microphone +
geolocation, serve it over **HTTPS** (or use `localhost` for desktop
testing). Any static-friendly host works — deploy `server.js` to a Node
host, or put the `public/` folder behind any HTTPS reverse proxy that also
forwards `/api/*` to the Node server.

- **Android (Chrome/Edge):** open the site → menu ⋮ → **Add to Home screen**
  → **Install**. It launches fullscreen with the maple-leaf icon.
- **iOS (Safari):** open the site → Share → **Add to Home Screen**.
  > Note: iOS Safari does not support the Web Speech API's speech
  > *recognition*, so voice input is disabled there — typed search works
  > everywhere. Chrome on Android gives the full talk-to-drive experience.

## Using it

### The screen stays on

While Schmaps is open and visible, it holds a Screen Wake Lock — the
display never times out mid-drive. The browser releases the lock when
you switch away, and Schmaps re-acquires it when you come back.
(Older browsers without the API keep their normal timeout.)

### Car gauges — OBD-II over the map

Plug a classic-Bluetooth ELM327 adapter into the car's OBD port, run
the **Schmaps OBD bridge** app (see `android-bridge/`), and a live
gauge strip appears above the route panel: **RPM**, **km to empty**,
**oil-change countdown**, and **coolant temperature**.

The bridge holds the Bluetooth connection and re-serves the feed on
`http://127.0.0.1:8080/obd.json` — localhost is the one non-HTTPS
target an HTTPS page may fetch, so the gauges work with zero internet.
No bridge running? The strip simply stays hidden; schmaps is
unchanged. The first contact triggers Chrome's one-time
"local network" permission prompt — allow it.

Tap the strip's **⚙** once to set your car's numbers: tank size,
economy (used when the car can't report fuel rate — pre-2008 cars),
oil-change interval, and the odometer now / at the last change. The
oil gauge is an honest km countdown — no car exposes oil life over
standard OBD — and it ticks down from the bridge's speed feed as you
drive. It turns amber under 1 000 km and red when overdue.

### GPS lock before planning

The first fix a phone reports can be a coarse cell-tower estimate —
off by hundreds of metres — and planning from it would start the
route in the wrong place. Schmaps waits for a fix accurate to
~50 m (settling for the best it saw after 10 s) before computing any
route, errands plan, or "nearby" search. If location is off or
denied, it falls back to the map centre and says so.

1. Tap the **red mic button** (or type in the search box).
2. Say a Canadian address, e.g. *"101 Wellington Street, Ottawa, Ontario"*.
3. Schmaps geocodes it, computes the fastest driving route, and shows a
   compact card with:
   - distance,
   - **ETA** — the drive time with typical congestion and live 511
     incidents along the corridor folded in,
   - your **arrival time**.
4. Follow-me navigation starts on its own — the card stays out of the
   way in the corner and the map does the talking. Tap the **✕** in the
   card's corner (or clear the search box) to end the route.

### "Back to location" — look around freely

While navigating, the camera follows your GPS. The moment you drag,
zoom, or rotate the map yourself, the follow pauses — look around as
long as you like — and a **📍 Back to location** pill appears at the
top. Tap it to re-centre on your position and resume the follow. Your
own gestures are the only thing that pauses it; the app's own camera
moves never do.

### Voice guidance on/off

Tap the **speaker button** (next to the mic) to mute or unmute spoken
guidance. The preference is remembered across launches.

### "Did you mean…" — fuzzy place correction

Voice recognition sometimes mis-hears place names (*"Perth"* → *"pearl"*).
When Nominatim can't resolve a query, or returns only a low-confidence
place-level match, Schmaps searches a built-in gazetteer of ~2,800 Canadian
communities (GeoNames data) using a phonetic + edit-distance matcher and
offers a tappable list of candidates — it never guesses for you:

> No "pearl" found — did you mean… **Perth, Ontario** · **Mount Pearl, Newfoundland and Labrador**

Tap a chip to route there. The gazetteer is generated by
[`scripts/gen-places.js`](scripts/gen-places.js) and matched in
[`public/js/places.js`](public/js/places.js).

### Address fallback chain — never give up on an address

Address-shaped queries (a house number, a street type, a postal code)
run through two OpenStreetMap geocoders before Schmaps gives up:

1. **Nominatim** (OpenStreetMap) — global, robust to imperfect input
2. **Photon** (Komoot, Berlin) — European, built for typeahead

If one API finds nothing — or isn't confident — the next takes over.
Both are OpenStreetMap-based, restricted to Canadian results, and
fronted by our own server (`/api/osm/*` in `server.js`) so Nominatim's
User-Agent requirement and 1 req/s usage policy are honored. The chain
lives in [`public/js/geocoders.js`](public/js/geocoders.js).

### Errands mode — several stops, best order

Say or type several stops in one go:

> *"errands: ikea, burger king around lunch, and the thrift store"*

You don't need the keyword when the request names tasks or sequences
stops — *"I need to go to home hardware, buy gas, and groceries"* works
too. Tasks map to nearby place types: *buy gas* → nearest gas station,
*groceries* → supermarket, *pharmacy*, *haircut* → hair salon, *the
beer store*… A single task (*"take me to the pharmacy"*) routes to the
nearest match. Address-shaped queries (*"5 Bank Street, Ottawa"*) never
trigger errands mode by mistake, and business names the address
geocoder can't find fall back to nearby POI suggestions.

Schmaps splits the request into stops, finds each one near you
(Nominatim POI search → Nominatim geocode → the fuzzy gazetteer), and asks
OSRM's **trip service** for the most efficient visiting order — a
travelling-salesman solve done by the routing engine, no AI service
required. Stops appear as numbered markers on the map and a numbered
list in the route card, each with their arrival time, so "continue to the
next destination" is plain to see. Stops that can't be found are skipped
and reported, not fatal. Parsing and planning live in
[`public/js/errands.js`](public/js/errands.js) with POI search in
[`public/js/poi.js`](public/js/poi.js).

### Category browse — every option on the map

Type a bare "what you need" — *oil change*, *coffee*, *gas*, *pharmacy*
— and Schmaps pins every nearby match instead of guessing one. Each pin
is coloured by its opening hours (from OpenStreetMap, evaluated on your
clock): **green** open now, **amber pulsing** closing within the hour
("⚠️ Closing soon — 5 pm"), **orange** opens later today, **dark grey**
closed for the day — still on the map, just dimmed. Tap a pin for name,
address, distance, and a Navigate button.

Pan away or zoom out and a **🔍 Search this area** pill appears — tap it
to re-run the search around the new viewport. When Overpass can't be
reached, the search degrades to Nominatim pins marked "hours unknown".
Phrasings with travel words ("take me to gas") still route straight to
the nearest match, and multi-stop requests still go through errands
mode. The vocabulary lives in
[`public/js/categories.js`](public/js/categories.js), the hours
evaluator in [`public/js/hours.js`](public/js/hours.js).

### Alternative routes & the USA question

Every route request asks OSRM for up to three alternatives — they ride
along with the same call, no extra round-trip. Alternatives are drawn
as muted gray lines under your route, and each gets a chip in the
route card:

> **Route 2 · 41 min · 🍁 Stays in Canada** · **Route 3 · 38 min · via USA**

Each alternative is checked against a simplified Canada–US border
polyline ([`public/data/ca-border.json`](public/data/ca-border.json)) —
a geometric segment-intersection test, not a latitude guess (Toronto at
43.7°N sits south of Point Pelee at 41.9°N, and both are Canadian). If
the fastest route crosses into the USA and a Canadian alternative
exists, a banner appears in the card and Schmaps says so once — but it
never switches routes for you. Tap a chip to take that route; the one
you were on becomes a chip itself.

**The Canada guarantee.** When the fastest route *and* every OSRM
alternative dip through the USA, Schmaps synthesizes a Canadian option
so staying in Canada is always on the table: it routes
origin → a Canadian town → destination, trying gazetteer communities
near the direct line (closest first, spread apart, at most three
attempts) and keeping the fastest via-route that clears the border —
the chip reads **🍁 Canada via Parry Sound**. The winning via-town is
cached, so an off-route reroute re-verifies it with a single OSRM
call. A destination inside the USA makes every via-route cross too,
so none is invented — the guarantee is "a Canadian route whenever one
exists", not a promise to avoid the USA at any cost. Your chip choice
survives reroutes: pick the Canadian route and you stay on it.

Mid-drive, the same alternatives are re-examined whenever a route is
recomputed — the initial compute, or an off-route reroute. If one now
saves five minutes or more, a **“Quicker route · saves ~7 min”** card
appears with **Switch** / **Dismiss** — spoken once, never
auto-applied. If the advantage evaporates by the next check, the card
quietly disappears.

### The 3-colour traffic line

The route line is drawn stretch by stretch — **blue** for clear roads,
**yellow** for a moderate slowdown, **red** for heavy — from the same
congestion model that drives the ETA, sampled every ~2 km and folded
together with live 511 incidents. Slowdowns worth a minute or more get
a pill on the line — **+6 min** — tap it for where, and how bad. The
route card drops the percentages: the traffic note is plain language
(“Mostly clear — one slow stretch near Milton (+6 min)”), and the same
summary is spoken once per route. In errands mode the line is coloured
per leg and the pills only mark the leg you're driving.

### Saved places & tags — “go to Grandma’s House”

Any destination can be named. Route somewhere, and the route card
offers a 🏷️ **name + tags** form: save “12 REDACTED Court, Kanata,
Ontario” as *Grandma’s House*, tag it *family*, and from then on
*“go to Grandma’s House”* — typed or spoken — routes straight there, no
geocoder involved. Names match fuzzily, so voice input survives a
mis-heard syllable or two. A tag on its own filters your places:
*“go to family”* lists every place tagged family. Saved places work in
errands too — *“errands: Grandma’s House, buy gas”* — and every routed
destination is remembered as a recent trip. Everything lives in
`localStorage` on your device; nothing is uploaded. Storage lives in
[`public/js/places-store.js`](public/js/places-store.js).

### Tap the map — “Navigate here”

Long-press anywhere on the map (or right-click on desktop) and a pin
drops with a **Navigate here** button. The spot is reverse-geocoded
(Photon → Nominatim, honest coordinates as the last resort) so the
route card shows a readable label, and the same 🏷️ save form appears —
name the pin “Boat Launch” and it becomes a saved place like any other.
Once the vehicle is moving (~100 m from where navigation started), the
save form cancels itself — the moment to name the place has passed.

> **v0.2.15:** the popup was empty on some devices — MapLibre refuses
> to render a popup with no position, so the pin's popup now gets its
> coordinates before it joins the map, and Android's duplicate
> long-press event can no longer stack a second one.

### Typeahead — the search box fills in the rest

As you type, a dropdown appears under the search box: 🏷️ saved places,
🕘 recent trips and 📍 live address matches from Photon, ranked for how
you actually travel:

1. **Near places** — anything within ~25 km of you (latest GPS fix,
   route origin, or map view).
2. **Common places** — spots you've driven to two or more times.
3. **Tagged places further away** — saved places with tags, even far
   from home.
4. **Everything else** — the rest, nearest first.

Photon is also told where you are, so its address matches lean toward
your area before ranking even starts. Once the list narrows to about
ten, the most probable match fills in the rest of the field inline,
selected — keep typing to refine it, ↑/↓ to move between rows,
**Enter** to route to the highlighted one, **Tab** to accept the
completion, **Esc** to dismiss. The places you actually go rise to
the top.

### Self-update — the app checks for new versions

Schmaps keeps itself fresh. The page asks the service worker registry for
a newer `sw.js` on launch, every 15 minutes, and whenever you come back
to the tab. When a new version has downloaded, a small prompt appears at
the bottom: **"A new version of Schmaps is ready — Update"**. Nothing
swaps under you mid-drive; the new worker *waits* until you tap
**Update**. When you do, the old caches are wiped, the new worker takes
over, and the app reloads onto a clean shell — no stale files, no
"clear your cache" advice needed. Tap **✕** for "not now" — the
dismissal is remembered per version, across refreshes, until a *newer*
version appears.

## How the ETA works

```
ETA = free-flow time (OSRM)
    + per-stretch congestion delay (rush-hour model, urban vs rural,
      weekend-aware — sampled every ~2 km along the route)
    + live incident delays (Ontario 511 events within 2.5 km of the
      route, counted only while their schedule says they're active)
```

### Routing consensus — a second (and third) opinion

The ETA above is Schmaps' own estimate. For accurate destination
timing, every route is also cross-checked against two independent
routing engines — **TomTom** (live traffic) and **Stadia Maps**
(Valhalla, `auto_traffic` profile) — queried in parallel so they add
no wait. The three estimates go through a simple consensus:

1. Two estimates **agree** when they differ by at most
   `max(2 min, 20% of the median)` — the flat floor keeps short trips
   honest, the percentage lets long hauls breathe.
2. The largest agreeing cluster is averaged into the ETA; the outlier
   is **discarded**.
3. Ties prefer the cluster containing Schmaps' own estimate (it's the
   route actually drawn), then the tighter spread.
4. No witnesses, or no agreement at all — Schmaps' estimate stands.
   Consensus refines the ETA; it never blocks or overrides a route.

The route card says which engines agreed, e.g. *"ETA confirmed by
Schmaps and TomTom — averaged across 2 engines; Stadia Maps disagreed
and was set aside."* The witness engines are reached through
`/api/routing/witness` on our own server, so their API keys never ship
to the client. Set them as environment variables when running
`server.js`:

```bash
TOMTOM_KEY=… STADIA_KEY=… npm start
```

A missing key silently disables that witness — consensus degrades to
whatever engines remain. The tolerance lives in
[`public/js/config.js`](public/js/config.js) (`ROUTING_CONSENSUS`);
the algorithm lives in [`public/js/routing.js`](public/js/routing.js)
(`consensusEstimate`).

The route is cut into ~2 km stretches; each stretch gets a congestion
factor and any incidents that land on it. That one cut drives both the
3-colour line (with its “+min” pills) and, summed, the traffic part of
the ETA. The thresholds, colours and per-severity incident delays live
in [`public/js/config.js`](public/js/config.js) — tune them to your
liking.

Two accuracy guards keep the ETA honest:

- **Schedule-aware incidents.** Ontario 511 lists future work weeks
  in advance and stretches "Nightly Construction" windows across whole
  days. An event only counts toward the ETA while its `StartDate` →
  `PlannedEndDate` window is actually active — and "nightly" events
  only during the overnight hours (19:00–06:00). Without this, an
  afternoon Perth → Kanata drive was charged 20 minutes for
  construction that only exists at night.
- **Metro-depth congestion.** The rush-hour factor blends from full
  urban in a metro core to rural at the metro edge, instead of
  flipping to the full urban factor the moment a stretch brushes a
  metro's radius. Mostly-rural corridors with a suburban tail (Hwy 7
  into Kanata) no longer get charged downtown congestion.

While you're navigating, the route is computed **once** and the ETA is
re-derived locally on **every GPS fix** — no router call needed. The
trip is cut into 1-km buckets carrying the router's own time and
assumed speed per km; the current km is timed at your live speed, the
kms ahead at your personal speed ratio (a smoothed measure of how much
faster or slower you actually drive than the router assumes — posted
limits come from OSM's Overpass when available), and live 511 incident
delay is added where it sits on the route. Schmaps speaks up only when
your arrival time shifts by five minutes or more.

The router is only asked again when you actually **leave the route**:
two consecutive fixes more than ~150 m off the line trigger a single
reroute from where you are. (A deliberate turn onto an already-known
alternative just promotes that route — zero API calls.) A slow
5-minute tick still re-pulls Ontario 511 events and re-colours the
same line. Errands stops you reach are checked off (✓) and the
remaining stops re-time from where you are, in the planned order.

**Driver learning.** How you actually drive is measured per **posted
speed-limit bucket** (50, 80, 100, 110 — rounded to the nearest
10 km/h) and kept **on the device** — localStorage, never a cookie (the
server never needs it, and your driving style stays yours). Each bucket
carries a global **driver scalar** (multiplier) and a sample count, so
trips merge losslessly: a scalar of 1.04 on the 100 km/h bucket over
1000 samples, plus today's ten more, updates it exactly. The predicted
speed on any road is `posted limit × bucket scalar` — a driver who does
104 in 100-zones does it on *any* 100-zone, which is what makes the model
portable across regions (Ontario vs. Alberta) where road
classifications differ but behaviour relative to the limit doesn't.
Future kilometres are re-timed down a **fallback hierarchy**: a
segment-specific override first (only for heavily-traveled roads that
persistently deviate from their bucket — more than 3 samples and off
the bucket scalar by over 10%), then the bucket scalar × posted limit,
then the raw posted limit itself. Learning is **lean**: the store is a
tiny lookup map of buckets plus a handful of deviant segments, well
under the 5 MB localStorage cap — converged segments are pruned, not
hoarded. And the model is **anomaly-protected**: stretches flagged with
a live 511 incident are never learned from, samples below 45% of the
limit (gridlock, a red-light crawl) or above 150% (GPS noise) are
discarded — traffic is a transient event, not a structural change to
how a road moves. The model lives in
[`public/js/driver-profile.js`](public/js/driver-profile.js).

### Turn-by-turn guidance — next turn, distance, and lanes

While navigating, a banner at the top of the screen shows the next
maneuver: a turn arrow, the instruction ("Turn right onto Highway 7"),
and how far away it is ("in 750 m"). When OSRM reports lane data for
the upcoming intersection, the banner also shows a row of lane arrows —
the lanes you should be in are lit, the rest are dimmed.

The data comes from OSRM's `steps=true` response: each step carries a
`maneuver` (type + modifier + road name) and, on its first
intersection, `lanes` with `valid` flags and `indications`. Schmaps
extracts these into a `maneuvers` array on every route (primary,
alternatives, Canada-via, and errands trips), then tracks your position
along the route geometry on each GPS fix to find the next upcoming
turn and the distance to it. The banner speaks the turn once when you're
within 500 m (respecting the voice mute toggle).

The extraction lives in
[`public/js/routing.js`](public/js/routing.js) (`extractManeuvers`);
the tracking and banner live in
[`public/js/app.js`](public/js/app.js) (`updateTurnBanner`).

## Project layout

```
server.js                  zero-dependency Node server + 511 traffic + routing-witness proxies
public/
  index.html               app shell
  manifest.webmanifest     PWA manifest (installable)
  sw.js                    service worker (offline app shell)
  css/app.css              Canadian-themed UI
  js/
    app.js                 orchestration: voice → geocode → route → render
    config.js              all service endpoints + traffic tuning
    errands.js             errands mode: parse → resolve → OSRM trip ordering
    poi.js                 Nominatim POI search (businesses for errands)
    voice.js               Web Speech API wrapper (en-CA) + mute toggle
    geocode.js             geocoder.ca client
    geocoders.js           address fallback chain (geocoder.ca → Nominatim → Photon) + Photon typeahead
    places.js              fuzzy "did you mean" matcher (phonetic + edit distance)
    places-store.js        saved places, tags & recent trips (localStorage)
    routing.js             OSRM client + traffic-adjusted ETA + consensus
    traffic.js             511 incident matching + congestion model
    obd.js                 OBD-II gauges: bridge transport + range/oil math
  data/ca-places.json      GeoNames gazetteer of ~2,800 Canadian places
  data/ca-border.json      simplified Canada–US border polyline (USA detection)
  vendor/                  MapLibre GL (vendored for offline use)
  icons/                   generated maple-leaf icons
scripts/gen-icons.js       zero-dependency PNG icon generator (npm run icons)
scripts/gen-places.js      GeoNames → ca-places.json gazetteer generator
android-bridge/            Kotlin app: classic-BT ELM327 → 127.0.0.1:8080 feed
.github/workflows/         CI: signed APK builds for the bridge
```

## Roadmap

- [ ] **Android Auto** — the Node backend already exposes
      `/api/traffic/events`; next step is a native Android shell
      (Kotlin + MapLibre Native) reusing the same services. The OBD
      bridge app (`android-bridge/`) is the first brick: same repo,
      same Bluetooth stack, one more surface.
- [ ] More provincial 511 feeds (BC's Open511, Alberta 511, Québec 511)
      behind the same `/api/traffic/events` endpoint.
- [ ] Live speed-based ETA (probe/flow data) to replace the congestion model.
- [ ] Offline vector tile region packs.

## Deploying to Kubernetes

Schmaps ships with manifests under [`k8s/`](k8s/) and an in-cluster build
pipeline (no local Docker required).

**Live deployment:** <https://schmaps.srclos.zone>

### Build & push the image (Kaniko, in-cluster)

```bash
bash k8s/build.sh
# On a shared kubeconfig, pin the cluster explicitly:
SCHMAPS_KUBE_CONTEXT=kubernetes-admin@kubernetes bash k8s/build.sh
```

This packages the build context as a gzipped tar, serves it from a temporary
in-cluster HTTP server, and runs a [Kaniko](https://github.com/GoogleContainerTools/kaniko)
job that builds the image and pushes it to Harbor as
`harbor.srclos.zone/library/schmaps:{latest,v0.2.17}`.

> **Note:** the build pushes to Harbor's `library` project, which requires a
> `harbor-pull-secret` in the `schmaps` namespace with **push** credentials.
> The script copies it from the `gtky` namespace if absent.

### Apply the manifests

```bash
kubectl apply -f k8s/namespace.yaml \
              -f k8s/deployment.yaml \
              -f k8s/service.yaml \
              -f k8s/hpa.yaml \
              -f k8s/ingress.yaml
```

### What gets deployed

| Resource | Details |
| --- | --- |
| **Deployment** | 2 baseline replicas, spread across nodes, non-root, read-only root FS, health probes on `/api/health`. Requests 100m/128Mi, limits 500m/256Mi. |
| **Service** | ClusterIP :80 → :3000. |
| **HPA** | autoscaling/v2, **2 → 10 pods** on CPU 60% / memory 75%. Sized for ~500 concurrent users (~50/pod). |
| **Ingress** | `schmaps.srclos.zone`, nginx class, cert-manager `letsencrypt-production` TLS, external-dns (Cloudflare, not proxied). |

> **HPA prerequisite:** the HPA needs
> [metrics-server](https://github.com/kubernetes-sigs/metrics-server). If your
> cluster lacks it: `kubectl apply -f
> https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`
> (add `--kubelet-insecure-tls` on clusters whose kubelet certs lack IP SANs).

## Data licences

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors (ODbL), served by OpenFreeMap.
- Traffic data: Government of Ontario,
  [Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario).
- Geocoding: [geocoder.ca](https://geocoder.ca/) terms apply; free port is
  throttled — consider an auth token for heavier use.
- POI search: [Nominatim](https://nominatim.org/) usage policy applies
  (max 1 request/second); results © OpenStreetMap contributors.
- Place gazetteer: [GeoNames](https://www.geonames.org/) (CC-BY 4.0),
  filtered to Canadian populated places.
