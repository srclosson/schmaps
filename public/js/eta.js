/**
 * Schmaps local ETA engine — no router calls while driving.
 *
 * The active route is cut into 1-km buckets (`buildKmProfile`), each
 * carrying:
 *   freeFlowS   the router's own time for that km (OSRM per-edge
 *               durations when available, else proportional share)
 *   impliedKmh  the router's assumed speed for that km
 *               (OSRM edge distance/duration)
 *   limitKmh    the posted limit for that km, stamped in lazily from
 *               Overpass (best-effort; null until it arrives)
 *   incidentS   the Ontario 511 incident delay inside that km
 *
 * While driving (`remainingSeconds`):
 *   • the current partial km is timed at the live GPS speed,
 *   • future kms are timed at (router time / personal speed ratio),
 *   • the personal ratio is a clamped EMA of current speed vs the
 *     reference speed (posted limit when known, implied otherwise) —
 *     "I drive 8% faster than assumed" shortens the ETA accordingly,
 *   • incident delays are added raw — stopped time doesn't shrink
 *     because you drive faster between lights.
 *
 * The engine is pure math over the profile; the only network traffic
 * mid-drive is the lazy posted-limit lookup (Overpass, best-effort).
 */

import { haversineKm } from './traffic.js';

/**
 * Build the per-km profile of a route (RouteResult or errands shape).
 * Returns null for degenerate routes.
 *
 * @param {object} route { geometry, freeFlowSeconds, edges?, runs? }
 * @returns {null | {
 *   geometry: Array<[number, number]>,
 *   cum: number[],        // cumulative metres at each vertex
 *   totalM: number,
 *   freeFlowSeconds: number,
 *   buckets: Array<{startM, endM, freeFlowS, impliedKmh, limitKmh, incidentS}>,
 * }}
 */
export function buildKmProfile(route) {
  const geometry = Array.isArray(route?.geometry) ? route.geometry : [];
  if (geometry.length < 2) return null;

  // Cumulative distance (m) at each vertex — the progress axis.
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) {
    cum.push(
      cum[i - 1] +
        haversineKm(geometry[i - 1][1], geometry[i - 1][0], geometry[i][1], geometry[i][0]) * 1000
    );
  }
  const totalM = cum[cum.length - 1];
  if (totalM <= 0) return null;

  const edges = route.edges && Array.isArray(route.edges.durationS) ? route.edges : null;
  const freeFlowSeconds = Number(route.freeFlowSeconds) || 0;

  const nBuckets = Math.max(1, Math.ceil(totalM / 1000));
  const buckets = [];
  for (let b = 0; b < nBuckets; b++) {
    const startM = b * 1000;
    const endM = Math.min(startM + 1000, totalM);
    let freeFlowS = 0;
    let edgeLenM = 0;
    let edgeDurS = 0;
    if (edges) {
      // Sum the OSRM edge durations (and lengths) that fall inside this
      // km, fractional by overlap — the router's own timing for it.
      for (let i = 0; i < edges.durationS.length; i++) {
        const s = cum[i];
        const e = cum[i + 1];
        if (e === undefined || e <= startM) continue;
        if (s >= endM) break;
        const segLen = e - s || 1;
        const ov = Math.min(e, endM) - Math.max(s, startM);
        const frac = ov / segLen;
        freeFlowS += edges.durationS[i] * frac;
        edgeLenM += ov;
        edgeDurS += edges.durationS[i] * frac;
      }
    } else {
      // No annotations (errands trip route): share the total time out
      // proportionally by distance.
      freeFlowS = (freeFlowSeconds * (endM - startM)) / totalM;
    }
    const impliedKmh = edgeLenM > 20 && edgeDurS > 0 ? (edgeLenM / edgeDurS) * 3.6 : null;
    // Road-segment identity (OSM node pair) for the edge this bucket's
    // midpoint sits on — the commuter-tier learning key in
    // js/driver-profile.js. Null when the route carried no nodes
    // annotation (errands legs).
    let segKey = null;
    if (edges && edges.nodeIds) {
      const mid = (startM + endM) / 2;
      const v = vertexAtM({ cum }, mid);
      const e = Math.max(0, v - 1);
      if (e + 1 < edges.nodeIds.length) {
        segKey = `${edges.nodeIds[e]}-${edges.nodeIds[e + 1]}`;
      }
    }
    buckets.push({ startM, endM, freeFlowS, impliedKmh, limitKmh: null, incidentS: 0, segKey });
  }

  // Incident delay per bucket: the coloured runs carry extraSeconds
  // over vertex ranges; smear each run's delay across the buckets it
  // spans, proportional to the overlap.
  for (const run of Array.isArray(route.runs) ? route.runs : []) {
    const extra = Number(run?.extraSeconds) || 0;
    if (extra <= 0) continue;
    const s = cum[Math.min(Number(run.startIdx) || 0, cum.length - 1)];
    const e = cum[Math.min(Number(run.endIdx) || cum.length - 1, cum.length - 1)];
    if (e <= s) continue;
    const b0 = Math.floor(s / 1000);
    const b1 = Math.min(buckets.length - 1, Math.max(b0, Math.ceil(e / 1000) - 1));
    for (let b = b0; b <= b1; b++) {
      const ov = Math.min(buckets[b].endM, e) - Math.max(buckets[b].startM, s);
      if (ov > 0) buckets[b].incidentS += (extra * ov) / (e - s);
    }
  }

  return { geometry, cum, totalM, freeFlowSeconds, buckets };
}

/**
 * Nearest-vertex progress. Windowed around `lastVertex` so a fix on a
 * folded-back part of the line can't teleport progress backwards; the
 * first fix scans the whole line.
 *
 * @returns {null | {vertex: number, progressM: number, offRouteKm: number}}
 */
export function progressAt(profile, fix, lastVertex = null) {
  const { geometry, cum } = profile;
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return null;
  let from = 0;
  let to = geometry.length;
  if (Number.isFinite(lastVertex)) {
    from = Math.max(0, lastVertex - 400);
    to = Math.min(geometry.length, lastVertex + 400);
  }
  let bestIdx = -1;
  let bestKm = Infinity;
  for (let i = from; i < to; i++) {
    const d = haversineKm(geometry[i][1], geometry[i][0], fix.lat, fix.lon);
    if (d < bestKm) {
      bestKm = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return { vertex: bestIdx, progressM: cum[bestIdx], offRouteKm: bestKm };
}

/**
 * The bucket a progress position falls in.
 * @returns {{index: number, bucket: object}}
 */
export function bucketAt(profile, progressM) {
  const i = Math.min(Math.max(0, Math.floor(progressM / 1000)), profile.buckets.length - 1);
  return { index: i, bucket: profile.buckets[i] };
}

/**
 * Vertex index whose cumulative distance is nearest `metres` — used to
 * pick the sample point for the posted-limit lookahead.
 */
export function vertexAtM(profile, metres) {
  const { cum } = profile;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < metres) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ---------------- personal speed ratio ---------------- */

// "How much faster than the router's assumption do I actually drive?"
// A clamped EMA so one burst of speeding (or one traffic jam) can't
// swing the ETA wildly; samples below 25 km/h are ignored so creep,
// stops and parking lots don't pollute the calibration.
export const RATIO_MIN = 0.75;
export const RATIO_MAX = 1.25;
export const RATIO_ALPHA = 0.08; // ~12 steady samples to settle
export const RATIO_SAMPLE_MIN_KMH = 25;

/**
 * EMA update of the personal speed ratio. Pure — returns the new value.
 *
 * @param {number} ratio current ratio
 * @param {{speedKmh: number|null, refKmh: number|null}} sample
 * @returns {number} updated ratio
 */
export function updateSpeedRatio(ratio, { speedKmh, refKmh } = {}) {
  if (!Number.isFinite(speedKmh) || speedKmh < RATIO_SAMPLE_MIN_KMH) return ratio;
  if (!Number.isFinite(refKmh) || refKmh <= 5) return ratio;
  const sample = Math.max(RATIO_MIN, Math.min(RATIO_MAX, speedKmh / refKmh));
  return ratio + RATIO_ALPHA * (sample - ratio);
}

/**
 * Remaining seconds from `progressM`: live GPS speed on the current
 * partial km, incident delay added raw, and for future kms the learned
 * per-class speed when `predict` supplies one (see js/driver-profile.js)
 * — else the session's personal ratio applied to the router's own time.
 * Returns 0 when the position is at (or past) the end.
 *
 * @param {object} profile from buildKmProfile
 * @param {{progressM:number, speedKmh:number|null, ratio?:number,
 *   predict?:(refKmh:number, segKey?:string|null)=>number|null}} [opts]
 *   `predict` is consulted with each future bucket's reference speed
 *   and road-segment key; a learned speed (km/h) re-times that km,
 *   null falls through to the session ratio.
 */
export function remainingSeconds(profile, { progressM, speedKmh, ratio = 1, predict = null } = {}) {
  const { buckets, totalM } = profile;
  const p = Math.max(0, Math.min(progressM, totalM));
  if (p >= totalM) return 0;

  const bi = Math.min(Math.floor(p / 1000), buckets.length - 1);
  const cur = buckets[bi];
  const curLen = Math.max(1, cur.endM - cur.startM);
  const curFrac = (Math.min(cur.endM, totalM) - p) / curLen;

  let seconds = 0;
  // Current partial km: live speed when genuinely moving; otherwise
  // the router's share of it (a stop light doesn't tick the ETA down).
  const moving = Number.isFinite(speedKmh) && speedKmh >= 5;
  seconds += moving ? ((cur.endM - p) / 1000 / speedKmh) * 3600 : cur.freeFlowS * curFrac;
  seconds += cur.incidentS * curFrac;
  // Future kms: the learned per-limit speed when the driver profile has
  // one for that class, else the session ratio on the router's own
  // time. Incidents are added raw — stopped time doesn't shrink
  // because you drive faster between lights.
  for (let b = bi + 1; b < buckets.length; b++) {
    const bk = buckets[b];
    let freeFlow = bk.freeFlowS / ratio;
    if (predict && Number.isFinite(bk.impliedKmh) && bk.impliedKmh > 0) {
      const learned = predict(bk.impliedKmh, bk.segKey ?? null);
      // freeFlowS is the router's time at impliedKmh; scale it by
      // implied/learned to re-time the km at the driver's own pace.
      if (learned && learned > 5) freeFlow = (bk.freeFlowS * bk.impliedKmh) / learned;
    }
    seconds += freeFlow + bk.incidentS;
  }
  return seconds;
}
