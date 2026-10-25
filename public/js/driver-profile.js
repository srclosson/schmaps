/**
 * Schmaps driver speed profile — speed-limit buckets, self-learning,
 * persisted across trips in localStorage.
 *
 * Storage: localStorage, not cookies. Cookies ride along with every
 * request to the server (which never needs this data), are capped at
 * ~4 KB, and are awkward for structured values; localStorage keeps the
 * driving style on the device — the same store the saved places and
 * OBD settings already use.
 *
 * Buckets, not road classes: routes and segments are categorized by
 * their POSTED SPEED LIMIT (bucketed to the nearest 10 km/h: 50, 80,
 * 100, 110…), never by OSM highway tags. Road classifications differ
 * between regions (Ontario vs. Alberta), but driving behaviour
 * relative to the posted limit stays consistent — a driver who does
 * 104 in a 100-zone does it on any 100-zone, anywhere.
 *
 * Tiers (checked in order when predicting):
 *   segments — keyed by OSM node-pair segment IDs, sourced from OSRM's
 *     `nodes` annotation. An override is kept ONLY when a specific
 *     road segment persistently deviates from its speed bucket's
 *     aggregate scalar AND has a high sample count (> 3). This is the
 *     commuter tier — the roads you drive every week learn their own
 *     multipliers.
 *   buckets — keyed by posted limit bucket: a global driver scalar
 *     (multiplier) per bucket. Predicted speed = posted limit × scalar.
 *     Example: a 100 km/h bucket with a learned scalar of 1.04 predicts
 *     104 km/h on any unvisited 100 km/h road.
 *
 * Lean schema (a tiny lookup map, well under the 5 MB localStorage
 * cap — one small object per bucket, one per deviant segment):
 *   { buckets:  { "100": { scalar: 1.04, samples: 310, updatedAt: … } },
 *     segments: { "1514923906-14248726520": { scalar, samples, refKmh, updatedAt } } }
 *
 * Learning: each tier keeps a streaming average of scalars + sample
 * count, so merges are lossless across trips — (scalar·n + Σnew)/
 * (n + m). Past MAX_SAMPLES the average turns into a slow EMA, so a
 * changed commute gradually outweighs last year's habits. Entries
 * carry `updatedAt`, and anything older than MAX_AGE is pruned on load.
 *
 * Anomaly filtering (the traffic guard): samples below 45% of the
 * reference speed — gridlock, construction, a red-light crawl — never
 * touch a baseline; stretches flagged with a live incident (Ontario
 * 511) are skipped by the caller outright; samples above 150% of the
 * reference are discarded as GPS glitches. Traffic is a transient
 * event, not a structural change to how a road normally moves.
 *
 * Fallback hierarchy for ETAs (per segment):
 *   1. Segment-specific override (heavily traveled, deviant, n > 3),
 *   2. Speed-limit bucket scalar × posted limit,
 *   3. Raw posted limit — predictSpeed returns null and the caller
 *      (js/eta.js) falls through to the session ratio on the router's
 *      own timing, which is anchored to the posted/implied limit.
 *
 * Cold start: until MIN_SAMPLES (buckets) exist, predictions return
 * null and the ETA falls down that hierarchy. Scalars are clamped to a
 * sane band: never below 60% of the limit (traffic exists) nor above
 * 130% (physics and police exist).
 */

const STORAGE_KEY = 'schmaps-driver-speeds';
const MIN_SAMPLES = 10; // bucket tier — ≈ one traffic-light stretch of driving
const MIN_SEGMENT_SAMPLES = 4; // segment override tier — "high sample count (> 3)"
const SEGMENT_DEVIANCE = 0.1; // ±10% off the bucket scalar → worth an override
const MAX_SAMPLES = 5000;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // half a year without a visit → forgotten
const SAVE_INTERVAL_MS = 20 * 1000;
const CONGESTION_FLOOR_FRAC = 0.45; // < 45% of the limit = traffic, not habit
const GLITCH_CEILING_FRAC = 1.5; // > 150% of the limit = GPS glitch, not habit
const SCALAR_MIN = 0.6; // never predict below 60% of the posted limit
const SCALAR_MAX = 1.3; // never predict above 130% of it

/** Bucket by nearest 10 km/h posted limit: 104 → 100, 55 → 60. */
const bucketOf = (kmh) => Math.round(kmh / 10) * 10;

const defaultStorage = () =>
  typeof localStorage !== 'undefined' ? localStorage : null;

const now = () => Date.now();

/**
 * Create a profile bound to a storage backend (defaults to real
 * localStorage; tests pass a shim). The persisted model loads lazily,
 * writes are throttled to SAVE_INTERVAL_MS, and flush() writes at once
 * (pagehide).
 *
 * @returns {{recordSample(refKmh:number, speedKmh:number):void,
 *            recordSegmentSample(segKey:string, speedKmh:number, refKmh:number):void,
 *            predictSpeed(refKmh:number, segKey?:string|null):(number|null),
 *            flush():void}}
 */
export function createDriverProfile(storage = defaultStorage()) {
  let model = null; // { buckets: {...}, segments: {...} } — null until first read
  let saveTimer = null;

  const fresh = () => ({ buckets: {}, segments: {} });

  /** Drop entries that haven't been driven in half a year. */
  const prune = (m, at) => {
    for (const tier of ['buckets', 'segments']) {
      const table = m[tier];
      if (!table) continue;
      for (const [k, v] of Object.entries(table)) {
        if (!Number.isFinite(v?.updatedAt) || at - v.updatedAt > MAX_AGE_MS) {
          delete table[k];
        }
      }
    }
  };

  const load = () => {
    if (model) return model;
    model = fresh();
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.buckets || parsed.segments) {
            // Current bucket-scalar shape.
            for (const tier of ['buckets', 'segments']) {
              const table = parsed[tier];
              if (!table || typeof table !== 'object') continue;
              for (const [k, v] of Object.entries(table)) {
                const scalar = Number(v?.scalar);
                const n = Number(v?.samples ?? v?.n);
                if (Number.isFinite(scalar) && scalar > 0 && Number.isFinite(n) && n > 0) {
                  model[tier][k] = {
                    scalar,
                    samples: n,
                    refKmh: Number.isFinite(Number(v?.refKmh)) ? Number(v.refKmh) : undefined,
                    updatedAt: Number(v.updatedAt) || now(),
                  };
                  if (model[tier][k].refKmh === undefined) delete model[tier][k].refKmh;
                }
              }
            }
          } else if (parsed.classes) {
            // v0.2.78 two-tier avg shape — migrate each class average to
            // a bucket scalar (avg / bucket key) so old habits carry over.
            for (const [k, v] of Object.entries(parsed.classes)) {
              const avg = Number(v?.avg);
              const n = Number(v?.n);
              const key = Number(k);
              if (
                Number.isFinite(avg) && avg > 0 &&
                Number.isFinite(n) && n > 0 &&
                Number.isFinite(key) && key > 0
              ) {
                model.buckets[String(bucketOf(key))] = {
                  scalar: avg / bucketOf(key),
                  samples: n,
                  updatedAt: Number(v.updatedAt) || now(),
                };
              }
            }
          } else {
            // v0.2.77 flat shape — the whole object was the class tier.
            for (const [k, v] of Object.entries(parsed)) {
              const avg = Number(v?.avg);
              const n = Number(v?.n);
              const key = Number(k);
              if (
                Number.isFinite(avg) && avg > 0 &&
                Number.isFinite(n) && n > 0 &&
                Number.isFinite(key) && key > 0
              ) {
                model.buckets[String(bucketOf(key))] = {
                  scalar: avg / bucketOf(key),
                  samples: n,
                  updatedAt: Number(v.updatedAt) || now(),
                };
              }
            }
          }
          prune(model, now());
        }
      }
    } catch {
      /* corrupt store — start fresh */
    }
    return model;
  };

  const save = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(model));
    } catch {
      /* quota exceeded / private mode — keep the in-memory model */
    }
  };

  const scheduleSave = () => {
    if (saveTimer !== null || !storage) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, SAVE_INTERVAL_MS);
  };

  /**
   * Traffic/glitch guard: is this sample a habit, or an event? Samples
   * far below the reference are congestion; far above, GPS noise.
   * Neither should move a baseline.
   */
  const isHabit = (refKmh, speedKmh) =>
    speedKmh >= refKmh * CONGESTION_FLOOR_FRAC &&
    speedKmh <= refKmh * GLITCH_CEILING_FRAC;

  /** The observed scalar, clamped to the sane band around the limit. */
  const scalarOf = (refKmh, speedKmh) =>
    Math.max(SCALAR_MIN, Math.min(SCALAR_MAX, speedKmh / refKmh));

  /** Lossless streaming merge of one scalar into a bucket entry. */
  const fold = (entry, scalar) => {
    if (entry.samples < MAX_SAMPLES) {
      entry.scalar = (entry.scalar * entry.samples + scalar) / (entry.samples + 1);
      entry.samples += 1;
    } else {
      // Capped — a slow EMA so recent behaviour can still win.
      entry.scalar += (scalar - entry.scalar) / MAX_SAMPLES;
    }
    entry.updatedAt = now();
  };

  /**
   * Segment overrides are lean by design: an entry survives only while
   * it persistently deviates from its bucket's aggregate scalar with a
   * high sample count. A segment that converges onto its bucket (or
   * never had enough samples) is dropped — the bucket scalar covers it.
   */
  const maybeKeepSegment = (m, segKey) => {
    const seg = m.segments[segKey];
    if (!seg) return;
    const bkt = m.buckets[String(bucketOf(seg.refKmh))];
    const deviant = bkt
      ? Math.abs(seg.scalar - bkt.scalar) > SEGMENT_DEVIANCE
      : true; // no bucket data yet — the segment is all we have
    if (seg.samples <= MIN_SEGMENT_SAMPLES || !deviant) delete m.segments[segKey];
  };

  return {
    /**
     * Fold one observation into its speed-limit bucket's scalar. The
     * reference is the posted limit (or the router's implied speed
     * until Overpass stamps the real one in).
     */
    recordSample(refKmh, speedKmh) {
      if (!Number.isFinite(refKmh) || refKmh <= 0) return;
      if (!Number.isFinite(speedKmh) || speedKmh <= 0) return;
      if (!isHabit(refKmh, speedKmh)) return; // traffic / glitch — not a habit
      const k = String(bucketOf(refKmh));
      const cur = load().buckets[k];
      if (cur) fold(cur, scalarOf(refKmh, speedKmh));
      else load().buckets[k] = { scalar: scalarOf(refKmh, speedKmh), samples: 1, updatedAt: now() };
      scheduleSave();
    },

    /**
     * Fold one observation into a road segment's scalar. The key is
     * the OSM node-pair of the segment (OSRM `nodes` annotation);
     * refKmh supplies the traffic/glitch guard and the bucket to
     * compare deviance against. Entries that converge onto their
     * bucket (or stay under the sample gate) are pruned on the next
     * load — storage stays a tiny lookup map, not a road census.
     */
    recordSegmentSample(segKey, speedKmh, refKmh) {
      if (typeof segKey !== 'string' || !segKey) return;
      if (!Number.isFinite(refKmh) || refKmh <= 0) return;
      if (!Number.isFinite(speedKmh) || speedKmh <= 0) return;
      if (!isHabit(refKmh, speedKmh)) return;
      const m = load();
      const cur = m.segments[segKey];
      if (cur) fold(cur, scalarOf(refKmh, speedKmh));
      else m.segments[segKey] = { scalar: scalarOf(refKmh, speedKmh), samples: 1, refKmh, updatedAt: now() };
      scheduleSave();
    },

    /**
     * The learned speed for a posted limit, down the fallback
     * hierarchy:
     *   1. segment override — a heavily-traveled road segment that
     *      persistently deviates from its bucket (samples > 3),
     *   2. speed-limit bucket scalar × posted limit,
     *   3. null — no bucket data yet; the caller falls through to the
     *      raw posted/implied limit (session ratio in js/eta.js).
     */
    predictSpeed(refKmh, segKey = null) {
      if (!Number.isFinite(refKmh) || refKmh <= 0) return null;
      const m = load();
      // Tier 1 — this road segment's own override. A segment that
      // exists but is under-gated falls through, not out.
      const seg = typeof segKey === 'string' ? m.segments[segKey] : null;
      if (seg && seg.samples > MIN_SEGMENT_SAMPLES) {
        return Math.max(5, seg.scalar * refKmh);
      }
      // Tier 2 — the speed-limit bucket scalar × posted limit.
      const bkt = m.buckets[String(bucketOf(refKmh))];
      if (bkt && bkt.samples >= MIN_SAMPLES) {
        return Math.max(5, bkt.scalar * refKmh);
      }
      return null;
    },

    /** Write the model now (pagehide) — throttled saves may lag. */
    flush() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (model) {
        // Final lean pass: drop converged / thin segment entries.
        for (const k of Object.keys(model.segments)) maybeKeepSegment(model, k);
        save();
      }
    },
  };
}
