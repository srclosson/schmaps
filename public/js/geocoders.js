/**
 * Schmaps geocoder fallback chain — OpenStreetMap services (spec §8).
 *
 * The chain runs entirely against `/api/osm/*` proxy routes (keyless
 * upstreams, but proxied so Nominatim gets a real User-Agent and its
 * 1 req/s policy is honored server-side). Each tier is a different
 * OSM product:
 *
 *   1. Nominatim (OpenStreetMap)   — `geocode(query)` from osm.js
 *      Returns a single best-result hit for an address-shaped query;
 *      its 0..1 `importance` drives the 0.5 confidence cutoff the
 *      chain has always used.
 *
 *   2. Photon (Komoot, OSM data)   — `autosuggest(query)` from osm.js
 *      The typeahead-grade fallback for partial / fuzzy addresses.
 *      Bounded to one row for the chain.
 *
 * The search box's live typeahead (`runAutocomplete` in app.js) calls
 * `autosuggest()` directly with the user's GPS for "near" bias.
 *
 * Reverse geocoding for the long-press "Navigate here" pin is
 * `reverse(lat, lon)` — also Nominatim, with the honest-coordinates
 * fallback when it returns nothing useful for that spot.
 */

import { PHOTON } from './config.js';
import { geocode, autosuggest, reverse as osmReverse } from './osm.js';

/* ---------------- address-shape detection ---------------- */

const HOUSE_NUMBER_RE = /^\s*\d+\s/;
const STREET_TYPE_RE =
  /\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|crescent|court|ct|lane|ln|way|terrace|highway|hwy|route|line|concession|parkway|circle|pl|place|square|row|path|trail)\b/i;
const POSTAL_CODE_RE = /\b[abceghj-nprstvxy]\d[a-z][ -]?\d[a-z]\d\b/i;

/**
 * Address-shaped queries get the full fallback chain. Everything else
 * keeps the suggestion flow (business names → POI chips, towns → the
 * fuzzy gazetteer).
 */
export function isAddressQuery(text) {
  return HOUSE_NUMBER_RE.test(text) || STREET_TYPE_RE.test(text) || POSTAL_CODE_RE.test(text);
}

/* ---------------- individual geocoders ---------------- */

/**
 * Single-hit Nominatim geocoding — the chain's first tier.
 * Thin wrapper around `osm.geocode()` that throws when Nominatim
 * returns no match, so the chain's `try/catch` blocks keep their shape.
 */
async function geocodeOsmOne(query) {
  const r = await geocode(query);
  if (!r) throw new Error('Nominatim found no match.');
  return r;
}

/**
 * Photon autosuggest in single-result mode — the chain's last resort.
 * Autosuggest is typeahead-grade, so partial / fuzzy input still
 * resolves when forward-geocoding wouldn't.
 */
async function geocodeAutosuggestOne(query) {
  const rows = await autosuggest(query, null, { limit: 1 });
  if (rows.length === 0) throw new Error('Photon autosuggest found no match.');
  const r = rows[0];
  return { ...r, confidence: 0.75, source: 'photon' };
}

/* ---------------- the chain ---------------- */

/**
 * Resolve an address through the fallback chain. Each service gets its
 * turn only if the previous one found nothing usable.
 */
export async function geocodeChain(query) {
  let lastError = null;

  try {
    const dest = await geocodeOsmOne(query);
    if (dest.confidence >= 0.5) return dest;
    lastError = new Error('Nominatim was not confident about that address.');
  } catch (err) {
    lastError = err;
  }

  try {
    return await geocodeAutosuggestOne(query);
  } catch (err) {
    lastError = err;
  }

  throw lastError || new Error('No geocoder could find that address.');
}

/* ---------------- reverse geocoding ---------------- */

/**
 * A tapped map point needs a readable label. Nominatim reverse
 * geocoding first; honest coordinates ("Dropped pin (lat, lon)") are
 * the last resort — the user picked the spot, so the pin is right
 * even when the name isn't.
 */
export async function reverseGeocode(lat, lon) {
  try {
    const r = await osmReverse(lat, lon);
    if (r && r.label) return r;
  } catch {
    /* next */
  }

  return {
    lat,
    lon,
    label: `Dropped pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
    confidence: 1,
    source: 'pin',
  };
}

/* ---------------- exports the search box needs ---------------- */

/**
 * Typeahead-grade geocoder for the search box's live autocomplete.
 * `near` biases results to the user's current area server-side, so
 * "places nearby" is the ranking before any client-side work.
 *
 * The dropdown wants `{ lat, lon, primary, secondary }` rows — that's
 * the shape `autosuggest()` already returns, so this is a one-liner
 * over the adapter.
 *
 * @param {string} query
 * @param {{limit?:number, near?:{lat:number, lon:number}|null}} [opts]
 * @returns {Promise<Array<{lat:number, lon:number, label:string, primary:string, secondary:string}>>}
 */
export async function geocodePhoton(query, { limit = PHOTON.limit, near } = {}) {
  // `geocodePhoton` is the name callers have always used; the adapter
  // behind it is Photon again now, so the mapping is direct.
  return autosuggest(query, near ?? null, { limit });
}