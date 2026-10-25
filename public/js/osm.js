/**
 * Schmaps ↔ OpenStreetMap adapter.
 *
 * Everything goes through our own `/api/osm/*` proxy routes. The OSM
 * stack is keyless (OpenFreeMap vector tiles, Nominatim geocoding,
 * Photon typeahead), but the server still fronts every call so
 * Nominatim gets a real User-Agent, its 1 req/s usage policy is honored
 * in one place, and the browser only ever talks to our own origin —
 * the same spec §8 shape the HERE proxy had.
 *
 * The adapter normalizes the OSM services into Schmaps' internal
 * shapes — the same ones the HERE adapter produced before the map
 * stack moved back to OSM:
 *
 *   • Nominatim /search   → `geocode(query)`              (single hit)
 *   • Photon /api         → `autosuggest(query, near)`    (typeahead list)
 *   • Nominatim /reverse   → `reverse(lat, lon)`
 *
 * Routing runs on OSRM — public/js/osrm.js + /api/osm/route — so the
 * whole app, map and routing, is now fully OpenStreetMap.
 *
 * Server response shapes (see server.js):
 *   geocode    { items: [{ lat, lon, label, score }] }
 *   autosuggest{ items: [{ lat, lon, title, secondary, label, id, type }] }
 *   reverse    { label }   (label is null when Nominatim has nothing)
 */

import { GEOCODER, PHOTON, REVERSE_GEOCODE } from './config.js';

/* ============================================================
 *  Geocoding (Nominatim via /api/osm/geocode)
 * ============================================================ */

/**
 * Internal: POST JSON to a /api/osm/* proxy route (geocode, reverse).
 * JSON bodies keep the URL clean and align with the rest of the
 * routing-API surface (witness, traffic).
 */
async function postJson(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

/**
 * Forward-geocode a single best-result hit. Used by the
 * address fallback chain — `geocodeChain` calls it first.
 * Returns null when Nominatim has no match; throws on transport
 * errors so callers can fall through to the next provider.
 *
 * The server maps Nominatim's 0..1 `importance` onto `score`,
 * defaulting to 0.85 for results without one (most street addresses).
 *
 * @param {string} query
 * @returns {Promise<{lat:number, lon:number, label:string, confidence:number, source:string}|null>}
 */
export async function geocode(query) {
  const res = await postJson(GEOCODER.endpoint, { q: query, limit: 1 });
  if (!res.ok) throw new Error(`OSM geocode responded with HTTP ${res.status}.`);
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return null;
  const r = items[0];
  const lat = Number(r?.lat);
  const lon = Number(r?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = String(r?.label || query);
  const confidence = Number.isFinite(r?.score) ? r.score : 0.85;
  return { lat, lon, label, confidence, source: 'osm' };
}

/* ============================================================
 *  Autosuggest (Photon via /api/osm/autosuggest)
 * ============================================================ */

/**
 * Typeahead-grade address lookup (Photon, OpenStreetMap data).
 * Biased toward `near` when the user has a GPS fix ("places nearby"
 * wins server-side), else restricted to Canada's bounding box (the
 * proxy always sends the bbox, so results stay Canadian).
 *
 * Returns up to `limit` rows in the shape the dropdown has always
 * consumed (`primary` = title, `secondary` = address/locality line).
 * Missing → silently returns [].
 *
 * @param {string} query
 * @param {{lat:number, lon:number}|null} [near]
 * @param {number} [limit]
 * @returns {Promise<Array<{lat:number, lon:number, label:string, primary:string, secondary:string}>>}
 */
export async function autosuggest(query, near = null, { limit = PHOTON.limit } = {}) {
  if (!query || !query.trim()) return [];
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    params.set('lat', String(near.lat));
    params.set('lon', String(near.lon));
  }
  const res = await fetch(`${PHOTON.endpoint}?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Photon autosuggest responded with HTTP ${res.status}.`);
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .map((it) => {
      const lat = Number(it?.lat);
      const lon = Number(it?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const primary = String(it?.title || '').trim();
      if (!primary) return null;
      const secondary = String(it?.secondary || '').trim();
      return {
        lat,
        lon,
        label: String(it?.label || [primary, secondary].filter(Boolean).join(', ')),
        primary,
        secondary,
      };
    })
    .filter(Boolean);
}

/* ============================================================
 *  Reverse geocoding (Nominatim via /api/osm/reverse)
 * ============================================================ */

/**
 * A long-pressed map point needs a readable label. Returns null when
 * Nominatim has nothing meaningful for this spot; the caller falls
 * back to honest coordinates ("Dropped pin (lat, lon)").
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{lat:number, lon:number, label:string, confidence:number, source:string}|null>}
 */
export async function reverse(lat, lon) {
  const res = await postJson(REVERSE_GEOCODE.endpoint, { lat, lon });
  if (!res.ok) throw new Error(`OSM reverse geocode responded with HTTP ${res.status}.`);
  const data = await res.json();
  // The server's reverse handler returns `{ label }` (null when the
  // spot has nothing). We accept the verbose `{ items: [...] }` shape
  // too — future-proof against server-side shape changes.
  let label = null;
  if (typeof data?.label === 'string') {
    label = data.label;
  } else if (Array.isArray(data?.items) && data.items[0]) {
    label = data.items[0]?.label || null;
  }
  if (!label || !label.trim()) return null;
  return { lat, lon, label: label.trim(), confidence: 1, source: 'osm' };
}
