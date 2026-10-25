/**
 * Schmaps saved places & recent trips — localStorage-backed.
 *
 * Save any destination with a name and tags ("Grandma's House", family),
 * then just say "go to Grandma's House". Recent trips are recorded
 * automatically and feed the typeahead. Nothing leaves the device.
 */

import { normalizeName, editDistance } from './places.js';

const PLACES_KEY = 'schmaps-saved-places';
const TRIPS_KEY = 'schmaps-recent-trips';
const MAX_TRIPS = 20;

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or private mode — best-effort */
  }
}

/* ---------------- saved places ---------------- */

export function getSavedPlaces() {
  return read(PLACES_KEY, []);
}

/**
 * Save a place under a name ("Grandma's House") with tags ("family").
 * Re-saving the same name replaces the old entry.
 */
export function savePlace({ name, tags = [], lat, lon, label }) {
  const places = getSavedPlaces();
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    tags: tags.map((t) => normalizeName(t)).filter(Boolean),
    lat,
    lon,
    label,
    savedAt: Date.now(),
  };
  const withoutDupe = places.filter(
    (p) => normalizeName(p.name) !== normalizeName(entry.name)
  );
  write(PLACES_KEY, [entry, ...withoutDupe]);
  return entry;
}

export function deletePlace(id) {
  write(PLACES_KEY, getSavedPlaces().filter((p) => p.id !== id));
}

/** Strip "go to", "I need to go to", "let's drive to", punctuation, etc. */
export function stripTravelWords(query) {
  return query
    .replace(/[.!?]+$/, '')
    .replace(
      /^(?:please\s+)?(?:can\s+you\s+)?(?:let'?s\s+)?(?:i\s+(?:want|need|have)\s+to\s+)?(?:go|drive|navigate|head|take\s+me|bring\s+me)\s+(?:to|over\s+to|out\s+to|down\s+to|up\s+to)\s+/i,
      ''
    )
    .replace(/^the\s+/i, '')
    .trim();
}

/**
 * Find a saved place by name or tag — "go to emily's house" → the
 * place saved as "Grandma's House". Fuzzy enough for voice input.
 */
export function findSavedPlace(query) {
  const q = normalizeName(stripTravelWords(query));
  if (!q) return null;
  let best = null;
  let bestScore = Infinity;
  for (const p of getSavedPlaces()) {
    const name = normalizeName(p.name);
    let score = Infinity;
    if (name === q) {
      score = 0;
    } else {
      const tol = name.length <= 5 ? 1 : 2;
      const d = editDistance(q, name);
      if (d <= tol) score = d;
    }
    for (const t of p.tags) {
      if (normalizeName(t) === q) score = Math.min(score, 0.5);
    }
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore <= 2 ? best : null;
}

/** All saved places carrying a given tag ("family"). */
export function placesWithTag(tag) {
  const t = normalizeName(tag);
  if (!t) return [];
  return getSavedPlaces().filter((p) => p.tags.some((x) => normalizeName(x) === t));
}

/* ---------------- recent trips ---------------- */

export function getTrips() {
  return read(TRIPS_KEY, []).slice(0, MAX_TRIPS);
}

/** Record a trip; consecutive repeats just bump the timestamp. */
export function recordTrip({ label, lat, lon }) {
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const trips = getTrips();
  if (trips.length > 0 && normalizeName(trips[0].label) === normalizeName(label)) {
    trips[0] = { ...trips[0], lat, lon, at: Date.now() };
  } else {
    trips.unshift({ label, lat, lon, at: Date.now() });
  }
  write(TRIPS_KEY, trips.slice(0, MAX_TRIPS));
}
