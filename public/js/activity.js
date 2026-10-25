/**
 * Schmaps zero-config activity classifier — walking, running, cycling,
 * or driving, detected from signals the app already receives.
 *
 * No mode picker, no settings, no extra permissions:
 *
 *   1. OBD bridge presence — the killer disambiguator. If the ELM327
 *      feed (android-bridge/) is live, you're in a car. Zero
 *      ambiguity, zero battery cost. This settles the 90% case.
 *
 *   2. GPS speed signature — a rolling window of speed + |jerk|
 *      (acceleration change) separates the rest:
 *        walking   ~ 5 km/h, high relative variance, stop-and-go
 *        running    ~ 8-13 km/h, rhythmic oscillation
 *        cycling   ~ 15-35 km/h, smooth sustained speed, low jerk
 *        driving   ≥ 30 km/h sustained, or car-like acceleration
 *                   spikes (0→30 km/h in seconds)
 *      A car in gridlock still looks like a car: it has the OBD feed,
 *      and its acceleration spikes are car-like even at 4 km/h.
 *
 *   3. Route context — once a route is computed the profile is
 *      already known; detection only matters before/instead of it.
 *
 * Transitions require CONFIRM_WINDOWS sustained windows, so a
 * traffic-light stop never demotes a drive to "walking" and a
 * downhill burst on a bike never promotes it to "driving".
 *
 * The classifier is a pure state machine fed by the existing GPS fix
 * stream (`observe(speedKmh)` on every fix) plus the OBD poller
 * (`setObdLive(bool)`); `getActivity()` returns the current mode and
 * `osrmProfile()` maps it to the OSRM profile for routing.
 */

export const ACTIVITY = {
  WALKING: 'walking',
  RUNNING: 'running',
  CYCLING: 'cycling',
  DRIVING: 'driving',
  IDLE: 'idle',
  UNKNOWN: 'unknown',
};

/** OSRM profile per activity — foot covers walking AND running. */
const PROFILE_BY_ACTIVITY = {
  [ACTIVITY.WALKING]: 'foot',
  [ACTIVITY.RUNNING]: 'foot',
  [ACTIVITY.CYCLING]: 'bike',
  [ACTIVITY.DRIVING]: 'driving',
  [ACTIVITY.IDLE]: null, // not moving — keep the last confident mode
  [ACTIVITY.UNKNOWN]: null, // fall back to the caller's default
};

/** Sane ETA reference speeds (km/h) per activity — used when no
 *  posted limit applies (foot/bike routes carry none). */
export const REFERENCE_KMH = {
  [ACTIVITY.WALKING]: 5,
  [ACTIVITY.RUNNING]: 10,
  [ACTIVITY.CYCLING]: 20,
  [ACTIVITY.DRIVING]: 50,
};

const WINDOW_MS = 30 * 1000; // rolling window length
const CONFIRM_WINDOWS = 2; // sustained evidence before a transition
const IDLE_SPEED_KMH = 1.5; // below this = not moving
const MIN_SAMPLES = 3; // window needs ≥3 fixes to vote

/** Speed bands (km/h) — upper bounds, checked in order. */
const classifySpeed = (avgKmh, jerkKmhS) => {
  if (avgKmh <= 7) return ACTIVITY.WALKING;
  if (avgKmh <= 14) return ACTIVITY.RUNNING;
  // Cycling vs driving: sustained smooth speed = bike; spiky
  // acceleration or ≥35 km/h = car.
  if (avgKmh <= 35 && jerkKmhS < 1.5) return ACTIVITY.CYCLING;
  return ACTIVITY.DRIVING;
};

/**
 * Create the classifier. Pure state, no timers — it only advances
 * when the caller feeds it fixes.
 *
 * `pin()` is the explicit override — a "walk to X" / "bike to X" /
 * "fastest route to X" verb in the query. A pin beats EVERYTHING: the
 * OBD bridge and the GPS signature alike, until `clearPin()`.
 *
 * @returns {{
 *   observe(speedKmh:number|null, atMs?:number):void,
 *   setObdLive(live:boolean):void,
 *   pin(mode:string):void,
 *   clearPin():void,
 *   getActivity():(typeof ACTIVITY[keyof typeof ACTIVITY]),
 *   osrmProfile():(string|null),
 *   referenceKmh():(number|null),
 * }}
 */
export function createActivityClassifier() {
  let pinned = null; // explicit verb override — beats OBD and GPS
  let obdLive = false;
  let current = ACTIVITY.UNKNOWN;
  let lastConfident = ACTIVITY.UNKNOWN;
  let pending = null; // {mode, count} — the transition candidate
  const window = []; // [{at, kmh}] — rolling WINDOW_MS of fixes
  let prevKmh = null; // for jerk

  /** Mean speed and mean |jerk| (km/h per s) over the window. */
  const stats = () => {
    if (window.length < MIN_SAMPLES) return null;
    let sum = 0;
    let jerkSum = 0;
    let jerkN = 0;
    let prev = null;
    for (const s of window) {
      sum += s.kmh;
      if (prev !== null && s.kmh !== null) {
        const dt = (s.at - prev.at) / 1000;
        if (dt > 0 && dt < 10) {
          jerkSum += Math.abs((s.kmh - prev.kmh) / dt);
          jerkN++;
        }
      }
      prev = s;
    }
    return { avgKmh: sum / window.length, jerkKmhS: jerkN ? jerkSum / jerkN : 0 };
  };

  /** Sustained-evidence transition: CONFIRM_WINDOWS consecutive
   *  windows voting the same mode before we commit. */
  const propose = (mode) => {
    if (mode === current) {
      pending = null;
      return;
    }
    if (pending && pending.mode === mode) {
      pending.count++;
      if (pending.count >= CONFIRM_WINDOWS) {
        current = mode;
        pending = null;
        if (mode !== ACTIVITY.IDLE && mode !== ACTIVITY.UNKNOWN) {
          lastConfident = mode;
        }
      }
    } else {
      pending = { mode, count: 1 };
    }
  };

  return {
    /** Feed one GPS fix's speed (km/h, null when unknown). */
    observe(speedKmh, atMs = Date.now()) {
      const kmh =
        Number.isFinite(speedKmh) && speedKmh >= 0 ? speedKmh : null;
      window.push({ at: atMs, kmh });
      while (window.length > 1 && atMs - window[0].at > WINDOW_MS) {
        window.shift();
      }
      // A pin wins outright — the user said the mode, they meant it.
      if (pinned) {
        current = pinned;
        lastConfident = pinned;
        pending = null;
        prevKmh = kmh;
        return;
      }
      // OBD wins over GPS — no heuristics can outvote the car.
      if (obdLive) {
        current = ACTIVITY.DRIVING;
        lastConfident = ACTIVITY.DRIVING;
        pending = null;
        prevKmh = kmh;
        return;
      }
      const st = stats();
      if (!st) {
        prevKmh = kmh;
        return;
      }
      if (st.avgKmh < IDLE_SPEED_KMH) {
        // Not moving: keep the last confident mode (a red light
        // doesn't turn a drive into a walk).
        current = ACTIVITY.IDLE;
        pending = null;
      } else {
        propose(classifySpeed(st.avgKmh, st.jerkKmhS));
      }
      prevKmh = kmh;
    },

    /** The OBD poller reports bridge liveness each cycle. */
    setObdLive(live) {
      obdLive = !!live;
      if (obdLive && !pinned) {
        current = ACTIVITY.DRIVING;
        lastConfident = ACTIVITY.DRIVING;
        pending = null;
      }
    },

    /**
     * Pin an explicit travel mode ("walk to X", "bike to X",
     * "fastest route to X") — beats the OBD bridge AND the GPS
     * signature until clearPin().
     */
    pin(mode) {
      if (!mode || !REFERENCE_KMH[mode]) return;
      pinned = mode;
      current = mode;
      lastConfident = mode;
      pending = null;
    },

    /** Drop the explicit-mode pin — the classifier takes over again. */
    clearPin() {
      pinned = null;
    },

    /** Current activity — IDLE keeps the last confident mode in
     *  `lastConfident` for callers that need a travel mode. */
    getActivity() {
      return current;
    },

    /** The OSRM profile for routing; null → caller's default. */
    osrmProfile() {
      const mode =
        current === ACTIVITY.IDLE || current === ACTIVITY.UNKNOWN
          ? lastConfident
          : current;
      return PROFILE_BY_ACTIVITY[mode] ?? null;
    },

    /** A sane ETA reference speed for the current mode; null when
     *  unknown (caller falls back to the router's implied speed). */
    referenceKmh() {
      const mode =
        current === ACTIVITY.IDLE || current === ACTIVITY.UNKNOWN
          ? lastConfident
          : current;
      return REFERENCE_KMH[mode] ?? null;
    },
  };
}