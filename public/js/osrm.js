/**
 * Schmaps ↔ OSRM adapter (FOSSGIS public instance, via /api/osm/route).
 *
 * Returns a light "adapter route" per OSRM route:
 *   { geometry, distanceMeters, freeFlowSeconds, legs, edges, maxSpeedKmh }
 *
 * `edges` carries the per-edge OSRM annotations aligned to the
 * overview=full geometry (edge i spans vertex i → i+1):
 *   { durationS: number[], distanceM: number[], impliedKmh: number[] }
 *
 * `impliedKmh` is what the router assumes you'll drive on that edge
 * (distance / duration) — the reference speed for the local per-km ETA
 * engine (public/js/eta.js) and the speed-limit badge's fallback when
 * no posted limit is known.
 *
 * routing.js flattens adapter routes into the full Schmaps RouteResult
 * (maneuvers come from `legs` via extractManeuvers); OSRM knows nothing
 * about live traffic, so routing.js's trafficAdjust adds the Ontario
 * 511 incident delays on top.
 *
 * OSRM response shape (what the server proxy returns verbatim):
 *   routes[].geometry.coordinates  [[lon, lat], …] (overview=full)
 *   routes[].duration / .distance  totals
 *   routes[].legs[].steps[]        maneuvers, per-step geometry, lanes
 *   routes[].legs[].annotation     duration[] / distance[] per edge
 */

import { ROUTER } from './config.js';

/** Internal: POST JSON to a /api/osm/* proxy route. */
async function postJson(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

/**
 * Convert one OSRM route object into the adapter shape. The legs'
 * annotation arrays concatenate seamlessly onto the overview=full
 * geometry: legs are joined with the duplicate boundary vertex dropped,
 * so edges line up 1:1 with the stitched vertex pairs. When the edge
 * count doesn't match (server changed annotations, malformed reply),
 * `edges` comes back null and the ETA engine falls back to
 * proportional time sharing.
 *
 * @param {object} r an OSRM `routes[]` entry
 * @returns {null | {
 *   geometry: Array<[number, number]>,
 *   distanceMeters: number,
 *   freeFlowSeconds: number,
 *   legs: Array,
 *   edges: { durationS: number[], distanceM: number[], impliedKmh: number[] } | null,
 *   maxSpeedKmh: number | null,
 * }}
 */
export function osrmToAdapterRoute(r) {
  const geometry = Array.isArray(r?.geometry?.coordinates) ? r.geometry.coordinates : [];
  if (geometry.length < 2) return null;

  const durationS = [];
  const distanceM = [];
  // OSM node IDs per VERTEX (OSRM `nodes` annotation) — edge i spans
  // nodeIds[i] → nodeIds[i+1]. The road-segment identity the driver
  // profile's commuter tier learns by.
  const nodeIds = [];
  for (const leg of Array.isArray(r?.legs) ? r.legs : []) {
    const ann = leg?.annotation || {};
    const dur = Array.isArray(ann.duration) ? ann.duration : [];
    const dist = Array.isArray(ann.distance) ? ann.distance : [];
    const nds = Array.isArray(ann.nodes) ? ann.nodes : [];
    const n = Math.min(dur.length, dist.length);
    // Legs after the first repeat the join vertex in their annotations
    // — skip their first node so nodeIds align 1:1 with the stitched
    // geometry, the same way the edges do.
    const nodeFrom = nodeIds.length > 0 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      durationS.push(Number(dur[i]) || 0);
      distanceM.push(Number(dist[i]) || 0);
    }
    for (let i = nodeFrom; i < nds.length; i++) {
      nodeIds.push(Number(nds[i]) || 0);
    }
  }

  // Implied speed per edge (km/h) — the router's own assumption.
  const impliedKmh = durationS.map((d, i) =>
    d > 0 && distanceM[i] > 0 ? (distanceM[i] / d) * 3.6 : null
  );

  // The route's ceiling — the badge's pre-navigation fallback value,
  // same role the old HERE `maxSpeedKmh` played.
  let maxSpeedKmh = null;
  for (const v of impliedKmh) {
    if (v !== null && (maxSpeedKmh === null || v > maxSpeedKmh)) maxSpeedKmh = v;
  }

  return {
    geometry,
    distanceMeters: Number(r.distance) || 0,
    freeFlowSeconds: Number(r.duration) || 0,
    legs: Array.isArray(r?.legs) ? r.legs : [],
    edges:
      durationS.length === geometry.length - 1
        ? {
            durationS,
            distanceM,
            impliedKmh,
            nodeIds: nodeIds.length === geometry.length ? nodeIds : null,
          }
        : null,
    maxSpeedKmh: maxSpeedKmh !== null ? Math.round(maxSpeedKmh) : null,
  };
}

/**
 * Compute a driving route (+ alternatives) through the /api/osm/route
 * proxy.
 *
 * Throws on transport errors and on "no route" — computeRoute() in
 * routing.js relies on that to surface the error (and the Canada-via
 * fallback only runs when a route IS found but crosses the border).
 *
 * @param {{lat:number, lon:number}} origin
 * @param {{lat:number, lon:number}} destination
 * @param {{alternatives?: number}} [opts]
 * @returns {Promise<{geometry, distanceMeters, freeFlowSeconds, legs, edges, maxSpeedKmh, alternatives: Array}>}
 */
export async function route(origin, destination, { alternatives = ROUTER.alternatives } = {}) {
  if (!origin || !destination) {
    throw new Error('OSRM routing needs numeric origin and destination.');
  }
  const res = await postJson(`${ROUTER.endpoint}/route`, {
    origin: { lat: origin.lat, lon: origin.lon },
    destination: { lat: destination.lat, lon: destination.lon },
    alternatives: Math.max(0, Number(alternatives) || 0),
  });
  if (!res.ok) throw new Error(`OSRM routing responded with HTTP ${res.status}.`);
  const data = await res.json();
  if (data?.code !== 'Ok' || !Array.isArray(data?.routes) || data.routes.length === 0) {
    throw new Error('No driving route found between those points.');
  }
  const primary = osrmToAdapterRoute(data.routes[0]);
  if (!primary) throw new Error('OSRM returned a route with no geometry.');
  const alts = [];
  for (const r of data.routes.slice(1)) {
    const conv = osrmToAdapterRoute(r);
    if (conv) alts.push(conv);
  }
  return { ...primary, alternatives: alts };
}
