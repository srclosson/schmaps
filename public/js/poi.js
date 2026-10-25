/**
 * Schmaps POI search — Nominatim (OpenStreetMap) for businesses and
 * named places. Errands are mostly things an address geocoder can't
 * resolve ("ikea", "burger king", "the thrift store"), so we ask
 * Nominatim's search endpoint, restricted to Canada and biased toward
 * the user's location with a viewbox.
 *
 * Nominatim usage policy: max 1 request/second. errands.js paces its
 * calls (~1.1s apart). Browsers set their own User-Agent (a forbidden
 * header we cannot override); the Referer identifies this app.
 */

import { POI } from './config.js';
import { haversineKm } from './traffic.js';

/**
 * Search for a named place, biased toward a location.
 * @param {string} query e.g. "ikea" or "burger king"
 * @param {{lat:number, lon:number}} [near] bias results toward this point
 * @param {number} [limit] max results
 * @returns {Promise<Array<{lat:number, lon:number, name:string, label:string}>>}
 */
export async function searchPOI(query, { near, limit = POI.limit } = {}) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit),
    countrycodes: POI.countryCodes,
    addressdetails: '1',
  });

  // Bias toward the user's area: a ~1.5° box centred on them. Without
  // this, "ikea" happily returns Ottawa when you're standing in Toronto.
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    const d = 0.75;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }

  const res = await fetch(`${POI.endpoint}?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`POI search responded with HTTP ${res.status}.`);

  const results = await res.json();
  if (!Array.isArray(results)) return [];

  return results
    .map((r) => {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      const a = r.address || {};
      const locality =
        a.city || a.town || a.village || a.hamlet || a.municipality || a.county;
      const name = r.name || (r.display_name || '').split(',')[0] || query;
      const label = [name, locality, a.state].filter(Boolean).join(', ');
      return { lat, lon, name, label };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/* ---------------- category search (Overpass, hours-aware) ---------------- */

// Browser-direct Overpass fallback — same query the server proxy runs.
// The server proxy goes first (it identifies us properly and tries the
// mirror list); when the cluster's egress can't reach Overpass at all,
// the phone's own network gets a turn before the hours-less Nominatim
// fallback. Overpass sends permissive CORS headers, so this is legal
// from the page.
const OVERPASS_INTERPRETER = 'https://overpass-api.de/api/interpreter';

/** The Overpass QL for a category around a point (mirrors server.js). */
function categoryQL(cat, { lat, lon, radiusM, limit }) {
  const arms = cat.selectors
    .map(([k, v]) => `nwr(around:${radiusM},${lat},${lon})[${JSON.stringify(k)}=${JSON.stringify(v)}]`)
    .join(';');
  return `[out:json][timeout:15];(${arms};);out tags center ${limit * 2};`;
}

/** Normalize raw Overpass elements into place rows (mirrors server.js). */
function mapOverpassElements(data, cat) {
  const places = [];
  const seen = new Set();
  if (!data || !Array.isArray(data.elements)) return places;
  for (const el of data.elements) {
    const tags = el?.tags || {};
    const name = String(tags.name || '').trim();
    if (!name) continue; // a nameless shop is noise, not a destination
    const plat = Number.isFinite(el?.lat) ? el.lat : Number(el?.center?.lat);
    const plon = Number.isFinite(el?.lon) ? el.lon : Number(el?.center?.lon);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
    const key = `${plat.toFixed(4)},${plon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const selector = cat.selectors.find(([k, v]) => tags[k] === v);
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
  return places;
}

/**
 * Category search, three layers deep:
 *   1. the /api/osm/poi server proxy (identified UA, mirror list),
 *   2. browser-direct Overpass on the phone's own network (the proxy
 *      reports `overpass: 'unreachable'` when the cluster's egress
 *      can't reach any mirror),
 *   3. nothing — the caller (app.js browseCategory) degrades to the
 *      Nominatim POI search with "hours unknown" pins.
 */
export async function searchCategoryPOI(cat, { near, radiusM = 15000, limit = 16 } = {}) {
  if (!near || !Number.isFinite(near.lat) || !Number.isFinite(near.lon)) {
    throw new Error('Category search needs a position to search around.');
  }
  let places = null;

  try {
    const res = await fetch('/api/osm/poi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        selectors: cat.selectors,
        lat: near.lat,
        lon: near.lon,
        radiusM,
        limit,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.places) && data.places.length > 0) {
        places = data.places;
      } else if (data?.overpass !== 'unreachable') {
        places = []; // Overpass answered: this area genuinely has none
      }
    }
  } catch {
    /* proxy failed — try the phone's own network below */
  }

  if (places === null) {
    try {
      const res = await fetch(OVERPASS_INTERPRETER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: `data=${encodeURIComponent(
          categoryQL(cat, { lat: near.lat, lon: near.lon, radiusM, limit })
        )}`,
      });
      if (res.ok) places = mapOverpassElements(await res.json(), cat);
    } catch {
      /* direct failed too — caller degrades to Nominatim */
    }
  }

  if (places === null) {
    throw new Error('Category search is unavailable right now.');
  }
  return places
    .map((p) => ({
      ...p,
      distanceKm: haversineKm(near.lat, near.lon, Number(p.lat), Number(p.lon)),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/* ---------------- posted speed limits (best-effort, two layers) ---------------- */

/** "50" → 50, "35 mph" → 56, "none"/"variable"/odd shapes → null. */
function parseMaxspeed(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.match(/^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return m[2] ? Math.round(v * 1.609344) : Math.round(v);
}

/**
 * Posted speed limits near a handful of points, two layers deep:
 *   1. the /api/osm/limits server proxy (identified UA, mirror list),
 *   2. browser-direct Overpass on the phone's own network — the same
 *      resilience pattern as searchCategoryPOI, because the
 *      speed-limit badge NEEDS real posted limits: the router's
 *      implied speed is an average over intersections and ramps, not
 *      the number on the sign beside the car.
 *
 * The first point is treated as the CAR itself by the caller, so its
 * reading is "the limit of the road I'm on".
 *
 * @param {Array<[number, number]>} points [lat, lon] pairs (max 12)
 * @returns {Promise<Array<{lat:number, lon:number, limitKmh:number|null}>>}
 *   same length and order as `points`; never throws (nulls when both
 *   layers fail — the caller keeps the implied-speed fallback).
 */
export async function fetchPostedLimits(points) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, 12)
    .map((p) => [Number(p[0]), Number(p[1])]);
  if (pts.length === 0) return [];

  let out = null;
  try {
    const res = await fetch('/api/osm/limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ points: pts }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.points)) {
        out = data.points;
        // Overpass answered through the proxy: nulls are real "no
        // tagged way here", not "unreachable" — keep them.
        if (data.overpass !== 'unreachable' && pts.length === data.points.length) {
          return data.points;
        }
      }
    }
  } catch {
    /* proxy failed — try the phone's own network below */
  }

  if (out === null) {
    out = pts.map(([lat, lon]) => ({ lat, lon, limitKmh: null }));
  }
  // Layer 2 — browser-direct Overpass (permissive CORS).
  try {
    const around = pts.map((p) => `${p[0]},${p[1]}`).join(',');
    const ql = `[out:json][timeout:12];way(around:40,${around})[maxspeed];out tags center 200;`;
    const res = await fetch(OVERPASS_INTERPRETER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `data=${encodeURIComponent(ql)}`,
    });
    if (!res.ok) return out;
    const data = await res.json();
    if (!data || !Array.isArray(data.elements)) return out;
    for (const el of data.elements) {
      const kmh = parseMaxspeed(el?.tags?.maxspeed);
      if (kmh === null) continue;
      const c = el?.center;
      if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue;
      let bestIdx = -1;
      let bestDeg = Infinity;
      for (let i = 0; i < pts.length; i++) {
        // Cheap degree-space distance is plenty at a 40 m scale.
        const deg = Math.abs(c.lat - pts[i][0]) + Math.abs(c.lon - pts[i][1]);
        if (deg < bestDeg) {
          bestDeg = deg;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || bestDeg > 0.01) continue;
      const cur = out[bestIdx].limitKmh;
      if (cur === null || kmh < cur) out[bestIdx].limitKmh = kmh;
    }
  } catch {
    /* direct failed too — nulls stand, caller falls back */
  }
  return out;
  return places
    .map((p) => ({
      ...p,
      distanceKm: haversineKm(near.lat, near.lon, Number(p.lat), Number(p.lon)),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
