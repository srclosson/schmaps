/**
 * Schmaps traffic — live incidents from provincial 511 services
 * (Ontario 511 via our proxy) plus a typical-congestion time model.
 */

import { TRAFFIC, CONGESTION, ALT_ROUTES } from './config.js';

/* ---------------- live incidents ---------------- */

/**
 * Fetch current traffic events from our server proxy.
 * @returns {Promise<Array<{lat:number,lon:number,severity:string,description:string,roadway:string,closure:boolean}>>}
 */
export async function fetchTrafficEvents() {
  if (!TRAFFIC.eventsUrl) return [];
  try {
    const res = await fetch(TRAFFIC.eventsUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return []; // traffic is best-effort; never block routing
  }
}

/**
 * Find events within the route corridor — but only events whose
 * schedule says they are active at `when`. Ontario 511 stretches
 * "Nightly Construction" windows across whole days and lists future
 * work weeks in advance; charging an afternoon drive for them made
 * ETAs ~20 minutes too slow.
 * @param {Array<[number,number]>} routeCoords [lon,lat] pairs
 * @param {Array} events
 * @param {Date} [when] departure time
 * @returns {Array} matched events, nearest-first
 */
export function eventsAlongRoute(routeCoords, events, when = new Date()) {
  const radiusKm = TRAFFIC.corridorKm;
  const matched = [];
  for (const ev of events) {
    if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) continue;
    if (!eventIsActive(ev, when)) continue;
    let best = Infinity;
    // Sample the route — every point on short routes, strided on long ones.
    const stride = Math.max(1, Math.floor(routeCoords.length / 400));
    for (let i = 0; i < routeCoords.length; i += stride) {
      const d = haversineKm(routeCoords[i][1], routeCoords[i][0], ev.lat, ev.lon);
      if (d < best) best = d;
      if (best <= radiusKm) break;
    }
    if (best <= radiusKm) matched.push({ ...ev, distanceKm: best });
  }
  return matched.sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Estimate extra delay (seconds) from matched incidents.
 */
export function incidentDelaySeconds(matched) {
  let seconds = 0;
  for (const ev of matched) {
    const key = ev.closure ? 'closure' : (ev.severity || 'unknown').toLowerCase();
    const minutes =
      TRAFFIC.delayMinutes[key] ?? TRAFFIC.delayMinutes.unknown;
    seconds += minutes * 60;
  }
  return seconds;
}

/**
 * Is the event actually happening at `when`?
 *
 * Events without schedule fields (older proxies, manual pins) count
 * as always active. "Nightly …" events only affect the overnight
 * hours — the feed stretches their window across whole days, but the
 * work runs roughly 19:00–06:00.
 * @param {object} ev normalized event, optional start/end (epoch seconds)
 * @param {Date} when
 */
function eventIsActive(ev, when) {
  const t = when.getTime();
  if (ev.start && t < ev.start * 1000) return false; // not yet started
  if (ev.end && t > ev.end * 1000) return false; // already finished
  if (/\bnightly\b/i.test(ev.description || '')) {
    const hour = when.getHours();
    if (hour >= 6 && hour < 19) return false; // daytime — work is overnight
  }
  return true;
}

/* ---------------- border crossing (USA detection) ---------------- */

let borderPromise = null;

/**
 * Load (and cache) the simplified Canada–US border polyline.
 * @returns {Promise<Array<[number,number]>>} [lon,lat] pairs
 */
export function loadBorder() {
  if (!borderPromise) {
    borderPromise = fetch(ALT_ROUTES.borderUrl)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []); // border data is best-effort; never block routing
  }
  return borderPromise;
}

/**
 * Do the segments [p1,p2] and [p3,p4] intersect?
 * @param {[number,number]} p1
 * @param {[number,number]} p2
 * @param {[number,number]} p3
 * @param {[number,number]} p4
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (d === 0) return false; // parallel or collinear — treat as no crossing
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Does the route cross into the USA? Geometric test — any route
 * segment intersecting any border segment. Latitude alone would
 * lie: Toronto (43.7°N) sits south of Point Pelee (41.9°N), and
 * both are solidly Canadian.
 * @param {Array<[number,number]>} routeCoords [lon,lat] pairs
 * @returns {Promise<boolean>}
 */
export async function crossesUsaBorder(routeCoords) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) return false;
  const border = await loadBorder();
  if (border.length < 2) return false;

  // Bounding-box pre-filter: if no border vertex is near the route,
  // no crossing is possible and we skip the full segment sweep.
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lon, lat] of routeCoords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const pad = 0.5; // degrees — generous margin for the simplified border
  const nearBorder = border.some(
    ([lon, lat]) =>
      lat >= minLat - pad &&
      lat <= maxLat + pad &&
      lon >= minLon - pad &&
      lon <= maxLon + pad
  );
  if (!nearBorder) return false;

  for (let i = 0; i + 1 < routeCoords.length; i++) {
    const a = routeCoords[i];
    const b = routeCoords[i + 1];
    for (let j = 0; j + 1 < border.length; j++) {
      if (segmentsIntersect(a, b, border[j], border[j + 1])) return true;
    }
  }
  return false;
}

/* ---------------- typical congestion model ---------------- */

/**
 * Multiplier on free-flow duration for typical traffic at departure time.
 * @param {[number,number]} midpoint [lon,lat] of the route
 * @param {Date} when departure time
 */
export function congestionFactor(midpoint, when = new Date()) {
  const hour = when.getHours() + when.getMinutes() / 60;
  const day = when.getDay();
  const weekend = day === 0 || day === 6;
  const depth = metroDepth(midpoint);

  let factor = 1;
  for (const [start, end, urbanF, ruralF] of CONGESTION.windows) {
    if (hour >= start && hour < end) {
      // Blend by how deep into a metro the point sits: full urban
      // factor in the core, fading to the rural factor at the edge.
      // A route like Perth → Kanata is rural for most of its length
      // and only brushes Ottawa's suburbs — charging it the full
      // urban factor made rush-hour ETAs ~15 min too slow.
      factor = ruralF + (urbanF - ruralF) * depth;
      break;
    }
  }
  if (weekend && factor > 1) {
    factor = 1 + (factor - 1) * CONGESTION.weekendScale;
  }
  return factor;
}

/**
 * How deep into a major metro a point sits: 1 in the core (within
 * half the metro radius), fading linearly to 0 at the radius edge,
 * and 0 outside every metro.
 * @param {[number,number]} midpoint [lon,lat]
 * @returns {number} 0..1
 */
function metroDepth([lon, lat]) {
  let depth = 0;
  for (const m of CONGESTION.metros) {
    const d = haversineKm(lat, lon, m.lat, m.lon);
    if (d < m.radiusKm) {
      const core = m.radiusKm / 2;
      const t = d <= core ? 1 : 1 - (d - core) / core;
      depth = Math.max(depth, t);
    }
  }
  return depth;
}

/* ---------------- per-segment congestion (3-colour line) ---------------- */

/**
 * Grade the route stretch by stretch: cut the polyline into
 * ~TRAFFIC.segmentKm pieces, sample typical congestion at each
 * midpoint, fold corridor incidents onto the stretch they land on,
 * and merge adjacent same-colour stretches into drawable runs.
 *
 * Each run carries the extra time it costs over free flow — that is
 * both the badge text ("+6 min") and, summed, the traffic delay in
 * the ETA.
 *
 * @param {Array<[number,number]>} routeCoords [lon,lat] pairs
 * @param {Array} matched incidents already filtered to the corridor
 * @param {Date} when departure time
 * @param {number} freeFlowSeconds OSRM duration, spread across stretches
 * @returns {{segments:Array, runs:Array}} runs are merged same-colour
 *   stretches: {coords, color, extraSeconds, factor, midpoint, lengthKm}
 */
export function segmentCongestion(
  routeCoords,
  matched = [],
  when = new Date(),
  freeFlowSeconds = 0
) {
  if (!Array.isArray(routeCoords) || routeCoords.length < 2) {
    return { segments: [], runs: [] };
  }

  // Length of every polyline leg, and the route total.
  const legKm = [];
  let totalKm = 0;
  for (let i = 0; i + 1 < routeCoords.length; i++) {
    const km = haversineKm(
      routeCoords[i][1],
      routeCoords[i][0],
      routeCoords[i + 1][1],
      routeCoords[i + 1][0]
    );
    legKm.push(km);
    totalKm += km;
  }
  if (totalKm === 0) return { segments: [], runs: [] };

  // Cut into ~segmentKm stretches at route vertices.
  const target = TRAFFIC.segmentKm;
  const segments = [];
  let startIdx = 0;
  let acc = 0;
  for (let i = 0; i < legKm.length; i++) {
    acc += legKm[i];
    if (acc >= target || i === legKm.length - 1) {
      segments.push({ startIdx, endIdx: i + 1, lengthKm: acc });
      startIdx = i + 1;
      acc = 0;
    }
  }
  // Merge a tiny trailing sliver into the previous stretch.
  const last = segments[segments.length - 1];
  if (segments.length > 1 && last.lengthKm < target * 0.4) {
    const prev = segments[segments.length - 2];
    prev.endIdx = last.endIdx;
    prev.lengthKm += last.lengthKm;
    segments.pop();
  }

  // Congestion factor at each stretch midpoint + its free-flow share.
  for (const seg of segments) {
    seg.midIdx = Math.floor((seg.startIdx + seg.endIdx) / 2);
    seg.factor = congestionFactor(routeCoords[seg.midIdx], when);
    seg.freeFlowSeconds =
      freeFlowSeconds > 0 ? (freeFlowSeconds * seg.lengthKm) / totalKm : 0;
    seg.delaySeconds = 0;
  }

  // Drop each corridor incident onto the stretch it lands on.
  for (const ev of matched) {
    if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) continue;
    const seg = segmentForIndex(segments, nearestRouteIndex(routeCoords, ev.lat, ev.lon));
    if (seg) seg.delaySeconds += incidentDelaySeconds([ev]);
  }

  // Colour: only genuinely bad stretches get highlighted. The default
  // route stays neutral blue; yellow is about half-speed driving and
  // red is an extreme slowdown. Incidents can still force a blip.
  for (const seg of segments) {
    const incidentFactor =
      seg.delaySeconds > 0 && seg.freeFlowSeconds > 0
        ? 1 + seg.delaySeconds / seg.freeFlowSeconds
        : 1;
    const effective = Math.max(seg.factor, incidentFactor);
    seg.effectiveFactor = effective;
    seg.color =
      effective >= TRAFFIC.thresholds.heavy
        ? TRAFFIC.colors.heavy
        : effective >= TRAFFIC.thresholds.moderate
          ? TRAFFIC.colors.moderate
          : TRAFFIC.colors.neutral;
    seg.extraSeconds = Math.round(
      (seg.factor - 1) * seg.freeFlowSeconds + seg.delaySeconds
    );
  }

  // Merge adjacent same-colour stretches into runs.
  const runs = [];
  for (const seg of segments) {
    const prev = runs[runs.length - 1];
    if (prev && prev.color === seg.color) {
      prev.endIdx = seg.endIdx;
      prev.lengthKm += seg.lengthKm;
      prev.extraSeconds += seg.extraSeconds;
      prev.factor = Math.max(prev.factor, seg.effectiveFactor);
    } else {
      runs.push({
        startIdx: seg.startIdx,
        endIdx: seg.endIdx,
        lengthKm: seg.lengthKm,
        extraSeconds: seg.extraSeconds,
        factor: seg.effectiveFactor,
        color: seg.color,
      });
    }
  }
  for (const run of runs) {
    run.midIdx = Math.floor((run.startIdx + run.endIdx) / 2);
    run.midpoint = routeCoords[run.midIdx];
    run.coords = routeCoords.slice(run.startIdx, run.endIdx + 1);
  }
  return { segments, runs };
}

/** Index of the route vertex nearest [lat,lon] (strided on long routes). */
function nearestRouteIndex(routeCoords, lat, lon) {
  let best = Infinity;
  let bestIdx = 0;
  const stride = Math.max(1, Math.floor(routeCoords.length / 400));
  for (let i = 0; i < routeCoords.length; i += stride) {
    const d = haversineKm(routeCoords[i][1], routeCoords[i][0], lat, lon);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** The stretch that owns route-vertex index `idx`. */
function segmentForIndex(segments, idx) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].endIdx <= idx) lo = mid + 1;
    else hi = mid;
  }
  return segments[lo];
}

/* ---------------- shared ---------------- */

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
