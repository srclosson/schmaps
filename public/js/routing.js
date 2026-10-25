/**
 * Schmaps routing — OSRM @ FOSSGIS (spec §8) with traffic-adjusted
 * ETA, cross-checked against independent routing engines for accurate
 * destination timing.
 *
 * The primary engine is OSRM (OpenStreetMap routing, keyless, proxied
 * through /api/osm/route); the cross-check witnesses (TomTom,
 * Stadia Maps) still run through `/api/routing/witness` so a second
 * opinion sits behind the headline ETA.
 *
 * The shape returned by `computeRoute()` is the Schmaps `RouteResult`
 * the rest of the app already consumes:
 *
 *   { geometry, distanceMeters, freeFlowSeconds, trafficSeconds,
 *     eta, congestionFactor, incidents, runs, crossesUsa, maneuvers,
 *     edges, alternatives[] }
 *
 * `edges` carries OSRM's per-edge duration/distance annotations — the
 * raw material for the local per-km ETA engine (public/js/eta.js),
 * which re-times the drive on every GPS fix without touching the
 * router.
 *
 * The Canada-via synthesis (`canadaViaRoute`) is preserved — when
 * the primary OSRM route AND every alternative cross the border, a
 * Canadian via-town route is stitched from two OSRM legs (origin →
 * via → destination) so the user always has a stay-in-Canada option
 * in the chip row.
 */

import { ALT_ROUTES, ROUTING_CONSENSUS } from './config.js';
import {
  fetchTrafficEvents,
  eventsAlongRoute,
  incidentDelaySeconds,
  congestionFactor,
  segmentCongestion,
  crossesUsaBorder,
  haversineKm,
} from './traffic.js';
import { loadPlaces } from './places.js';
import { route as osrmRoute } from './osrm.js';

/* ---------------- routing consensus ---------------- */

/**
 * Fetch independent travel-time estimates ("witnesses") for the same
 * origin → destination pair. The proxy in server.js fans out to TomTom
 * and Stadia Maps and returns one entry per engine:
 *   { source, durationSeconds, distanceMeters } on success,
 *   { source, error } on failure. Best-effort — any witness that
 * fails or times out is simply absent from the list.
 * @param {{lat:number, lon:number}} origin
 * @param {{lat:number, lon:number}} destination
 * @returns {Promise<Array<{source:string, durationSeconds:number, distanceMeters:number}>>}
 */
async function fetchWitnesses(origin, destination) {
  if (!ROUTING_CONSENSUS.witnessUrl) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTING_CONSENSUS.timeoutMs);
  try {
    const res = await fetch(ROUTING_CONSENSUS.witnessUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        origin: { lat: origin.lat, lon: origin.lon },
        destination: { lat: destination.lat, lon: destination.lon },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const witnesses = Array.isArray(data.witnesses) ? data.witnesses : [];
    return witnesses.filter(
      (w) =>
        w &&
        typeof w.durationSeconds === 'number' &&
        Number.isFinite(w.durationSeconds) &&
        w.durationSeconds > 0
    );
  } catch {
    return []; // consensus is best-effort; never block the route
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The consensus algorithm. Given our own estimate and the independent
 * witnesses, find the largest cluster of estimates that agree within
 * the tolerance window and average it:
 *
 *   tolerance = max(agreementSeconds, agreementPercent × median)
 *
 * Two estimates agree when |a − b| ≤ tolerance. The largest agreeing
 * cluster wins; ties prefer the cluster containing our own estimate
 * (it's the route we actually draw), then the tighter spread. The
 * outlier is discarded. With no agreement at all, our own estimate
 * stands — consensus refines, it never overrides.
 * @param {number} ownSeconds our traffic-adjusted estimate
 * @param {Array<{source:string, durationSeconds:number}>} witnesses
 * @returns {{seconds:number, sources:string[], discarded:string[]}|null}
 *   null when there are no witnesses to consult
 */
export function consensusEstimate(ownSeconds, witnesses) {
  if (!Number.isFinite(ownSeconds) || ownSeconds <= 0) return null;
  if (!Array.isArray(witnesses) || witnesses.length === 0) return null;

  const estimates = [
    { source: 'schmaps', seconds: ownSeconds, own: true },
    ...witnesses.map((w) => ({
      source: w.source,
      seconds: w.durationSeconds,
      own: false,
    })),
  ].filter((e) => Number.isFinite(e.seconds) && e.seconds > 0);
  if (estimates.length < 2) return null;

  const sorted = [...estimates].sort((a, b) => a.seconds - b.seconds);
  const median = sorted[Math.floor(sorted.length / 2)].seconds;
  const tolerance = Math.max(
    ROUTING_CONSENSUS.agreementSeconds,
    ROUTING_CONSENSUS.agreementPercent * median
  );

  // Find every agreeing cluster: for each anchor estimate, the
  // cluster is all estimates within tolerance of it. The largest
  // cluster wins.
  let best = null;
  for (const anchor of sorted) {
    const cluster = sorted.filter((e) => Math.abs(e.seconds - anchor.seconds) <= tolerance);
    const spread = cluster[cluster.length - 1].seconds - cluster[0].seconds;
    const hasOwn = cluster.some((e) => e.own);
    if (
      !best ||
      cluster.length > best.members.length ||
      (cluster.length === best.members.length && hasOwn && !best.hasOwn) ||
      (cluster.length === best.members.length && hasOwn === best.hasOwn && spread < best.spread)
    ) {
      best = { members: cluster, spread, hasOwn };
    }
  }

  // A single-member "cluster" is no consensus — need at least two
  // estimates in agreement to average.
  if (best.members.length < 2) {
    return {
      seconds: ownSeconds,
      sources: ['schmaps'],
      discarded: witnesses.map((w) => w.source),
    };
  }

  const seconds = best.members.reduce((sum, e) => sum + e.seconds, 0) / best.members.length;
  const sources = best.members.map((e) => e.source);
  const discarded = estimates
    .filter((e) => !best.members.includes(e))
    .map((e) => e.source);
  return { seconds, sources, discarded };
}

/**
 * Flatten one adapter route (public/js/osrm.js) into the RouteResult
 * skeleton: maneuvers via extractManeuvers over the OSRM legs, per-edge
 * annotations preserved for the per-km ETA engine. Traffic seconds and
 * incidents are layered on by trafficAdjust in computeRoute.
 */
function osrmRouteToResult(r) {
  return {
    geometry: r.geometry,
    distanceMeters: r.distanceMeters,
    freeFlowSeconds: r.freeFlowSeconds,
    trafficSeconds: r.freeFlowSeconds, // OSRM has no live traffic; trafficAdjust adds incidents
    eta: new Date(Date.now() + r.freeFlowSeconds * 1000),
    maneuvers: extractManeuvers(r.legs ?? []),
    edges: r.edges ?? null,
    maxSpeedKmh: r.maxSpeedKmh ?? null,
  };
}

/**
 * Compute a route with a traffic-aware ETA.
 *
 * Wires the OSRM adapter into the same RouteResult shape `app.js` and
 * `traffic.js` already understand:
 *   - geometry stays in `[lon,lat]` order
 *   - trafficSeconds drives ETA + the consensus
 *   - maneuvers keep their OSRM-style {type, modifier, name, location,
 *     distance, vertexIndex, lanes} fields (the turn banner reads them)
 *   - edges carry the per-edge annotations for the local ETA engine
 *   - alternatives get the same shape, ready for the chips + the
 *     "Quicker route" card
 *   - maxSpeedKmh leaks through for the right-rail speed-limit badge
 * @param {{lat:number, lon:number}} origin
 * @param {{lat:number, lon:number}} destination
 * @returns {Promise<RouteResult>}
 */
export async function computeRoute(origin, destination) {
  // Witnesses (TomTom, Stadia Maps) are fetched in parallel with OSRM
  // so the consensus cross-check adds no wait to the route.
  const witnessesPromise = fetchWitnesses(origin, destination);

  // OSRM primary + alternatives. Throws "no route" for unreachable
  // pairs — the caller surfaces that to the user; the Canada-via
  // fallback is only invoked when a route IS found but crosses the
  // border.
  const osrmResult = await osrmRoute(origin, destination);
  const primary = osrmRouteToResult(osrmResult);
  const geometry = primary.geometry;
  if (!geometry || geometry.length < 2) {
    throw new Error('No driving route found between those points.');
  }

  // One events fetch shared by the primary route and every alternative.
  const events = await fetchTrafficEvents();

  const distanceMeters = primary.distanceMeters;
  const freeFlowSeconds = primary.freeFlowSeconds;
  const maneuvers = primary.maneuvers ?? [];

  const { trafficSeconds, congestionFactor, incidents, runs } = await trafficAdjust(
    freeFlowSeconds,
    geometry,
    { events }
  );
  const crossesUsa = await crossesUsaBorder(geometry);

  // Consensus — cross-check our traffic-adjusted estimate against the
  // independent witnesses. Two or more estimates within the agreement
  // tolerance are averaged into the ETA; the outlier is discarded.
  // No witnesses (or no agreement) leaves our own estimate standing.
  const witnesses = await witnessesPromise;
  const consensus = consensusEstimate(trafficSeconds, witnesses);
  const finalSeconds = consensus ? Math.round(consensus.seconds) : trafficSeconds;

  // Alternatives — traffic-adjusted and USA-flagged, ready for the
  // chips. The app never auto-switches; it just lays out the options.
  const alternatives = [];
  for (const altRaw of osrmResult.alternatives ?? []) {
    const alt = osrmRouteToResult(altRaw);
    const adj = await trafficAdjust(alt.freeFlowSeconds, alt.geometry, { events });
    alternatives.push({
      ...alt,
      trafficSeconds: adj.trafficSeconds,
      eta: new Date(Date.now() + adj.trafficSeconds * 1000),
      congestionFactor: adj.congestionFactor,
      incidents: adj.incidents,
      runs: adj.runs,
      crossesUsa: await crossesUsaBorder(alt.geometry),
    });
  }

  // The Canada guarantee: if the fastest route AND every alternative
  // dip through the USA, synthesize a Canadian option via a gazetteer
  // town so staying in Canada is always on the table. (A destination
  // in the USA makes every via-route cross too, so none is invented.)
  if (crossesUsa && alternatives.every((a) => a.crossesUsa)) {
    const hint =
      canadaViaCache && canadaViaCache.destKey === canadaDestKey(destination)
        ? canadaViaCache.via
        : null;
    const canada = await canadaViaRoute(origin, destination, events, distanceMeters, hint);
    if (canada) {
      alternatives.push(canada);
      canadaViaCache = {
        destKey: canadaDestKey(destination),
        via: { ...canada.canadaViaPoint, name: canada.canadaVia },
      };
    }
  }

  return {
    geometry,
    distanceMeters,
    freeFlowSeconds,
    trafficSeconds: finalSeconds,
    eta: new Date(Date.now() + finalSeconds * 1000),
    congestionFactor,
    incidents,
    runs,
    crossesUsa,
    maneuvers,
    edges: primary.edges ?? null,
    maxSpeedKmh: primary.maxSpeedKmh ?? null,
    consensus: consensus
      ? { sources: consensus.sources, discarded: consensus.discarded }
      : null,
    alternatives,
  };
}

/**
 * Traffic-adjust a free-flow duration. The route is cut into ~2 km
 * stretches, each graded for typical congestion and live incidents —
 * that one cut drives the 3-colour line, the "+min" badges, and
 * (summed) the traffic part of the ETA. Shared by single-destination
 * routing and errands mode.
 * @param {number} freeFlowSeconds
 * @param {Array<[number,number]>} geometry [lon,lat] pairs
 * @param {{events?:Array}} [opts] pre-fetched events, shared across routes
 * @returns {Promise<{trafficSeconds:number, congestionFactor:number, incidents:Array, runs:Array}>}
 */
export async function trafficAdjust(freeFlowSeconds, geometry, { events } = {}) {
  const midpoint = geometry[Math.floor(geometry.length / 2)];
  const factor = congestionFactor(midpoint, new Date());

  const allEvents = events ?? (await fetchTrafficEvents());
  const matched = eventsAlongRoute(geometry, allEvents);
  const incidentSeconds = incidentDelaySeconds(matched);

  const { runs } = segmentCongestion(geometry, matched, new Date(), freeFlowSeconds);
  const segmentSeconds = runs.reduce((sum, r) => sum + r.extraSeconds, 0);

  return {
    trafficSeconds: Math.round(freeFlowSeconds + segmentSeconds),
    congestionFactor: factor,
    incidents: matched,
    runs,
  };
}

/* ---------------- the Canada guarantee ---------------- */

// Last via-town that produced a Canadian route for a destination —
// the every-minute refresh re-verifies it with a single HERE call
// instead of re-running the whole town search.
let canadaViaCache = null;

function canadaDestKey(destination) {
  return `${destination.lat.toFixed(2)},${destination.lon.toFixed(2)}`;
}

/**
 * Perpendicular distance (km) from point P to the A→B line segment —
 * ranks via-town candidates by how far off the direct line they sit.
 * Equirectangular approximation: cheap, and plenty accurate for
 * ranking at country scale.
 */
function distanceToSegmentKm(a, b, p) {
  const latRef = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const kmPerLon = 111.32 * Math.cos(latRef);
  const kmPerLat = 110.57;
  const ax = a.lon * kmPerLon;
  const ay = a.lat * kmPerLat;
  const bx = b.lon * kmPerLon;
  const by = b.lat * kmPerLat;
  const px = p.lon * kmPerLon;
  const py = p.lat * kmPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Synthesize a Canada-only route: origin → a Canadian town →
 * destination. Runs only when the primary OSRM route AND every
 * alternative cross into the USA — the guarantee that staying in
 * Canada is always an option. Candidates come in two tiers: towns
 * closest to the direct line (the mildest detours), then population
 * hubs in a wider corridor (major towns sit on the Trans-Canada
 * highways — the reliable way around the Great Lakes). The cached
 * winner is re-verified first; the fastest via-route that clears the
 * border wins. Returns null when no Canadian route can be found — a
 * destination inside the USA makes every via-route cross, so none is
 * invented.
 */
async function canadaViaRoute(origin, destination, events, primaryDistanceMeters, hint = null) {
  const {
    nearCorridorKm,
    hubCorridorKm,
    hubMinPop,
    minEndKm,
    spreadKm,
    maxTries,
    maxDistanceRatio,
  } = ALT_ROUTES.canadaVia;

  /**
   * Try a single via-town. OSRM's public profile takes multi-waypoint
   * URLs, but per-waypoint alternatives don't — so for the 3-point via
   * (origin → via → destination) we run two sequential route() calls
   * and stitch the result:
   *   1. origin → via          → polyline head
   *   2. via → destination     → polyline tail
   * We sum distances/durations and concatenate maneuvers. The result is
   * a real OSRM-computed Canada-only route — no synthetic geometry.
   */
  const tryVia = async (via) => {
    let head;
    let tail;
    try {
      head = osrmRouteToResult(await osrmRoute(origin, via, { alternatives: 0 }));
      tail = osrmRouteToResult(await osrmRoute(via, destination, { alternatives: 0 }));
    } catch {
      return null; // transient hiccup — the next town gets a turn
    }
    if (!head?.geometry?.length || !tail?.geometry?.length) return null;
    // Stitch geometry, dropping the duplicate via-point at the join.
    const headGeom = head.geometry;
    const tailGeom = tail.geometry;
    const geometry = headGeom.concat(tailGeom.slice(1));
    const distanceMeters = (head.distanceMeters || 0) + (tail.distanceMeters || 0);
    if (distanceMeters > primaryDistanceMeters * maxDistanceRatio) return null;
    if (await crossesUsaBorder(geometry)) return null; // still dips south

    const freeFlowSeconds = (head.freeFlowSeconds || 0) + (tail.freeFlowSeconds || 0);
    const adj = await trafficAdjust(freeFlowSeconds, geometry, { events });
    // Maneuvers: head ends with an "arrive" at via; tail starts with
    // "depart" — strip both so the turn dialog reads as one journey.
    const headManeuvers = (head.maneuvers || []).filter(
      (m) => m.type !== 'depart' && m.type !== 'arrive'
    );
    const tailManeuvers = (tail.maneuvers || []).filter(
      (m) => m.type !== 'depart' && m.type !== 'arrive'
    );
    // Re-stamp vertexIndex on the tail so it indexes into the stitched geometry.
    const headEndIndex = headGeom.length - 1;
    const tailManueversStitched = tailManeuvers.map((m) => ({
      ...m,
      vertexIndex: (Number.isFinite(m.vertexIndex) ? m.vertexIndex : 0) + headEndIndex,
    }));
    const maneuvers = headManeuvers.concat(tailManueversStitched);
    // Stitched per-edge annotations stay aligned with the stitched
    // geometry (head edges + tail edges = joined vertex pairs − 1), so
    // the per-km ETA engine gets edge-accurate buckets here too.
    const edges =
      head.edges && tail.edges
        ? {
            durationS: head.edges.durationS.concat(tail.edges.durationS),
            distanceM: head.edges.distanceM.concat(tail.edges.distanceM),
            impliedKmh: head.edges.impliedKmh.concat(tail.edges.impliedKmh),
          }
        : null;
    return {
      geometry,
      distanceMeters,
      freeFlowSeconds,
      trafficSeconds: adj.trafficSeconds,
      eta: new Date(Date.now() + adj.trafficSeconds * 1000),
      congestionFactor: adj.congestionFactor,
      incidents: adj.incidents,
      runs: adj.runs,
      crossesUsa: false,
      maneuvers,
      edges,
      maxSpeedKmh: Math.max(
        Number(head.maxSpeedKmh) || 0,
        Number(tail.maxSpeedKmh) || 0
      ) || null,
      canadaVia: via.name,
      canadaViaPoint: { lat: via.lat, lon: via.lon },
    };
  };

  if (hint && Number.isFinite(hint.lat) && Number.isFinite(hint.lon)) {
    const cached = await tryVia(hint);
    if (cached) return cached;
  }

  let towns = [];
  try {
    towns = await loadPlaces();
  } catch {
    towns = []; // gazetteer is best-effort; never block routing
  }
  const base = (Array.isArray(towns) ? towns : [])
    .filter((t) => Number.isFinite(t.la) && Number.isFinite(t.lo))
    .map((t) => ({
      name: t.n,
      lat: t.la,
      lon: t.lo,
      pop: t.pop || 0,
      offKm: distanceToSegmentKm(origin, destination, { lat: t.la, lon: t.lo }),
      fromOriginKm: haversineKm(origin.lat, origin.lon, t.la, t.lo),
      fromDestKm: haversineKm(destination.lat, destination.lon, t.la, t.lo),
    }))
    .filter((c) => c.fromOriginKm >= minEndKm && c.fromDestKm >= minEndKm);

  // Tier 1 — towns closest to the direct line: the mildest detours,
  // and often all it takes when only a border-hugging stretch dips south.
  const near = base
    .filter((c) => c.offKm <= nearCorridorKm)
    .sort((a, b) => a.offKm - b.offKm);
  // Tier 2 — population hubs in a wider corridor, biggest first.
  const hubs = base
    .filter((c) => c.offKm <= hubCorridorKm && c.pop >= hubMinPop)
    .sort((a, b) => b.pop - a.pop);

  // Spread the picks apart — neighbouring towns all route the same
  // way, so each try should sample a different part of the corridor.
  const tries = [];
  const pickFrom = (list, cap) => {
    for (const c of list) {
      if (tries.length >= maxTries || cap <= 0) break;
      if (tries.some((t) => haversineKm(t.lat, t.lon, c.lat, c.lon) < spreadKm)) continue;
      tries.push(c);
      cap--;
    }
  };
  pickFrom(near, 2);
  pickFrom(hubs, 4);

  let best = null;
  for (const via of tries) {
    const alt = await tryVia(via);
    if (alt && (!best || alt.trafficSeconds < best.trafficSeconds)) best = alt;
  }
  return best;
}

/* ---------------- maneuver helpers ---------------- */

/**
 * Flatten an array of route legs into a single maneuvers array.
 *
 * Used by errands runs (which work against OSRM-shaped legs with nested
 * `steps[].maneuver` objects) and by `computeRoute` legs — both shapes
 * are tolerated. Defensive: returns [] for any malformed input so the
 * caller can pass the result straight to `app.js`'s turn-banner logic
 * (`route.maneuvers ?? []`) without further null checks.
 *
 * Each returned maneuver is normalised to the shape the turn banner
 * expects: `{ type, modifier, name, location, vertexIndex, distance,
 * lanes }`.
 *
 * OSRM legs: `steps[]` each carry a `maneuver` and a per-step geometry.
 * The vertex cursor counts EVERY step (including depart/arrive, which
 * are skipped from the output but still consume their geometry's
 * vertices) so vertexIndex stays aligned with the stitched geometry —
 * and it keeps counting across legs so a multi-stop errands run has
 * one monotonic index space. Lane guidance rides on the first
 * intersection of the step (`intersections[0].lanes`), already in the
 * `{ valid, indications }` shape the banner renders.
 *
 * Pre-flattened legs: `{ maneuvers: [...] }` pass through unchanged
 * (historically the HERE adapter's shape; kept for tolerance).
 */
export function extractManeuvers(legs) {
  if (!Array.isArray(legs)) return [];
  const out = [];
  let vertexCursor = 0;
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    // OSRM shape: { steps: [{ maneuver, name, distance, ... }, ...] }
    if (Array.isArray(leg.steps)) {
      for (const step of leg.steps) {
        const m = step?.maneuver;
        if (!m || typeof m !== 'object') continue;
        const type = m.type ?? 'unknown';
        // Every step consumes its geometry's vertices — count them
        // BEFORE deciding whether the step reaches the banner.
        const stepCoords = Array.isArray(step?.geometry?.coordinates)
          ? step.geometry.coordinates
          : null;
        const stepVertexSpan = stepCoords ? Math.max(1, stepCoords.length - 1) : 1;
        if (type !== 'depart' && type !== 'arrive') {
          // Lane guidance: OSRM puts lanes on the maneuver's first
          // intersection. Keep the {valid, indications} shape verbatim;
          // steps without lanes get null (banner hides the lane row).
          let lanes = null;
          const rawLanes = Array.isArray(step?.intersections?.[0]?.lanes)
            ? step.intersections[0].lanes
            : null;
          if (rawLanes && rawLanes.length > 0) {
            lanes = rawLanes.map((l) => ({
              valid: !!l?.valid,
              indications: Array.isArray(l?.indications) ? l.indications : [],
            }));
          }
          out.push({
            type,
            modifier: m.modifier ?? null,
            name: typeof step.name === 'string' ? step.name : '',
            location: Array.isArray(m.location) ? m.location : null,
            distance: Number(step.distance) || 0,
            vertexIndex: vertexCursor,
            lanes,
          });
        }
        vertexCursor += stepVertexSpan;
      }
      continue;
    }
    // Pre-flattened (historical HERE shape): { maneuvers: [...] }
    if (Array.isArray(leg.maneuvers)) {
      for (const m of leg.maneuvers) out.push(m);
    }
  }
  return out;
}

/* ---------------- formatting helpers ---------------- */

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export function formatTime(date) {
  // Strip the dots from a.m./p.m. — "2:30 pm" wraps less than "2:30 p.m."
  return date
    .toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
    .replace(/\./g, '');
}

/**
 * @typedef {Object} RouteResult
 * @property {Array<[number,number]>} geometry
 * @property {number} distanceMeters
 * @property {number} freeFlowSeconds
 * @property {number} trafficSeconds
 * @property {Date} eta
 * @property {number} congestionFactor
 * @property {Array} incidents
 * @property {Array} runs coloured stretches of the 3-colour line
 * @property {boolean} crossesUsa does the route cross into the USA
 * @property {Array<{type:string, modifier:string, name:string, location:[number,number], distance:number, vertexIndex:number, lanes:Array|null}>} [maneuvers]
 *   turn-by-turn guidance: each upcoming turn with its road name, position
 *   along the route (vertexIndex into geometry), and lane indications
 * @property {number|null} [maxSpeedKmh] highest posted limit along the route
 * @property {string} [canadaVia] town a synthesized Canada route goes via
 * @property {{lat:number, lon:number}} [canadaViaPoint] that town's position
 * @property {{sources:string[], discarded:string[]}|null} [consensus]
 *   which engines agreed on the ETA, and which estimate was discarded
 * @property {Array<RouteResult>} alternatives other routes, same shape
 */