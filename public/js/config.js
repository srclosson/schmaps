/**
 * Schmaps configuration — all-OpenStreetMap, all-Canadian.
 *
 * The whole map stack lives on OpenStreetMap services, all keyless and
 * all proxied through the server (`/api/osm/*`, spec §8 shape):
 *   Map tiles    : OpenFreeMap vector styles (light + dark themes).
 *   Geocoding    : Nominatim — addresses, businesses, dropped pins.
 *   Typeahead    : Photon (Komoot, OSM data) — the search box.
 *   Routing      : OSRM @ FOSSGIS — driving routes, alternatives, and
 *                  the errands trip service.
 *
 * The rest of the stack keeps its Canadian accents:
 * Traffic   : Ontario 511 (Government of Ontario, Open Government Licence)
 *              via /api/traffic/events.
 * Routing consensus (optional second opinions) : TomTom + Stadia Maps
 *              via /api/routing/witness — keys server-side, never shipped.
 */

export const GEOCODER = {
  // Nominatim (OpenStreetMap), proxied through the server so the
  // upstream gets a real User-Agent and its 1 req/s policy is honored.
  endpoint: '/api/osm/geocode',
};

export const OBD = {
  // The Schmaps OBD bridge app (android-bridge/) holds the classic-
  // Bluetooth ELM327 connection and re-serves the feed on localhost —
  // the one non-HTTPS target an HTTPS page may fetch (127.0.0.1 is a
  // "potentially trustworthy origin"). Chrome shows a one-time local-
  // network permission prompt on first contact.
  bridgeUrl: 'http://127.0.0.1:8080/obd.json',
  // How often to poll the bridge. The bridge itself samples the car
  // at 1 Hz; matching that keeps the gauges live without hammering.
  pollMs: 1000,
  // A gauge goes dim after this long without fresh data (the bridge
  // app was stopped, Bluetooth dropped, etc.) — stale numbers are
  // worse than none.
  staleMs: 5000,
  // Range gauge: fuel rate (PID 0x5E) needs a 2008+ car. On older
  // cars the bridge reports null and we fall back to this economy
  // figure (L/100 km) for "km till empty".
  fallbackLper100: 9.0,
  // Oil-change countdown: no standard PID exists for oil life, so
  // this is an honest km-based interval the user configures (and the
  // app counts down using the bridge's speed feed).
  defaultOilIntervalKm: 8000,
};

/**
 * Selection-mode auto-start. When a route is computed and the Start
 * CTA appears, a countdown runs this long; if the user hasn't tapped
 * Start (or chosen a route) by the end, navigation begins on the
 * current primary — the suggested route. The button fills left→right
 * with the solid blue over the countdown so the deadline is visible.
 */
export const START_TIMEOUT = {
  ms: 10_000,
};

export const GPS = {
  // Route planning waits for a fix at least this accurate (metres) —
  // a coarse cell-tower fix can be off by a kilometre, which plans
  // the route from the wrong spot. If the deadline passes we settle
  // for the best fix seen.
  accuracyM: 50,
  // How long to hunt for a good fix before settling for the best one.
  timeoutMs: 10000,
  // Only fresh fixes — a cached fix is stale the moment you move.
  maxAgeMs: 0,
};

export const MAP = {
  // The MapLibre style JSON is served by /api/osm/style — OpenFreeMap
  // vector tiles (OSM data), keyless, cached 24h server-side per
  // theme. The browser fetches tiles/glyphs/sprites directly.
  style: '/api/osm/style',
  // Geographic centre of Canada, near Baker Lake, NU.
  center: [-96.0, 56.0],
  zoom: 3.4,
  maxBounds: [
    [-142.0, 40.0], // SW — just past Vancouver Island / US border
    [-51.0, 62.0],  // NE — past St. John's, NL
  ],
};

export const ROUTER = {
  // OSRM @ FOSSGIS (OpenStreetMap routing), proxied through /api/osm/*.
  // Keyless. `profile` completes the /api/osm/route/v1/{profile}/ and
  // /api/osm/trip/v1/{profile}/ URLs the errands planner builds.
  endpoint: '/api/osm',
  profile: 'driving',
  // Ask OSRM for up to this many alternative routes alongside the
  // fastest — each is traffic-adjusted and flagged for USA crossings.
  alternatives: 3,
};

/**
 * Routing consensus — accurate destination timing by cross-checking
 * our HERE estimate against independent routing engines. TomTom and
 * Stadia Maps are queried through /api/routing/witness, which holds
 * their API keys server-side. Two or more estimates that land within
 * the agreement tolerance form the consensus: their average becomes
 * the ETA and the outlier is discarded.
 */
export const ROUTING_CONSENSUS = {
  witnessUrl: '/api/routing/witness',
  agreementSeconds: 120,
  agreementPercent: 0.2,
  timeoutMs: 4500,
};

/**
 * Photon (Komoot, OpenStreetMap data) — typeahead-grade, biased to
 * "near" the user. Behind the search box in Zone 3 (top search bar,
 * spec §3).
 */
export const PHOTON = {
  // The adapter is Photon again — the name callers know is kept.
  endpoint: '/api/osm/autosuggest',
  // Bias results to Canada's bounding box (minLon,minLat,maxLon,maxLat).
  bbox: '-142.0,40.0,-51.0,62.0',
  limit: 10,
};

// OpenStreetMap Nominatim — used by js/poi.js to resolve named places
// ("ikea", "burger king") that an address geocoder can't. Nominatim's
// public instance permits low-volume browser-direct traffic; the rate
// is capped at 1 req/s in js/errands.js. countrycodes=ca keeps results
// inside Canada regardless of where the user is searching from.
export const POI = {
  endpoint: 'https://nominatim.openstreetmap.org/search',
  countryCodes: 'ca',
  limit: 5,
};

// Nominatim reverse — for the long-press "Navigate here" pin.
export const REVERSE_GEOCODE = {
  endpoint: '/api/osm/reverse',
};

export const TRAFFIC = {
  eventsUrl: '/api/traffic/events',
  corridorKm: 2.5,
  delayMinutes: {
    closure: 25,
    major: 15,
    moderate: 8,
    minor: 4,
    unknown: 5,
  },
  segmentKm: 2,
  thresholds: { moderate: 2.0, heavy: 10.0 },
  colors: {
    clear: '#1e88e5',
    moderate: '#f9a825',
    heavy: '#d52b1e',
    neutral: '#2563eb',
    travelled: '#9aa0a6', // the driven part of the line during navigation
  },
  maxBadges: 4,
};

/**
 * Alternative routes & the USA question. Alternatives ride along with
 * every route request; the app never auto-switches — it offers chips,
 * a banner, and mid-drive "quicker route" cards.
 */
export const ALT_ROUTES = {
  borderUrl: 'data/ca-border.json',
  minSavingsSeconds: 5 * 60,
  canadaVia: {
    nearCorridorKm: 250,
    hubCorridorKm: 400,
    hubMinPop: 5000,
    minEndKm: 30,
    spreadKm: 60,
    maxTries: 6,
    maxDistanceRatio: 2.5,
  },
};

/**
 * Typical congestion model — multiplies free-flow travel time based
 * on the hour of day and whether the route is urban. Used when HERE
 * traffic data isn't available.
 */
export const CONGESTION = {
  windows: [
    [7, 9.5, 1.45, 1.10],
    [15.5, 18.5, 1.55, 1.15],
    [11.5, 13, 1.15, 1.02],
  ],
  weekendScale: 0.55,
  metros: [
    { name: 'Toronto', lat: 43.6532, lon: -79.3832, radiusKm: 60 },
    { name: 'Montreal', lat: 45.5019, lon: -73.5674, radiusKm: 50 },
    { name: 'Vancouver', lat: 49.2827, lon: -123.1207, radiusKm: 50 },
    { name: 'Calgary', lat: 51.0447, lon: -114.0719, radiusKm: 40 },
    { name: 'Edmonton', lat: 53.5461, lon: -113.4938, radiusKm: 40 },
    { name: 'Ottawa', lat: 45.4215, lon: -75.6972, radiusKm: 40 },
    { name: 'Winnipeg', lat: 49.8951, lon: -97.1384, radiusKm: 35 },
    { name: 'Quebec City', lat: 46.8139, lon: -71.208, radiusKm: 35 },
    { name: 'Hamilton', lat: 43.2557, lon: -79.8711, radiusKm: 30 },
    { name: 'Halifax', lat: 44.6488, lon: -63.5752, radiusKm: 30 },
    { name: 'Victoria', lat: 48.4284, lon: -123.3656, radiusKm: 25 },
    { name: 'Saskatoon', lat: 52.1332, lon: -106.67, radiusKm: 25 },
    { name: 'Regina', lat: 50.4452, lon: -104.6189, radiusKm: 25 },
    { name: "St. John's", lat: 47.5615, lon: -52.7126, radiusKm: 25 },
    { name: 'London', lat: 42.9849, lon: -81.2453, radiusKm: 25 },
    { name: 'Kitchener-Waterloo', lat: 43.4516, lon: -80.4925, radiusKm: 25 },
  ],
};
