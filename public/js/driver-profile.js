/**
 * Schmaps driver speed profile — a two-tier, self-learning model of how
 * THIS driver actually drives, persisted across trips in localStorage.
 *
 * Storage: localStorage, not cookies. Cookies ride along with every
 * request to the server (which never needs this data), are capped at
 * ~4 KB, and are awkward for structured values; localStorage keeps the
 * driving style on the device — the same store the saved places and
 * OBD settings already use.
 *
 * Tiers (checked in order when predicting):
 *   segments — keyed by OSM node-pair segment IDs, sourced from OSRM's
 *     `nodes` annotation: road-identity learning, immune to GPS drift
 *     because the identity comes from the router's line-snapped
 *     geometry, not from raw fixes. This is the commuter tier — the
 *     roads you drive every week learn their own baselines.
 *   classes — keyed by posted/implied limit class (nearest 10 km/h):
 *     the generalization tier that warms instantly on roads you've
 *     never driven, since a driver who does 110 in 100-zones does it
 *     on any 100-zone.
 *
 * Shape (JSON):
 *   { classes:   { "100": { avg: 110.2, n: 1043, updatedAt: 1698… } },
 *     segments:  { "1514923906-14248726520": { avg, n, updatedAt } } }
 *
 * Learning: each tier keeps a streaming average + sample count, so
 * merges are lossless across trips — (avg·n + Σsamples)/(n + m) —
 * "110 over 1000 samples" plus ten more folds in exactly. Past
 * MAX_SAMPLES the average turns into a slow EMA, so a changed commute
 * gradually outweighs last year's habits instead of being outvoted
 * 5000-to-1. Entries carry `updatedAt`, and anything older than
 * MAX_AGE is pruned on load.
 *
 * Anomaly filtering (the traffic guard): samples below 45% of the
 * reference speed — gridlock, construction, a red-light crawl — never
 * touch a baseline; stretches flagged with a live incident (Ontario
 * 511) are skipped by the caller outright; samples above 150% of the
 * reference are discarded as GPS glitches. Traffic is a transient
 * event, not a structural change to how a road normally moves.
 *
 * Cold start: until MIN_SAMPLES (classes) / MIN_SEGMENT_SAMPLES
 * (segments) exist, predictions return null and the ETA falls down the
 * hierarchy — posted limit → router's implied speed → session ratio.
 * Predictions are clamped to a sane band around the reference: never
 * below 60% of it (traffic exists) nor above 130% (physics and police
 * exist).
 */

const STORAGE_KEY = 'schmaps-driver-speeds';
const MIN_SAMPLES = 10; // class tier — ≈ one traffic-light stretch of driving
const MIN_SEGMENT_SAMPLES = 15; // segment tier — ≈ a real traversal fragment
const MAX_SAMPLES = 5000;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // half a year without a visit → forgotten
const SAVE_INTERVAL_MS = 20 * 1000;
const CONGESTION_FLOOR_FRAC = 0.45; // < 45% of the limit = traffic, not habit
const GLITCH_CEILING_FRAC = 1.5; // > 150% of the limit = GPS glitch, not habit

/** Classify by nearest 10 km/h: 104 → 100, 55 → 60. */
const classOf = (kmh) => Math.round(kmh / 10) * 10;

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
  let model = null; // { classes: {...}, segments: {...} } — null until first read
  let saveTimer = null;

  const fresh = () => ({ classes: {}, segments: {} });

  /** Drop entries that haven't been driven in half a year. */
  const prune = (m, at) => {
    for (const tier of ['classes', 'segments']) {
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
          if (parsed.classes || parsed.segments) {
            // Current two-tier shape.
            for (const tier of ['classes', 'segments']) {
              const table = parsed[tier];
              if (!table || typeof table !== 'object') continue;
              for (const [k, v] of Object.entries(table)) {
                const avg = Number(v?.avg);
                const n = Number(v?.n);
                if (Number.isFinite(avg) && avg > 0 && Number.isFinite(n) && n > 0) {
                  model[tier][k] = { avg, n, updatedAt: Number(v.updatedAt) || now() };
                }
              }
            }
          } else {
            // v0.2.77 flat shape — the whole object was the class tier.
            for (const [k, v] of Object.entries(parsed)) {
              const avg = Number(v?.avg);
              const n = Number(v?.n);
              if (Number.isFinite(avg) && avg > 0 && Number.isFinite(n) && n > 0) {
                model.classes[k] = { avg, n, updatedAt: Number(v.updatedAt) || now() };
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

  /** Lossless streaming merge into one {avg, n, updatedAt} entry. */
  const fold = (entry, sample) => {
    if (entry.n < MAX_SAMPLES) {
      entry.avg = (entry.avg * entry.n + sample) / (entry.n + 1);
      entry.n += 1;
    } else {
      // Capped — a slow EMA so recent behaviour can still win.
      entry.avg += (sample - entry.avg) / MAX_SAMPLES;
    }
    entry.updatedAt = now();
  };

  return {
    /** Fold one observation into its limit class's baseline. */
    recordSample(refKmh, speedKmh) {
      if (!Number.isFinite(refKmh) || refKmh <= 0) return;
      if (!Number.isFinite(speedKmh) || speedKmh <= 0) return;
      if (!isHabit(refKmh, speedKmh)) return; // traffic / glitch — not a habit
      const k = String(classOf(refKmh));
      const cur = load().classes[k];
      if (cur) fold(cur, speedKmh);
      else load().classes[k] = { avg: speedKmh, n: 1, updatedAt: now() };
      scheduleSave();
    },

    /**
     * Fold one observation into a road segment's baseline. The key is
     * the OSM node-pair of the segment (OSRM `nodes` annotation);
     * refKmh supplies the traffic/glitch guard.
     */
    recordSegmentSample(segKey, speedKmh, refKmh) {
      if (typeof segKey !== 'string' || !segKey) return;
      if (!Number.isFinite(refKmh) || refKmh <= 0) return;
      if (!Number.isFinite(speedKmh) || speedKmh <= 0) return;
      if (!isHabit(refKmh, speedKmh)) return;
      const cur = load().segments[segKey];
      if (cur) fold(cur, speedKmh);
      else load().segments[segKey] = { avg: speedKmh, n: 1, updatedAt: now() };
      scheduleSave();
    },

    /**
     * The learned speed for a reference, two tiers deep: the road
     * segment's own baseline when there is one, else the limit class's.
     * Null until enough samples exist — no guesses from thin data.
     * Clamped to a sane band around the reference.
     */
    predictSpeed(refKmh, segKey = null) {
      if (!Number.isFinite(refKmh) || refKmh <= 0) return null;
      const m = load();
      const floor = Math.max(5, refKmh * 0.6);
      const ceiling = refKmh * 1.3;
      const clamp = (avg) => Math.max(floor, Math.min(avg, ceiling));
      // Tier 1 — this road segment's own baseline. A segment that
      // exists but is under-gated falls through, not out.
      const seg = typeof segKey === 'string' ? m.segments[segKey] : null;
      if (seg && seg.n >= MIN_SEGMENT_SAMPLES) return clamp(seg.avg);
      // Tier 2 — the limit class.
      const cls = m.classes[String(classOf(refKmh))];
      if (cls && cls.n >= MIN_SAMPLES) return clamp(cls.avg);
      return null;
    },

    /** Write the model now (pagehide) — throttled saves may lag. */
    flush() {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (model) save();
    },
  };
}
