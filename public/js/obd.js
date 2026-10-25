/**
 * Schmaps OBD-II gauges — live car data over the map.
 *
 * Transport: the Schmaps OBD bridge app (android-bridge/) holds the
 * classic-Bluetooth ELM327 connection and re-serves the feed on
 * http://127.0.0.1:8080/obd.json — the one non-HTTPS target an HTTPS
 * page may fetch, because 127.0.0.1 is a "potentially trustworthy
 * origin". The transport is a thin, swappable layer: a future BLE
 * (Web Bluetooth) transport or a Torque-upload relay can feed the
 * same gauges without touching any UI code.
 *
 * Gauges:
 *   RPM        — live, PID 0x0C.
 *   km to empty — fuel rate (PID 0x5E) × tank size; falls back to a
 *                configured L/100 km on pre-2008 cars without 0x5E.
 *   Oil change  — an honest km countdown: no standard PID exists for
 *                oil life, so the user sets the interval and the app
 *                counts down using the bridge's speed feed.
 *
 * Everything degrades silently: no bridge, no gauges — the strip
 * stays hidden and schmaps works exactly as before.
 */

import { OBD } from './config.js';

/* ---------------- settings (localStorage) ---------------- */

const SETTINGS_KEY = 'schmaps-obd-settings';

/**
 * User car settings. Defaults live in config.js; anything the user
 * saves here wins. `oilStartKm` is the odometer reading (km) at the
 * last oil change — the countdown is interval − (odo − oilStartKm).
 */
export function loadObdSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* corrupted entry — fall through to defaults */
  }
  return null;
}

export function saveObdSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

/* ---------------- transport ---------------- */

/**
 * Bridge transport — polls the loopback HTTP server. `fetcher` is
 * injectable so tests can feed canned responses.
 */
export function createBridgeTransport({ url = OBD.bridgeUrl, fetcher = fetch } = {}) {
  let lastGood = 0;

  return {
    /**
     * One poll. Resolves the parsed feed, or null when the bridge is
     * unreachable (not installed, stopped, Bluetooth down). Never
     * throws — a missing bridge is a normal state, not an error.
     */
    async poll() {
      try {
        const res = await fetcher(url, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && typeof data === 'object') {
          lastGood = Date.now();
          return { ...data, at: lastGood };
        }
        return null;
      } catch {
        return null; // connection refused = bridge not running
      }
    },
    /** ms since the last successful poll — gauges dim past staleMs. */
    msSinceGood() {
      return lastGood ? Date.now() - lastGood : Infinity;
    },
  };
}

/* ---------------- gauge math ---------------- */

/**
 * Compute the gauge values from one bridge snapshot.
 *
 * @param {object} feed   Bridge snapshot {rpm, speedKmh, coolantC,
 *                        fuelRateLh, connected, at}.
 * @param {object} settings User car settings {tankL, lper100,
 *                        oilIntervalKm, oilStartKm, odoKm}.
 * @returns {object|null} Gauge values, or null when the feed is dead.
 */
export function computeGauges(feed, settings) {
  if (!feed || !feed.connected) return null;

  const gauges = {
    rpm: Number.isFinite(feed.rpm) ? feed.rpm : null,
    speedKmh: Number.isFinite(feed.speedKmh) ? feed.speedKmh : null,
    coolantC: Number.isFinite(feed.coolantC) ? feed.coolantC : null,
    kmToEmpty: null,
    oilKmLeft: null,
    at: feed.at,
  };

  // km till empty: prefer the live fuel rate; fall back to the
  // configured economy figure when the car lacks PID 0x5E.
  const tankL = Number(settings?.tankL);
  if (Number.isFinite(tankL) && tankL > 0) {
    if (Number.isFinite(feed.fuelRateLh) && feed.fuelRateLh > 0) {
      const kmh = Number.isFinite(feed.speedKmh) ? feed.speedKmh : 0;
      const litresPerKm = feed.fuelRateLh / Math.max(kmh, 1); // L per km
      gauges.kmToEmpty = Math.round(tankL / litresPerKm);
    } else {
      const lper100 = Number(settings?.lper100);
      if (Number.isFinite(lper100) && lper100 > 0) {
        gauges.kmToEmpty = Math.round((tankL / lper100) * 100);
      }
    }
  }

  // Oil countdown: interval − distance driven since the change.
  const interval = Number(settings?.oilIntervalKm);
  const odo = Number(settings?.odoKm);
  const start = Number(settings?.oilStartKm);
  if (Number.isFinite(interval) && Number.isFinite(odo) && Number.isFinite(start)) {
    gauges.oilKmLeft = Math.round(interval - (odo - start));
  }

  return gauges;
}

/**
 * Advance the odometer with the bridge's speed feed — the oil
 * countdown ticks down as you drive, even though the car reports no
 * odometer PID. Returns the updated settings object (or the input
 * when nothing changed).
 */
export function advanceOdometer(settings, feed, prevFeed) {
  if (!settings || !feed || !feed.connected) return settings;
  const speed = Number(feed.speedKmh);
  const prevAt = prevFeed?.at;
  if (!Number.isFinite(speed) || !prevAt || !feed.at) return settings;

  const hours = (feed.at - prevAt) / 3_600_000;
  if (hours <= 0 || hours > 1) return settings; // clock jump guard
  const km = speed * hours;
  if (km <= 0) return settings;

  const odo = Number(settings.odoKm);
  if (!Number.isFinite(odo)) return settings;
  return { ...settings, odoKm: odo + km };
}

/* ---------------- formatting ---------------- */

/** "1 234" — thousands separated with a thin space, gauge-friendly. */
export function formatKm(km) {
  if (!Number.isFinite(km)) return '—';
  return Math.round(km).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** "2 145" for RPM, "—" when the feed has no value. */
export function formatRpm(rpm) {
  if (!Number.isFinite(rpm)) return '—';
  return formatKm(rpm);
}

/** "88°" coolant, "—" when missing. */
export function formatCoolant(c) {
  if (!Number.isFinite(c)) return '—';
  return `${Math.round(c)}°`;
}