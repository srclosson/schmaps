/**
 * Schmaps errands mode — "I've got errands: ikea, burger king around
 * lunch, and the thrift store."
 *
 * The keyword isn't required: naming tasks ("buy gas", "groceries") or
 * sequencing stops ("ikea then burger king") triggers it too. Tasks map
 * to nearby place types (gas → gas station, groceries → supermarket).
 * Address-shaped queries ("5 Bank Street, Ottawa") never trigger it.
 *
 * Parses the request into stops, resolves each stop (saved places →
 * Nominatim POI search → geocoder.ca → fuzzy gazetteer), and asks OSRM's
 * trip service for the most efficient visiting order. The ordering is a
 * travelling-salesman solve done by the routing engine — no AI service
 * required.
 */

import { ROUTER } from './config.js';
import { searchPOI } from './poi.js';
import { geocodeAddress } from './geocode.js';
import { suggestPlaces } from './places.js';
import { findSavedPlace } from './places-store.js';
import { extractManeuvers, trafficAdjust } from './routing.js';

/* ---------------- parsing ---------------- */

const ERRANDS_RE = /\berrands?\b/i;
const ERRANDS_WORD_RE = /\berrands?\b/gi;

// Tasks name what you need, not where it is — map them to place types
// the POI search understands. Identity entries ("bank" → "bank") let a
// word trigger errands mode without changing the fragment.
const TASK_WORDS = {
  'oil change': 'car repair',
  'dry cleaning': 'dry cleaner',
  'hair cut': 'hair salon',
  haircut: 'hair salon',
  'grocery store': 'supermarket',
  groceries: 'supermarket',
  grocery: 'supermarket',
  'coffee shop': 'cafe',
  gas: 'gas station',
  fuel: 'gas station',
  coffee: 'cafe',
  breakfast: 'restaurant',
  lunch: 'restaurant',
  dinner: 'restaurant',
  prescription: 'pharmacy',
  drugstore: 'pharmacy',
  pharmacy: 'pharmacy',
  meds: 'pharmacy',
  deposit: 'bank',
  withdraw: 'bank',
  banking: 'bank',
  bank: 'bank',
  atm: 'bank',
  beer: 'beer store',
  liquor: 'liquor store',
};

// Longest phrases first, so "grocery store" maps before "grocery".
const TASK_ENTRIES = Object.entries(TASK_WORDS).sort((a, b) => b[0].length - a[0].length);

const TASK_RES = TASK_ENTRIES.map(([task, place]) => ({
  task: new RegExp(`\\b${task.replace(/\s+/g, '\\s+')}\\b`, 'gi'),
  place: new RegExp(`\\b${place.replace(/\s+/g, '\\s+')}\\b`, 'i'),
  replacement: place,
}));

const TASK_TRIGGER_RE = new RegExp(
  `\\b(?:${TASK_ENTRIES.map(([k]) => k.replace(/\s+/g, '\\s+')).join('|')})\\b`,
  'i'
);

// Sequencing words ("ikea then burger king"). Bare "and" doesn't count —
// "ikea and burger king" with no other hint stays a plain search.
const SEQUENCE_RE = /\b(?:then|after\s+that|also|next|plus|finally|lastly)\b/i;

// Address-shaped queries never trigger errands mode, even when they
// contain a task word ("5 Bank Street, Ottawa").
const HOUSE_NUMBER_RE = /^\s*\d+\s/;
const STREET_TYPE_RE =
  /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|crescent|lane|ln|court|ct|way|terrace|highway|hwy|route|line|concession|parkway|circle|pl)\b/i;
const POSTAL_CODE_RE = /\b[abceghj-nprstvxy]\d[a-z][ -]?\d[a-z]\d\b/i;

function isAddressShaped(text) {
  return HOUSE_NUMBER_RE.test(text) || STREET_TYPE_RE.test(text) || POSTAL_CODE_RE.test(text);
}

/**
 * Does this query ask for errands mode? Yes when it says "errands",
 * names a task ("buy gas", "groceries"), or sequences stops
 * ("ikea then burger king") — unless it's address-shaped.
 */
export function isErrandsQuery(text) {
  if (ERRANDS_RE.test(text)) return true;
  if (isAddressShaped(text)) return false;
  if (TASK_TRIGGER_RE.test(text)) return true;
  return SEQUENCE_RE.test(text);
}

// Sequencing: "then", "after that", "also", "and", commas, semicolons.
const SPLIT_RE =
  /\s*(?:,|;|\bthen\b|\band then\b|\bafter that\b|\bnext\b|\balso\b|\bplus\b|\bfinally\b|\blastly\b|\band\b)\s*/gi;

// Filler stripped from the start of each fragment — including task
// verbs ("buy gas", "pick up some groceries", "take me to the bank").
const LEADER_RE =
  /^(?:\s*(?:(?:i\s+|also\s+)*(?:want|need|have)\s+to\s+(?:go\s+(?:to|buy|get|grab|pick\s+up|for)|stop\s+(?:at|by)|swing\s+by|visit)?|let'?s|take\s+me\s+to|go\s+(?:to|buy|get|grab|pick\s+up|for)|stop\s+(?:at|by|for)|swing\s+by|pick\s+up|buy|get|grab|first|then|next|also|finally|lastly|to|the|an|a|my|some)\b\s*)+/i;

// Time hints stripped from the end ("burger king around lunch").
const TRAILER_RE =
  /\s*(?:around|at|near|for)\s+(?:lunch(?:time)?|noon|morning|afternoon|evening|dinner|supper)\s*$/i;

const MAX_STOPS = 8;

// Filler words that may sit around a task phrase without turning it
// into a named-business search: "get gas", "do some banking". The
// leader/trailer strips above remove most of these already; this
// covers the stragglers.
const TASK_FILLER_RE =
  /^(?:i|we|let'?s|me|us|do|get|grab|buy|pick|up|some|any|go|to|the|a|an|my|our|for|at|near|first|then|next|also|finally|lastly|need|want|have)$/i;

/**
 * Map task words to the place types they mean: "buy gas" → "gas
 * station", "groceries" → "supermarket". Fragments that already name
 * the place type ("gas station") are left alone.
 *
 * The rewrite serves *needs*, not *names*: bare "oil change" (or
 * "get an oil change" after the leader strip) means "somewhere that
 * does oil changes" → the place type. But "take5 oil change" is a
 * business whose NAME contains the task phrase — rewriting it to
 * "take5 car repair" corrupts the brand search. So the task phrase is
 * only replaced when the rest of the fragment is filler words.
 */
function mapTaskWords(fragment) {
  let out = fragment;
  for (const { task, place, replacement } of TASK_RES) {
    if (place.test(out)) continue; // already explicit — don't double up
    const without = out.replace(task, ' ');
    if (without === out) continue; // task phrase not present
    const remainder = without.split(/\s+/).filter((w) => w && !TASK_FILLER_RE.test(w));
    if (remainder.length === 0) out = out.replace(task, replacement);
  }
  return out.trim();
}

/**
 * Split an errands request into place fragments.
 * "errands: ikea, burger king around lunch and the thrift store"
 *   → ["ikea", "burger king", "thrift store"]
 * "I need to go to home hardware, buy gas, and groceries."
 *   → ["home hardware", "gas station", "supermarket"]
 */
export function parseErrands(text) {
  const cleaned = text
    .replace(ERRANDS_WORD_RE, ' ')
    .replace(/\bmode\b/gi, ' ')
    .replace(
      /^\s*(?:i\s+(?:want|need|have)\s+to\s+(?:do|run)\s+some|let'?s\s+(?:do|run)\s+some)\s*/i,
      ' '
    )
    .replace(/[:—–]/g, ' , ')
    .trim();

  const fragments = cleaned
    .split(SPLIT_RE)
    .map((f) => f.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, ''))
    .map((f) => f.replace(LEADER_RE, '').replace(TRAILER_RE, '').trim())
    .map(mapTaskWords)
    .filter((f) => f.length > 1);

  // Dedupe (voice engines love repeating themselves), drop leftover
  // filler words, and cap.
  return [...new Set(fragments)]
    .filter((f) => !/^(?:errands?|mode)$/i.test(f))
    .slice(0, MAX_STOPS);
}

/* ---------------- stop resolution ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Resolve one errand fragment to a place. Saved places first ("errands:
 * Grandma's House, buy gas"), then POI search (errands are mostly
 * businesses), then the address geocoder, then the fuzzy gazetteer for
 * towns the voice engine mis-heard.
 */
async function resolveStop(fragment, origin) {
  // 0. Saved places — a named destination beats any search.
  const saved = findSavedPlace(fragment);
  if (saved) {
    return { lat: saved.lat, lon: saved.lon, label: saved.name };
  }

  // 1. POI search, biased near the user — closest result wins.
  try {
    const results = await searchPOI(fragment, { near: origin, limit: 5 });
    if (results.length > 0) {
      let best = results[0];
      let bestD = Infinity;
      for (const r of results) {
        const d = haversineKm(origin.lat, origin.lon, r.lat, r.lon);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      return best;
    }
  } catch {
    /* fall through to the next resolver */
  }

  // 2. Address geocoder (street addresses Nominatim knows well).
  try {
    const dest = await geocodeAddress(fragment);
    if (dest.confidence >= 0.5) return dest;
  } catch {
    /* fall through */
  }

  // 3. Fuzzy gazetteer (towns).
  const candidates = await suggestPlaces(fragment, { limit: 1 });
  if (candidates.length > 0) {
    const c = candidates[0];
    return { lat: c.lat, lon: c.lon, label: `${c.name}, ${c.province}` };
  }

  throw new Error(`Couldn't find “${fragment}”.`);
}

/**
 * Resolve every fragment, pacing the free geocoders (~1 req/s).
 * Unresolvable stops are skipped, not fatal.
 */
async function resolveErrandStops(fragments, origin, { onProgress } = {}) {
  const stops = [];
  const skipped = [];
  for (let i = 0; i < fragments.length; i++) {
    const frag = fragments[i];
    onProgress?.(frag, i, fragments.length);
    try {
      stops.push(await resolveStop(frag, origin));
    } catch {
      skipped.push(frag);
    }
    if (i < fragments.length - 1) await sleep(1100);
  }
  return { stops, skipped };
}

/* ---------------- trip planning ---------------- */

/**
 * Ask OSRM's trip service for the best visiting order. source=first pins
 * the origin; roundtrip=false leaves the path open (any stop may finish).
 */
async function planErrands(origin, stops) {
  const coords = [origin, ...stops].map((p) => `${p.lon},${p.lat}`).join(';');
  const url =
    `${ROUTER.endpoint}/trip/v1/${ROUTER.profile}/${coords}` +
    `?source=first&roundtrip=false&overview=full&geometries=geojson&steps=true`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Routing service responded with HTTP ${res.status}.`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.trips?.length) {
    throw new Error('Could not plan a route between those stops.');
  }

  const trip = data.trips[0];
  // waypoints[i] corresponds to input i; waypoint_index is its position
  // in the optimized trip. Map visiting order back to stop indices.
  const order = data.waypoints
    .map((w, i) => ({ input: i, position: w.waypoint_index }))
    .filter((w) => w.input > 0)
    .sort((a, b) => a.position - b.position)
    .map((w) => w.input - 1);

  return {
    order,
    legs: trip.legs.map((l) => ({
      durationSeconds: l.duration,
      distanceMeters: l.distance,
    })),
    geometry: trip.geometry.coordinates,
    freeFlowSeconds: trip.duration,
    distanceMeters: trip.distance,
    maneuvers: extractManeuvers(trip.legs),
  };
}

/* ---------------- geometry helpers ---------------- */

/**
 * Vertex index in `coords` nearest the given point — used to mark
 * where each errands stop is reached, so the UI can badge only the
 * leg currently being driven.
 */
function nearestVertexIndex(coords, { lat, lon }) {
  let best = Infinity;
  let bestIdx = 0;
  const stride = Math.max(1, Math.floor(coords.length / 400));
  for (let i = 0; i < coords.length; i += stride) {
    const d = haversineKm(coords[i][1], coords[i][0], lat, lon);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* ---------------- public API ---------------- */

/**
 * Full errands pipeline: parse → resolve → order → traffic-adjust.
 * Returns a route object shaped like computeRoute()'s, plus `stops`
 * (in visiting order, with per-leg times and arrival estimates),
 * `skipped` (fragments that couldn't be resolved), and `legBoundaries`
 * (geometry vertex index where each stop is reached — used to badge
 * only the leg currently being driven).
 */
export async function runErrands(origin, fragments, { onProgress } = {}) {
  const { stops: resolved, skipped } = await resolveErrandStops(fragments, origin, {
    onProgress,
  });
  if (resolved.length === 0) {
    throw new Error('None of those places could be found — try naming them more specifically.');
  }

  const plan = await planErrands(origin, resolved);
  const { trafficSeconds, congestionFactor, incidents, runs } = await trafficAdjust(
    plan.freeFlowSeconds,
    plan.geometry
  );

  // Per-stop arrival estimates. Legs are scaled by the overall factor
  // (congestion + incidents) so the stop times add up to the total ETA.
  const scale = plan.freeFlowSeconds > 0 ? trafficSeconds / plan.freeFlowSeconds : 1;
  const stops = [];
  let clock = Date.now();
  plan.order.forEach((idx, i) => {
    const legSeconds = Math.round(plan.legs[i].durationSeconds * scale);
    clock += legSeconds * 1000;
    stops.push({ ...resolved[idx], legSeconds, arriveAt: new Date(clock) });
  });

  // Where each stop is reached along the trip geometry (visiting order).
  const legBoundaries = stops.map((s) => nearestVertexIndex(plan.geometry, s));

  return {
    stops,
    skipped,
    geometry: plan.geometry,
    distanceMeters: plan.distanceMeters,
    freeFlowSeconds: plan.freeFlowSeconds,
    trafficSeconds,
    eta: new Date(Date.now() + trafficSeconds * 1000),
    congestionFactor,
    incidents,
    runs,
    legBoundaries,
    maneuvers: plan.maneuvers,
  };
}

/**
 * Re-time an errands run from a new position, keeping the planned
 * visiting order (no mid-drive re-optimization). Uses the route service
 * with waypoints instead of the trip service. Returns the same shape as
 * runErrands() — minus `skipped` — for the stops it was given.
 */
export async function refreshErrands(origin, stops) {
  if (stops.length === 0) throw new Error('No stops left to re-time.');

  const coords = [origin, ...stops].map((p) => `${p.lon},${p.lat}`).join(';');
  const url =
    `${ROUTER.endpoint}/route/v1/${ROUTER.profile}/${coords}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=true`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Routing service responded with HTTP ${res.status}.`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error('Could not re-time the route.');
  }

  const route = data.routes[0];
  const geometry = route.geometry.coordinates;
  const freeFlowSeconds = route.duration;
  const distanceMeters = route.distance;

  const { trafficSeconds, congestionFactor, incidents, runs } = await trafficAdjust(
    freeFlowSeconds,
    geometry
  );

  // Per-stop arrival estimates, legs scaled like runErrands() so the
  // stop times add up to the total ETA. legs[i] ends at stops[i].
  const scale = freeFlowSeconds > 0 ? trafficSeconds / freeFlowSeconds : 1;
  const out = [];
  let clock = Date.now();
  route.legs.forEach((leg, i) => {
    const legSeconds = Math.round(leg.duration * scale);
    clock += legSeconds * 1000;
    out.push({ ...stops[i], legSeconds, arriveAt: new Date(clock) });
  });

  // Where each stop is reached along the refreshed geometry.
  const legBoundaries = out.map((s) => nearestVertexIndex(geometry, s));

  return {
    stops: out,
    geometry,
    distanceMeters,
    freeFlowSeconds,
    trafficSeconds,
    eta: new Date(Date.now() + trafficSeconds * 1000),
    congestionFactor,
    incidents,
    runs,
    legBoundaries,
    maneuvers: extractManeuvers(route.legs),
  };
}