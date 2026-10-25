#!/usr/bin/env node
/**
 * Schmaps server — zero-dependency Node.js.
 *
 * 1. Serves the PWA from ./public
 * 2. Proxies provincial 511 traffic feeds (Ontario 511) with in-memory
 *    caching, because the upstream API sends no CORS headers and throttles
 *    to 10 requests per 60 seconds.
 * 3. Fronts the OpenStreetMap map stack — OpenFreeMap vector styles,
 *    Nominatim geocoding/reverse-geocoding (serialized to their 1 req/s
 *    policy), and Photon typeahead. All keyless, but proxied so the
 *    browser only talks to our own origin.
 * 4. Proxies OSRM (FOSSGIS) driving routes + the Overpass posted-speed-
 *    limit lookup — the app is OSM end to end; HERE is gone.
 * 5. Fans out routing "witness" queries to TomTom and Stadia Maps for
 *    the client's ETA consensus — their API keys live here, server-side.
 *
 * Run: npm start   (then open http://localhost:3000)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- traffic proxy ---------------- */

const TRAFFIC_UPSTREAM =
  'https://511on.ca/api/v2/get/event?format=json&lang=en';
const TRAFFIC_TTL_MS = 60 * 1000; // respect the 10 req / 60 s throttle

let trafficCache = { at: 0, payload: null };

function fetchUpstream(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Upstream HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

/** Normalize an Ontario 511 event into Schmaps' internal shape. */
function normalizeEvent(ev) {
  return {
    id: ev.ID,
    lat: ev.Latitude,
    lon: ev.Longitude,
    roadway: ev.RoadwayName || '',
    description: ev.Description || '',
    severity: (ev.Severity || 'Unknown').toLowerCase(),
    closure: Boolean(ev.IsFullClosure),
    eventType: ev.EventType || '',
    updated: ev.LastUpdated || null,
    // Schedule window (epoch seconds). Ontario 511 lists future and
    // overnight-only work well in advance; the client counts an event
    // toward the ETA only while its window is actually active.
    start: ev.StartDate || null,
    end: ev.PlannedEndDate || null,
  };
}

async function getTrafficEvents() {
  const now = Date.now();
  if (trafficCache.payload && now - trafficCache.at < TRAFFIC_TTL_MS) {
    return trafficCache.payload;
  }
  const raw = await fetchUpstream(TRAFFIC_UPSTREAM);
  const parsed = JSON.parse(raw);
  const events = (Array.isArray(parsed) ? parsed : [])
    .map(normalizeEvent)
    .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));

  const payload = JSON.stringify({
    source: 'Ontario 511 (Government of Ontario, Open Government Licence)',
    fetchedAt: new Date(now).toISOString(),
    count: events.length,
    events,
  });
  trafficCache = { at: now, payload };
  return payload;
}

/* ---------------- routing witness proxy ---------------- */

// API keys are read from the environment — never shipped to the
// client. A missing key silently disables that witness; consensus
// degrades to whatever engines remain.
const TOMTOM_KEY = process.env.TOMTOM_KEY || '';
const STADIA_KEY = process.env.STADIA_KEY || '';
// OSRM @ FOSSGIS — OpenStreetMap driving routes, keyless. We proxy the
// route calls so the browser has one CORS story and a real User-Agent
// identifies us to the OSM infrastructure.
const OSRM_BASE = process.env.OSRM_BASE || 'https://routing.openstreetmap.de/routed-car';
const OSRM_PROFILE = process.env.OSRM_PROFILE || 'driving';
// Overpass (OpenStreetMap) — posted speed limits near a handful of
// route points, for the speed-limit badge and the personal speed
// ratio. Mirrors are tried in order; when none answer, the client
// falls back to OSRM's per-edge implied speeds. Best-effort by design.
const OVERPASS_ENDPOINTS = (
  process.env.OVERPASS_ENDPOINTS ||
  'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.cesnet.cz/api/interpreter'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// OpenFreeMap vector styles (OpenStreetMap data) — one per theme
// (spec §10.6), keyless and unlimited. The browser fetches
// tiles/sources/glyphs/sprite URLs directly (CORS-friendly); only the
// style JSON is proxied, cached 24h per theme, and rotated on restart.
// Override with OSM_STYLE_URL_LIGHT / OSM_STYLE_URL_DARK to test
// alternate styles (e.g. tiles.openfreemap.org/styles/bright).
const OSM_STYLE_URL_LIGHT =
  process.env.OSM_STYLE_URL_LIGHT ||
  'https://tiles.openfreemap.org/styles/liberty';
const OSM_STYLE_URL_DARK =
  process.env.OSM_STYLE_URL_DARK ||
  'https://tiles.openfreemap.org/styles/dark';
const OSM_STYLE_URL_BY_THEME = {
  light: OSM_STYLE_URL_LIGHT,
  dark: OSM_STYLE_URL_DARK,
};
// osmStyleCache is keyed by theme (light|dark) — independent 24h TTLs.
const osmStyleCache = {
  light: { at: 0, payload: null },
  dark: { at: 0, payload: null },
};
const OSM_STYLE_TTL_MS = 24 * 60 * 60 * 1000;

// Nominatim (OpenStreetMap) — forward + reverse geocoding. The public
// instance requires a User-Agent that identifies the application and
// permits a maximum of 1 request/second; nominatimFetch() below
// serializes every call through one gap-enforcing chain so any number
// of browser tabs still honors the policy.
const OSM_USER_AGENT =
  process.env.OSM_USER_AGENT || 'Schmaps/1.0 (Schmaps PWA; contact via OSM_USER_AGENT)';
// Photon (Komoot) — OSM-backed typeahead for the search box. Keyless
// with generous limits; we still send our User-Agent out of politeness.
const PHOTON_ENDPOINT = process.env.PHOTON_ENDPOINT || 'https://photon.komoot.io/api/';

// How long to wait for a witness engine before giving up on it.
const WITNESS_TIMEOUT_MS = 4000;

/**
 * GET a JSON URL with a timeout. Resolves null on any failure —
 * a witness that fails is simply absent from the consensus.
 */
function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Accept: 'application/json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve(null);
    });
  });
}

/** POST a JSON body, resolving the parsed response or null. */
function postJson(url, body, timeoutMs) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve(null);
    });
    req.end(payload);
  });
}

/** TomTom Routing API v1 — live-traffic travel time for origin → destination. */
async function witnessTomTom(origin, destination) {
  if (!TOMTOM_KEY) return { source: 'tomtom', error: 'no API key' };
  const locs = `${origin.lat},${origin.lon}:${destination.lat},${destination.lon}`;
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${locs}/json` +
    `?key=${encodeURIComponent(TOMTOM_KEY)}&traffic=true&routeType=fastest&travelMode=car`;
  const data = await fetchJson(url, WITNESS_TIMEOUT_MS);
  const route = data?.routes?.[0];
  const seconds = route?.summary?.travelTimeInSeconds;
  if (!Number.isFinite(seconds)) return { source: 'tomtom', error: 'no route' };
  return {
    source: 'tomtom',
    durationSeconds: seconds,
    distanceMeters: route.summary.lengthInMeters ?? null,
  };
}

/** Stadia Maps (Valhalla) — auto_traffic profile, live + historic traffic. */
async function witnessStadia(origin, destination) {
  if (!STADIA_KEY) return { source: 'stadia', error: 'no API key' };
  const url = `https://api.stadiamaps.com/route/v1?api_key=${encodeURIComponent(STADIA_KEY)}`;
  const body = {
    locations: [
      { lat: origin.lat, lon: origin.lon, type: 'break' },
      { lat: destination.lat, lon: destination.lon, type: 'break' },
    ],
    costing: 'auto_traffic',
    units: 'kilometers',
  };
  const data = await postJson(url, body, WITNESS_TIMEOUT_MS);
  const summary = data?.trip?.summary;
  const seconds = summary?.time;
  if (!Number.isFinite(seconds)) return { source: 'stadia', error: 'no route' };
  return {
    source: 'stadia',
    durationSeconds: Math.round(seconds),
    distanceMeters: summary.length ? Math.round(summary.length * 1000) : null,
  };
}

/**
 * Run an Overpass QL query against the mirror list — first mirror that
 * answers wins. POSTs form-encoded `data=` with our User-Agent (the
 * main mirror 406s anonymous clients). Resolves parsed JSON or null;
 * never throws.
 */
function overpassQuery(ql, timeoutMs = 12000) {
  const payload = `data=${encodeURIComponent(ql)}`;
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= OVERPASS_ENDPOINTS.length) {
        resolve(null);
        return;
      }
      const target = new URL(OVERPASS_ENDPOINTS[i]);
      const req = https.request(
        {
          hostname: target.hostname,
          path: target.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': OSM_USER_AGENT,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            tryNext(i + 1);
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => tryNext(i + 1));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
        tryNext(i + 1);
      });
      req.end(payload);
    };
    tryNext(0);
  });
}

/* ---------------- OSM fetch helpers ---------------- */

/**
 * GET a JSON URL with a User-Agent that identifies Schmaps. Nominatim
 * rejects requests without one; the other OSM services just appreciate
 * it. Resolves the parsed body on HTTP 200, null on anything else —
 * never throws.
 */
function osmFetchJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': OSM_USER_AGENT } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve(null);
    });
  });
}

/**
 * Serialize Nominatim calls with >=1.1 s between upstream hits so we
 * stay inside their 1 req/s usage policy no matter how many browser
 * tabs are asking. Every geocode + reverse-geocode funnels through
 * this one promise chain; a failed call still counts toward the gap
 * (the policy is about request *rate*, not success).
 */
const NOMINATIM_MIN_GAP_MS = 1100;
let nominatimChain = Promise.resolve();
let nominatimLastAt = 0;
function nominatimFetchJson(url, timeoutMs = 6000) {
  const run = async () => {
    const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - nominatimLastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nominatimLastAt = Date.now();
    return osmFetchJson(url, timeoutMs);
  };
  nominatimChain = nominatimChain.then(run, run);
  return nominatimChain;
}

/* ---------------- OSM vector style proxy ---------------- */

/**
 * Fetch and cache the OpenFreeMap style for a given theme
 * ('light' | 'dark'). Spec §10.6 — server holds the styles per-theme
 * with independent 24h TTLs. Unlike the old HERE styles these are
 * keyless, so nothing is injected: the JSON passes through as-is and
 * the browser fetches tiles, glyphs, and sprites straight from
 * tiles.openfreemap.org.
 */
async function getOsmStyle(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  const cache = osmStyleCache[t];
  const now = Date.now();
  if (cache.payload && now - cache.at < OSM_STYLE_TTL_MS) {
    return cache.payload;
  }
  const data = await osmFetchJson(OSM_STYLE_URL_BY_THEME[t], 8000);
  if (!data || !Array.isArray(data.layers)) return { error: 'style fetch failed' };
  osmStyleCache[t] = { at: now, payload: data };
  return data;
}

/* ---------------- OSM handlers ---------------- */

/**
 * Map a Nominatim result onto the 0..1 confidence the client chain
 * expects. Nominatim's `importance` measures Wikipedia fame, not
 * query-match quality — a perfect street-address hit scores ~0.35 —
 * so we grade by result precision instead, and the client's 0.5
 * threshold keeps meaning "the geocoder actually matched something".
 */
function osmConfidence(it) {
  const a = it?.address || {};
  if (a.house_number && a.road) return 0.9; // street-address-grade hit
  if (a.road) return 0.85;                  // street-level hit
  if (it?.name) return 0.8;                 // a named place / POI
  if (a.city || a.town || a.village || a.municipality || a.county) return 0.75; // locality
  return 0.6;                               // something Nominatim matched
}

/**
 * Build a short, Canadian-friendly label from a Nominatim result.
 * Nominatim's `display_name` is the full verbose line ("…, Canada"),
 * so we rebuild from `addressdetails` the way the HERE label did.
 */
function osmLabel(item) {
  const a = item?.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city =
    a.city || a.town || a.village || a.hamlet ||
    a.municipality || a.county || a.state_district || '';
  const parts = [];
  if (item?.name && item.name !== street) parts.push(item.name);
  if (street) parts.push(street);
  if (city) parts.push(city);
  if (a.state) parts.push(a.state);
  return parts.join(', ') || item?.display_name || '';
}

/**
 * POST /api/osm/geocode — text → coordinate (Nominatim).
 * Body: { q: "123 Main St, Ottawa", limit?: 1 }
 * Response: { items: [{ lat, lon, label, score }] | { error } }
 *
 * `score` is the 0..1 confidence the client chain expects (see
 * osmConfidence) — not Nominatim's `importance`, which measures
 * Wikipedia fame rather than query-match quality.
 */
async function handleOsmGeocode(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const q = (body?.q || '').trim();
  const limit = Math.min(5, Math.max(1, body?.limit ?? 1));
  if (!q) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'q required' }));
    return;
  }
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: String(limit),
    countrycodes: 'ca',
    addressdetails: '1',
    'accept-language': 'en',
  });
  const data = await nominatimFetchJson(
    `https://nominatim.openstreetmap.org/search?${params}`
  );
  const items = (Array.isArray(data) ? data : [])
    .map((it) => ({
      lat: Number(it.lat),
      lon: Number(it.lon),
      label: osmLabel(it) || q,
      score: osmConfidence(it),
    }))
    .filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lon));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ items }));
}

/**
 * GET /api/osm/autosuggest?q=...&lat=...&lon=...&limit=... — typeahead
 * (Photon, OpenStreetMap data). Biases to "near" when lat/lon present;
 * results stay inside Canada's bounding box (Photon's bbox param).
 * Response: { items: [{ lat, lon, title, secondary, label, id, type }] }
 */
async function handleOsmAutosuggest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'q required' }));
    return;
  }
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 8));
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const params = new URLSearchParams({ q, limit: String(limit), lang: 'en' });
  // Photon's bbox restricts results; lat/lon biases ranking within it.
  params.set('bbox', '-142.0,40.0,-51.0,62.0');
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
  }
  const data = await osmFetchJson(`${PHOTON_ENDPOINT}?${params}`);
  const features = Array.isArray(data?.features) ? data.features : [];
  const items = features
    .map((f) => {
      const p = f?.properties || {};
      const flon = Number(f?.geometry?.coordinates?.[0]);
      const flat = Number(f?.geometry?.coordinates?.[1]);
      if (!Number.isFinite(flat) || !Number.isFinite(flon)) return null;
      const name = String(p.name || '').trim();
      const addr = [p.housenumber, p.street].filter(Boolean).join(' ').trim();
      const locality = [p.city || p.town || p.village || p.county, p.state]
        .filter(Boolean)
        .join(', ');
      const title = name || addr || locality;
      const secondary = [name ? addr : '', locality].filter(Boolean).join(', ');
      return {
        lat: flat,
        lon: flon,
        title,
        secondary,
        label: [title, secondary].filter(Boolean).join(', '),
        id: `osm:${p.osm_type || 'n'}/${p.osm_id || ''}`,
        type: p.osm_value || p.type || '',
      };
    })
    .filter(Boolean);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ items }));
}

/**
 * POST /api/osm/reverse — coordinate → address label (Nominatim).
 * Body: { lat, lon }
 * Response: { label } — label is null when Nominatim has nothing there;
 * the client falls back to honest coordinates ("Dropped pin").
 */
async function handleOsmReverse(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const lat = body?.lat;
  const lon = body?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'lat, lon required' }));
    return;
  }
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lon),
    zoom: '18', // building/street-level detail
    addressdetails: '1',
    'accept-language': 'en',
  });
  const data = await nominatimFetchJson(
    `https://nominatim.openstreetmap.org/reverse?${params}`
  );
  const label = data && !data.error ? osmLabel(data) || null : null;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ label }));
}

/* ---------------- OSRM routing handlers ---------------- */

/**
 * POST /api/osm/route — driving route(s) with per-edge annotations.
 * Body: { origin:{lat,lon}, destination:{lat,lon}, alternatives?: number }
 * Returns the raw OSRM response (overview=full GeoJSON geometry, steps,
 * duration+distance annotations, up to N alternatives); the client
 * adapter in public/js/osrm.js + routing.js flattens it into the
 * Schmaps RouteResult shape.
 */
async function handleOsmRoute(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const o = body?.origin;
  const d = body?.destination;
  const alts = Math.min(3, Math.max(0, body?.alternatives ?? 0));
  if (!Number.isFinite(o?.lat) || !Number.isFinite(o?.lon) ||
      !Number.isFinite(d?.lat) || !Number.isFinite(d?.lon)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin/destination lat,lon required' }));
    return;
  }
  // OSRM takes {lon},{lat} pairs in the path, semicolon-separated.
  // annotations=duration,distance feeds the local per-km ETA engine
  // (public/js/eta.js); nodes adds the OSM node IDs per vertex — the
  // road-segment identity the driver profile learns by (see
  // public/js/driver-profile.js). The FOSSGIS instance does NOT load
  // the maxspeed plugin — annotations=maxspeed returns InvalidQuery —
  // so posted limits come from Overpass instead (handleOsmLimits below).
  const url =
    `${OSRM_BASE}/route/v1/${OSRM_PROFILE}/${o.lon},${o.lat};${d.lon},${d.lat}` +
    `?overview=full&geometries=geojson&steps=true` +
    `&alternatives=${alts}&annotations=duration,distance,nodes`;
  const data = await osmFetchJson(url, 10000);
  if (!data) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OSRM routing failed' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/**
 * GET /api/osm/route/v1/... and /api/osm/trip/v1/... — transparent
 * pass-throughs to OSRM for the errands planner, which builds its
 * multi-waypoint route + trip URLs exactly like the pre-HERE days
 * (errands.js planErrands / routing-errands refreshErrands).
 */
async function handleOsmRoutingPassthrough(req, res, pathname) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const target = `${OSRM_BASE}${pathname.replace('/api/osm', '')}${u.search}`;
  const data = await osmFetchJson(target, 10000);
  if (!data) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OSRM request failed' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

/** "50" → 50, "35 mph" → 56.3, "none"/"variable"/odd shapes → null. */
function parseMaxspeedKmh(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.match(/^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return m[2] ? Math.round(v * 1.609344) : Math.round(v);
}

/**
 * POST /api/osm/poi — category search (Overpass): every OSM object
 * matching the tag selectors near a point, with its opening hours.
 * Body: { selectors: [[k,v],...], lat, lon, radiusM?, limit? }
 * Response: { places: [{ lat, lon, name, kind, openingHours, phone,
 *   website, address }] } — the client classifies open/closed locally
 * (public/js/hours.js) so no server clock drift can miscolour a pin.
 */
async function handleOsmPoi(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const selectors = Array.isArray(body?.selectors)
    ? body.selectors
        .filter((sel) => Array.isArray(sel) && typeof sel[0] === 'string' && typeof sel[1] === 'string')
        .slice(0, 6)
    : [];
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  if (selectors.length === 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'selectors and lat,lon required' }));
    return;
  }
  const radiusM = Math.min(50000, Math.max(500, Number(body?.radiusM) || 15000));
  const limit = Math.min(60, Math.max(5, Number(body?.limit) || 16));

  // One union query over every selector; `out center` gives ways and
  // relations a representative point. Unnamed objects are dropped —
  // a nameless shop is noise, not a destination.
  const arms = selectors
    .map(([k, v]) => `nwr(around:${radiusM},${lat},${lon})[${JSON.stringify(k)}=${JSON.stringify(v)}]`)
    .join(';');
  const ql = `[out:json][timeout:15];(${arms};);out tags center ${limit * 2};`;
  const data = await overpassQuery(ql, 15000);
  if (!data) {
    // Distinguish "Overpass unreachable" from "no matches here" so the
    // client can try browser-direct Overpass (the phone's own network)
    // before degrading to the hours-less Nominatim fallback.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ places: [], overpass: 'unreachable' }));
    return;
  }

  const places = [];
  const seen = new Set();
  if (data && Array.isArray(data.elements)) {
    for (const el of data.elements) {
      const tags = el?.tags || {};
      const name = String(tags.name || '').trim();
      if (!name) continue;
      const plat = Number.isFinite(el?.lat) ? el.lat : Number(el?.center?.lat);
      const plon = Number.isFinite(el?.lon) ? el.lon : Number(el?.center?.lon);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      const key = `${plat.toFixed(4)},${plon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const selector = selectors.find(([k, v]) => tags[k] === v);
      places.push({
        lat: plat,
        lon: plon,
        name,
        kind: selector ? `${selector[0]}=${selector[1]}` : '',
        openingHours: typeof tags.opening_hours === 'string' ? tags.opening_hours : null,
        phone: typeof tags.phone === 'string' ? tags.phone : (tags['contact:phone'] ?? null),
        website: typeof tags.website === 'string' ? tags.website : null,
        address: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null,
      });
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ places: places.slice(0, limit * 2) }));
}

/**
 * POST /api/osm/limits — posted speed limits near a handful of points.
 * Body: { points: [[lat, lon], ...] } (max 12) — the client sends the
 * midpoints of the next few km buckets as it drives.
 * Response: { points: [{ lat, lon, limitKmh }] } — limitKmh is null
 * when no maxspeed-tagged way sits near that point (the client then
 * keeps using OSRM's implied speed for that km).
 */
async function handleOsmLimits(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const raw = Array.isArray(body?.points) ? body.points : [];
  const points = raw
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, 12)
    .map((p) => [Number(p[0]), Number(p[1])]);
  if (points.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'points required' }));
    return;
  }
  // One corridor query over every point: ways tagged maxspeed within
  // 40 m of any of them, with geometry so each way can be mapped back
  // to the request point it passes nearest.
  const around = points.map((p) => `${p[0]},${p[1]}`).join(',');
  const ql = `[out:json][timeout:12];way(around:40,${around})[maxspeed];out geom 200;`;
  const data = await overpassQuery(ql);
  if (!data) {
    // Distinguish "Overpass unreachable" from "no tagged ways here" so
    // the client can try browser-direct Overpass on the phone's own
    // network before falling back to router-implied speeds.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        points: points.map(([lat, lon]) => ({ lat, lon, limitKmh: null })),
        overpass: 'unreachable',
      })
    );
    return;
  }

  const out = points.map(([lat, lon]) => ({ lat, lon, limitKmh: null }));
  if (data && Array.isArray(data.elements)) {
    for (const el of data.elements) {
      const kmh = parseMaxspeedKmh(el?.tags?.maxspeed);
      if (kmh === null) continue;
      const geom = Array.isArray(el.geometry) ? el.geometry : [];
      for (const g of geom) {
        if (!Number.isFinite(g?.lat) || !Number.isFinite(g?.lon)) continue;
        let bestIdx = -1;
        let bestDeg = Infinity;
        for (let i = 0; i < points.length; i++) {
          // Cheap degree-space distance is plenty at a 40 m scale.
          const deg = Math.abs(g.lat - points[i][0]) + Math.abs(g.lon - points[i][1]);
          if (deg < bestDeg) {
            bestDeg = deg;
            bestIdx = i;
          }
        }
        if (bestIdx < 0 || bestDeg > 0.01) continue;
        const cur = out[bestIdx].limitKmh;
        if (cur === null || kmh < cur) out[bestIdx].limitKmh = kmh;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ points: out }));
}

/** GET /api/osm/style — the OpenFreeMap MapLibre style JSON, keyless. */
/**
 * GET /api/osm/style?theme=light|dark
 * Spec §10.6 — `theme` defaults to `light` for callers that don't pass one.
 */
async function handleOsmStyle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const themeRaw = (url.searchParams.get('theme') || 'light').toLowerCase();
  const theme = themeRaw === 'dark' ? 'dark' : 'light';
  const data = await getOsmStyle(theme);
  if (data.error) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${Math.floor(OSM_STYLE_TTL_MS / 1000)}`,
  });
  res.end(JSON.stringify(data));
}

/**
 * POST /api/routing/witness — independent travel-time estimates for the
 * client's ETA consensus. Body: { origin:{lat,lon}, destination:{lat,lon} }.
 * Response: { witnesses: [{source, durationSeconds, distanceMeters} | {source, error}] }.
 * Engines run in parallel; each failure is reported, never fatal.
 */
async function handleWitnessRequest(req, res) {
  const body = await readJsonBody(req).catch(() => null);
  const origin = body?.origin;
  const destination = body?.destination;
  const valid = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  if (!valid(origin) || !valid(destination)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin and destination (lat, lon) required' }));
    return;
  }

  const witnesses = await Promise.all([
    witnessTomTom(origin, destination),
    witnessStadia(origin, destination),
  ]);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ witnesses }));
}

/** Read and parse a JSON request body, size- and time-limited. */
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------------- static files ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(
    PUBLIC_DIR,
    pathname === '/' ? 'index.html' : pathname
  );

  // Prevent path traversal.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback for unknown paths under the app root.
      if (!path.extname(pathname)) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
      } else {
        res.writeHead(404).end('Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    // App shell files must always revalidate: the service worker does the
    // real caching, and a stale browser HTTP cache could otherwise feed an
    // old app.js into a fresh SW precache (mixed-shell null crashes).
    // Vendored libs and icons are safe to cache hard.
    const isShell =
      pathname === '/' ||
      pathname.startsWith('/js/') ||
      pathname.startsWith('/css/') ||
      path.basename(filePath) === 'sw.js' ||
      path.basename(filePath) === 'manifest.webmanifest';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isShell ? 'no-cache' : 'public, max-age=3600',
    };
    if (path.basename(filePath) === 'sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      // no-store (not no-cache): we don't want any intermediary — the
      // browser's HTTP cache, Cloudflare, the CDN edge — to ever serve
      // a stale sw.js, because the browser compares byte-for-byte to
      // decide whether to install a new worker. A 304 with a stale
      // body would silently keep an old worker in control.
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/traffic/events') {
    try {
      const payload = await getTrafficEvents();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=55',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(payload);
    } catch (err) {
      // Serve stale cache if we have it; otherwise a clean error.
      if (trafficCache.payload) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Schmaps-Stale': '1',
        });
        res.end(trafficCache.payload);
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
    }
    return;
  }

  if (pathname === '/api/routing/witness') {
    if (req.method === 'POST') {
      await handleWitnessRequest(req, res);
    } else {
      res.writeHead(405, { Allow: 'POST' }).end('Method not allowed');
    }
    return;
  }

  // Spec §8: every provider call goes through the server — the OSM
  // stack is keyless but proxied, so the browser has one CORS story and
  // a real User-Agent identifies us to the OSM infrastructure (and
  // Nominatim's 1 req/s policy is honored in one place).
  if (pathname === '/api/osm/geocode' && req.method === 'POST') {
    await handleOsmGeocode(req, res);
    return;
  }
  if (pathname === '/api/osm/reverse' && req.method === 'POST') {
    await handleOsmReverse(req, res);
    return;
  }
  if (pathname === '/api/osm/autosuggest' && req.method === 'GET') {
    await handleOsmAutosuggest(req, res);
    return;
  }
  if (pathname === '/api/osm/style' && req.method === 'GET') {
    await handleOsmStyle(req, res);
    return;
  }
  if (pathname === '/api/osm/route' && req.method === 'POST') {
    await handleOsmRoute(req, res);
    return;
  }
  if (pathname === '/api/osm/limits' && req.method === 'POST') {
    await handleOsmLimits(req, res);
    return;
  }
  if (pathname === '/api/osm/poi' && req.method === 'POST') {
    await handleOsmPoi(req, res);
    return;
  }
  // Errands planner passthroughs — OSRM trip + multi-waypoint route
  // URLs are built client-side, exactly like the pre-HERE days.
  if (
    (pathname.startsWith('/api/osm/route/v1/') || pathname.startsWith('/api/osm/trip/v1/')) &&
    req.method === 'GET'
  ) {
    await handleOsmRoutingPassthrough(req, res, pathname);
    return;
  }
  if (pathname.startsWith('/api/osm/')) {
    res.writeHead(405, { Allow: 'GET, POST' }).end('Method not allowed');
    return;
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'schmaps', country: 'CA' }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`🍁 Schmaps listening on http://localhost:${PORT}`);
  console.log(
    `   OSM:        style (OpenFreeMap) · geocode+reverse (Nominatim) · autosuggest (Photon) via /api/osm/*`
  );
  console.log(
    `   Routing:    OSRM @ FOSSGIS via /api/osm/* · posted limits via Overpass (best-effort)`
  );
  console.log('   Traffic:    Ontario 511 via /api/traffic/events');
  console.log(
    `   Consensus:   TomTom ${TOMTOM_KEY ? '✓' : '—'} · Stadia Maps ${STADIA_KEY ? '✓' : '—'} via /api/routing/witness`
  );
});