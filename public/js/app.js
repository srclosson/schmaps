/**
 * Schmaps — main application.
 * Voice/typeahead → saved places → geocode chain (geocoder.ca →
 * Nominatim → Photon) → route (OSRM) → traffic-adjusted ETA.
 */

import { MAP, TRAFFIC, ALT_ROUTES, GPS, OBD } from './config.js';
import { geocodeAddress } from './geocode.js';
import { geocodeChain, geocodePhoton, isAddressQuery, reverseGeocode } from './geocoders.js';
import { searchPOI, searchCategoryPOI, fetchPostedLimits } from './poi.js';
import { categoryFor } from './categories.js';
import { openingStatus } from './hours.js';
import { computeRoute, trafficAdjust, formatDistance, formatDuration, formatTime } from './routing.js';
import {
  buildKmProfile,
  progressAt,
  bucketAt,
  updateSpeedRatio,
  remainingSeconds,
  vertexAtM,
  RATIO_SAMPLE_MIN_KMH,
} from './eta.js';
import { createDriverProfile } from './driver-profile.js';
import { isErrandsQuery, parseErrands, refreshErrands, runErrands } from './errands.js';
import { isVoiceSupported, listenOnce, speak, isMuted, setMuted } from './voice.js';
import { suggestPlaces, normalizeName, loadPlaces } from './places.js';
import {
  findSavedPlace,
  getSavedPlaces,
  getTrips,
  placesWithTag,
  recordTrip,
  savePlace,
  stripTravelWords,
} from './places-store.js';
import { haversineKm } from './traffic.js';
import {
  advanceOdometer,
  computeGauges,
  createBridgeTransport,
  formatCoolant,
  formatKm,
  formatRpm,
  loadObdSettings,
  saveObdSettings,
} from './obd.js';

// Driver behaviour model — a global driver scalar (multiplier) per
// speed-limit bucket, persisted in localStorage across trips (see
// js/driver-profile.js). Feeds the per-km ETA's future-bucket timing;
// flushed on pagehide so learned
// samples survive a closed tab.
const driverProfile = createDriverProfile();
window.addEventListener('pagehide', () => driverProfile.flush());

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const els = {
  map: $('map'),
  searchForm: $('search-form'),
  searchInput: $('search-input'),
  micBtn: $('mic-btn'),
  voiceToggle: $('voice-toggle'),
  installBtn: $('install-btn'),
  breadcrumbBtn: $('breadcrumb-btn'),
  breadcrumbMenu: $('breadcrumb-menu'),
  suggestBar: $('suggest-bar'),
  suggestLabel: $('suggest-label'),
  suggestChips: $('suggest-chips'),
  status: $('status'),
  panel: $('route-panel'),
  closeBtn: $('close-route-btn'),
  startRouteBtn: $('start-route-btn'),
  statDistance: $('stat-distance'),
  statDuration: $('stat-duration'),
  statEta: $('stat-eta'),
  errandsList: $('errands-list'),
  turnBanner: $('turn-banner'),
  turnIcon: $('turn-icon'),
  turnInstruction: $('turn-instruction'),
  turnDistance: $('turn-distance'),
  turnLanes: $('turn-lanes'),
  currentSpeed: $('current-speed'),
  speedLimit: $('speed-limit'),
  updateBar: $('update-bar'),
  updateBtn: $('update-btn'),
  updateDismiss: $('update-dismiss'),
  autocomplete: $('autocomplete'),
  saveRow: $('save-row'),
  saveName: $('save-name'),
  saveTags: $('save-tags'),
  saveBtn: $('save-btn'),
  saveCancel: $('save-cancel'),
  altChips: $('alt-chips'),
  usaBanner: $('usa-banner'),
  quickerCard: $('quicker-card'),
  quickerText: $('quicker-text'),
  quickerAccept: $('quicker-accept'),
  quickerDismiss: $('quicker-dismiss'),
  backToLoc: $('back-to-loc'),
  searchAreaBtn: $('search-area-btn'),
  obdStrip: $('obd-strip'),
  gaugeRpm: $('gauge-rpm'),
  gaugeRange: $('gauge-range'),
  gaugeOil: $('gauge-oil'),
  gaugeCoolant: $('gauge-coolant'),
  obdSettingsBtn: $('obd-settings-btn'),
  obdSettings: $('obd-settings'),
  obdTank: $('obd-tank'),
  obdEconomy: $('obd-economy'),
  obdOilInterval: $('obd-oil-interval'),
  obdOdo: $('obd-odo'),
  obdOilStart: $('obd-oil-start'),
  obdSave: $('obd-save'),
  obdClose: $('obd-close'),
};

/* ---------------- state ---------------- */

const state = {
  origin: null, // {lat, lon}
  destination: null, // {lat, lon, label}
  route: null, // RouteResult (or an errands result — same shape)
  errands: null, // active errands run, if any
  navigating: false,
  following: true, // GPS auto-follow — paused by user map gestures
  watchId: null,
  destMarker: null,
  stopMarkers: [], // numbered errands stops
  incidentMarkers: [],
  lastFix: null, // latest GPS fix {lat, lon, at} — reroute + ETA origin
  refreshTimer: null, // slow 511-events refresh interval (no periodic re-route)
  kmProfile: null, // per-km ETA buckets for the active route (js/eta.js)
  speedRatio: 1, // personal speed factor vs the router's assumption (EMA, clamped)
  lastProgressM: 0, // metres covered along the route — monotonic ETA anchor
  progressVertex: 0, // geometry vertex at the progress anchor — greys the driven line
  offRouteStreak: 0, // consecutive fixes > REROUTE_OFF_METERS from the line
  lastRerouteAt: 0, // ms of the last off-route reroute — paces retries
  limitsFetchedUpTo: -1, // km bucket through which posted limits are known
  lastSpokenEta: null, // ETA (ms) last spoken — shift detector baseline
  navFirstFix: null, // first GPS fix of this navigation — movement baseline
  dropPin: null, // tapped-map pin awaiting "Navigate here"
  dropPopup: null, // its "Navigate here" popup — removed with the pin
  poiMarkers: [], // category-browse pins, coloured by open/closed status
  poiSearch: null, // active browse { cat, origin, radiusM } — powers "Search this area"
  alternatives: [], // other routes from the last compute — chips + gray lines
  routePreference: null, // the user's chip choice — survives reroutes
  choiceMarkers: [], // on-map badges (selected / fastest / fastest / eco / USA / Canada-via) — one per route
  badgeMarkers: [], // "+min" slowdown pills on the coloured line
  usaWarned: false, // one voice warning per route about USA crossings
  quickerRoute: null, // pending "Quicker route" offer {route, savingsSeconds, key}
  spokenQuickerKey: null, // quicker offer already spoken for this route
  dismissedQuickerKey: null, // quicker offer the user rejected
  turnSpoken: null, // key of the maneuver already spoken (avoid repeats)
  currentSpeedKmh: null,
  speedLimitBand: null, // 'ok' | 'warn' | 'over' | 'idle' -- remembered across ticks for hysteresis (Spec 10.9)
  centeredOnFirstFix: false,
  gpsLocked: false,
};

/* ---------------- status ---------------- */

let statusTimer = null;
function showStatus(text, { sticky = false } = {}) {
  els.status.textContent = text;
  els.status.hidden = false;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => (els.status.hidden = true), 4000);
}
/* Spec §1: no persistent recenter button — the viewport auto-follows by
   default and the contextual Recenter (Slot 2) is state-bound. */
function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

/* ---------------- map ---------------- */

const map = new maplibregl.Map({
  container: els.map,
  style: MAP.style,
  center: MAP.center,
  zoom: MAP.zoom,
  // Spec §3 — a 45° pitch tilts the camera into a turn-by-turn view,
  // the same shape HERE WeGo's navigation uses. Pairs with the
  // bearing follow-on (cursor stays true-north in the screen).
  pitch: 45,
  maxBounds: MAP.maxBounds,
  attributionControl: false,
});

// User gestures pause the GPS auto-follow: dragging, zooming, or
// rotating the map means "let me look around", and a "Back to
// location" pill appears (see pauseFollow/resumeFollow below).
// Programmatic camera moves — our fitBounds and follow easeTo —
// carry no originalEvent, so they never trip this.
for (const gesture of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
  map.on(gesture, (e) => {
    if (e.originalEvent) pauseFollow();
  });
}

/* A style that never loads renders as a silent grey screen — the worst
   failure mode because nothing explains itself. This watchdog surfaces
   it and retries once with a cache-buster (the style response carries
   Cache-Control max-age=86400, so a plain retry would just re-hit the
   same cached failure), then says so honestly if the retry fails too. */
let styleRetryCount = 0;
const styleWatchdog = setInterval(() => {
  if (map.isStyleLoaded?.()) {
    clearInterval(styleWatchdog);
    if (styleRetryCount > 0) hideStatus();
    return;
  }
  styleRetryCount++;
  if (styleRetryCount === 1) {
    showStatus('Map is slow to load — retrying…', { sticky: true });
    const base = MAP.style.replace(/[?&]retry=\d+/g, '');
    const sep = base.includes('?') ? '&' : '?';
    map.setStyle(`${base}${sep}retry=${Date.now()}`, { diff: false });
  } else {
    clearInterval(styleWatchdog);
    showStatus('The map could not load — check your connection, then refresh the app.', {
      sticky: true,
    });
  }
}, 15000);
map.on('load', () => clearInterval(styleWatchdog));

/* ---------------- dual-state location cursor (spec §2) ---------------- */

/**
 * The vehicle/location cursor. Always rendered once the first GPS fix
 * arrives; switches between two state-driven forms:
 *   State A (stationary, speed < 2 km/h or no heading): solid blue dot
 *   with a pulsing accuracy halo.
 *   State B (motion, speed >= 2 km/h with heading): directional
 *   navigation arrow rotating in real time to the GPS bearing.
 */
const cursorEl = document.createElement('div');
cursorEl.className = 'location-cursor';
const locationCursor = new maplibregl.Marker({ element: cursorEl })
  .setLngLat(MAP.center)
  .addTo(map);

/** True GPS bearing of the latest fix — the arrow's rotation source. */
let cursorTrueHeading = null;

/** Update cursor position + state from a GPS fix. */
function updateLocationCursor({ lat, lon, heading = null, speedMps = null }) {
  locationCursor.setLngLat([lon, lat]);
  const kmh = Number.isFinite(speedMps) ? speedMps * 3.6 : null;
  const isMoving = kmh !== null && kmh >= 2 && Number.isFinite(heading);
  cursorEl.classList.toggle('is-moving', isMoving);
  if (isMoving) {
    cursorTrueHeading = heading;
    // MapLibre markers rotate with the map; counter-rotate the arrow
    // so the heading stays true-north aligned on screen.
    cursorEl.style.setProperty('--cursor-heading', `${heading - map.getBearing()}deg`);
  } else {
    cursorTrueHeading = null;
  }
}

// Keep the arrow's screen-space heading true as the user rotates the map.
map.on('rotate', () => {
  if (cursorTrueHeading !== null) {
    cursorEl.style.setProperty('--cursor-heading', `${cursorTrueHeading - map.getBearing()}deg`);
  }
});

// As the user pans/zooms, alternative routes scroll into and out of the
// viewport — re-render the on-map choice list so badges appear when an
// alternative line comes on screen and disappear when it leaves. Cheap
// because no network is touched; just iterates the existing pool.
map.on('moveend', () => {
  if (state.route || (state.alternatives ?? []).length > 0) renderRouteChoices();
});

/* ---------------- zero-touch GPS startup (spec §1) ---------------- */

/**
 * Standby location watch. Starts immediately on app mount — no button
 * tap. The first fix auto-centers the map with an animated zoom into
 * the location cursor; subsequent fixes keep the cursor live and feed
 * the right-rail speedometer. Stopped when navigation starts (the
 * navigation watch takes over) and resumed when navigation ends.
 */
let standbyWatchId = null;

function startStandbyWatch() {
  if (standbyWatchId !== null || !('geolocation' in navigator)) return;
  standbyWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, heading, speed } = pos.coords;
      state.lastFix = { lat, lon, at: pos.timestamp };
      state.gpsLocked = true;
      updateLocationCursor({ lat, lon, heading, speedMps: speed });
      updateSpeedHud(speed);
      if (!state.centeredOnFirstFix) {
        state.centeredOnFirstFix = true;
        // Spec §1: immediately auto-center and animate zoom into the
        // current location cursor, zero-touch.
        map.flyTo({ center: [lon, lat], zoom: 17, essential: true });
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 2000 }
  );
}

function stopStandbyWatch() {
  if (standbyWatchId === null || !('geolocation' in navigator)) return;
  navigator.geolocation.clearWatch(standbyWatchId);
  standbyWatchId = null;
}

startStandbyWatch();

/**
 * Add the app-managed sources/layers (alt-routes gray, route white casing,
 * 3-colour traffic line). Extracted so the theme system can re-call it
 * after every map.setStyle() swap — MapLibre drops all custom sources
 * and layers whenever a new style JSON replaces the active one.
 */
function addRouteLayers(m) {
  // Muted gray alternative routes — added first so the coloured
  // primary line and its white casing draw on top.
  m.addSource('alt-routes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  m.addLayer({
    id: 'alt-routes-line',
    type: 'line',
    source: 'alt-routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#8d8d8d', 'line-width': 4, 'line-opacity': 0.45 },
  });
  m.addSource('route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  m.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
  });
  m.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    // One feature per coloured stretch — the 3-colour traffic line.
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#d52b1e'], 'line-width': 5 },
  });
}

map.on('load', () => {
  addRouteLayers(map);
  // Hand the map to the theme system so a future light↔dark flip can
  // re-call addRouteLayers() via theme.js's onStyleReady hook.
  import('./theme.js').then(({ bindMap }) => bindMap(map, () => addRouteLayers(map)));
});

/* ---------------- screen wake lock ---------------- */

/**
 * Keep the screen on while Schmaps is open.
 *
 * A navigation app that lets the screen time out mid-drive is a
 * hazard: the driver has to fumble for the phone to wake it. The
 * Screen Wake Lock API holds the display awake for as long as the
 * page is visible; the browser releases the lock automatically when
 * the tab is hidden, so we re-acquire on visibility changes.
 * Best-effort everywhere — older browsers and iOS Safari (which
 * lacks the API) simply keep their normal timeout.
 */
let wakeLock = null;

async function keepScreenAwake() {
  if (document.visibilityState !== 'visible') return;
  if (!('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // denied, unsupported, or battery-saver kicked in
  }
}

keepScreenAwake();
document.addEventListener('visibilitychange', keepScreenAwake);

/* ---------------- OBD gauges ---------------- */

/**
 * Live car gauges over the map, fed by the Schmaps OBD bridge app
 * (android-bridge/) over loopback HTTP. The strip appears only when
 * the bridge answers — no bridge, no gauges, schmaps unchanged.
 *
 * The strip sits above the route panel; a ResizeObserver keeps the
 * two from overlapping as the panel grows (errands list, save form…).
 */
const obd = {
  transport: createBridgeTransport(),
  settings: loadObdSettings() ?? {},
  prevFeed: null,
  timer: null,
  everSeen: false, // has the bridge answered at least once?
};

function obdGaugeValue(el, text) {
  el.querySelector('.gauge-value').textContent = text;
}

function renderObdGauges(gauges) {
  if (!gauges) return;
  obdGaugeValue(els.gaugeRpm, formatRpm(gauges.rpm));
  obdGaugeValue(els.gaugeRange, formatKm(gauges.kmToEmpty));
  obdGaugeValue(els.gaugeOil, formatKm(gauges.oilKmLeft));
  obdGaugeValue(els.gaugeCoolant, formatCoolant(gauges.coolantC));

  // Oil urgency: amber under 1000 km left, red at/below zero.
  els.gaugeOil.classList.toggle('warn', Number.isFinite(gauges.oilKmLeft) && gauges.oilKmLeft > 0 && gauges.oilKmLeft < 1000);
  els.gaugeOil.classList.toggle('overdue', Number.isFinite(gauges.oilKmLeft) && gauges.oilKmLeft <= 0);
}

async function obdTick() {
  const feed = await obd.transport.poll();
  if (feed) {
    obd.everSeen = true;
    // The car reports no odometer PID — advance ours from the speed
    // feed so the oil countdown ticks down as you drive.
    const advanced = advanceOdometer(obd.settings, feed, obd.prevFeed);
    if (advanced !== obd.settings) {
      obd.settings = advanced;
      saveObdSettings(obd.settings);
    }
    obd.prevFeed = feed;
    els.obdStrip.hidden = false; // first good poll reveals the strip
    els.obdStrip.classList.remove('stale');
    renderObdGauges(computeGauges(feed, obd.settings));
  } else if (obd.everSeen) {
    // Bridge was there, now it isn't (app stopped, BT dropped).
    // Dim the last values rather than hiding — a paused gauge is
    // honest; a vanished one looks like a bug.
    els.obdStrip.classList.add('stale');
    if (obd.transport.msSinceGood() > OBD.staleMs * 6) {
      els.obdStrip.hidden = true;
      obd.everSeen = false;
    }
  }
  if (!els.obdStrip.hidden) {
    els.obdStrip.classList.toggle('stale', obd.transport.msSinceGood() > OBD.staleMs);
  }
}

function startObdPolling() {
  if (obd.timer) return;
  obd.timer = setInterval(() => void obdTick(), OBD.pollMs);
  void obdTick(); // first poll immediately — reveals the strip if a
  // bridge is already running (e.g. page reloaded mid-drive)
}

// The strip reveals itself on the first successful poll.
const obdStripObserver = new MutationObserver(() => {
  if (!els.obdStrip.hidden) {
    obdStripObserver.disconnect();
    liftObdAbovePanel();
  }
});
obdStripObserver.observe(els.obdStrip, { attributes: true, attributeFilter: ['hidden'] });

/**
 * Keep the gauge strip clear of the route panel: the panel's height
 * changes (errands list, save form, quicker-route card), so watch it
 * and lift the strip's bottom offset to match.
 */
function liftObdAbovePanel() {
  const panel = els.panel;
  const strip = els.obdStrip;
  const apply = () => {
    if (panel.hidden) {
      strip.style.bottom = '';
    } else {
      const panelTop = panel.getBoundingClientRect().top;
      // 8px breathing room above the panel's top edge.
      strip.style.bottom = `calc(100vh - ${panelTop - 8}px)`;
    }
  };
  apply();
  new ResizeObserver(apply).observe(panel);
}

/* OBD settings dialog — tank size, economy, oil interval, odometer. */
function openObdSettings() {
  const s = obd.settings;
  els.obdTank.value = s.tankL ?? '';
  els.obdEconomy.value = s.lper100 ?? '';
  els.obdOilInterval.value = s.oilIntervalKm ?? OBD.defaultOilIntervalKm;
  els.obdOdo.value = s.odoKm ?? '';
  els.obdOilStart.value = s.oilStartKm ?? '';
  els.obdSettings.hidden = false;
}

function closeObdSettings() {
  els.obdSettings.hidden = true;
}

els.obdSettingsBtn.addEventListener('click', openObdSettings);
els.obdClose.addEventListener('click', closeObdSettings);

els.obdSave.addEventListener('click', () => {
  const num = (el) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
  };
  obd.settings = {
    tankL: num(els.obdTank),
    lper100: num(els.obdEconomy),
    oilIntervalKm: num(els.obdOilInterval),
    odoKm: num(els.obdOdo),
    oilStartKm: num(els.obdOilStart),
  };
  saveObdSettings(obd.settings);
  closeObdSettings();
  showStatus('Car settings saved.');
  // Re-render immediately with the new settings.
  if (obd.prevFeed) renderObdGauges(computeGauges(obd.prevFeed, obd.settings));
});

startObdPolling();

/* ---------------- geolocation ---------------- */

/**
 * Wait for a GPS fix good enough to plan a route from.
 *
 * The first fix a device reports can be a coarse cell-tower estimate —
 * off by hundreds of metres or more — and planning from it puts the
 * route origin in the wrong place. This watches for fixes and accepts
 * the first one accurate enough (GPS.accuracyM), settling for the
 * best fix seen once GPS.timeoutMs passes. Fresh fixes only: a cached
 * fix is stale the moment the vehicle moves.
 *
 * @returns {Promise<{lat:number, lon:number, accuracy:number}|null>}
 *   null when geolocation is unavailable or denied.
 */
function getAccuratePosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator) || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let best = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);
      resolve(value);
    };
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords;
        const fix = { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : Infinity };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (fix.accuracy <= GPS.accuracyM) finish(fix);
      },
      () => finish(best),
      { enableHighAccuracy: true, timeout: GPS.timeoutMs, maximumAge: GPS.maxAgeMs }
    );
    setTimeout(() => finish(best), GPS.timeoutMs);
  });
}

/* ---------------- route flow ---------------- */

/**
 * Route to a resolved destination. Shared by direct geocoding and by
 * the "did you mean" suggestion chips.
 */
async function routeToDestination(dest) {
  removeDropPin(); // a committed route replaces any tapped pin
  showStatus('Finding your location…', { sticky: true });
  const origin = await getAccuratePosition();
  if (!origin) {
    showStatus('Using map centre as your starting point — enable location for better results.', { sticky: true });
    const c = map.getCenter();
    state.origin = { lat: c.lat, lon: c.lng };
  } else {
    state.origin = origin;
  }

  state.destination = dest;
  showStatus(`Found ${dest.label}. Computing route…`, { sticky: true });

  const route = await computeRoute(state.origin, dest);
  state.route = route;
  state.alternatives = route.alternatives ?? [];
  state.routePreference = null; // a fresh search starts on the fastest route
  resetRouteOffers();
  state.lastSpokenEta = route.eta.getTime(); // baseline for shift detection
  recordTrip({ label: dest.label, lat: dest.lat, lon: dest.lon }); // feeds the typeahead

  renderRoute();
  hideStatus();

  const note = await trafficSummary(route, { forVoice: true });
  let summary =
    `Route to ${dest.label}: ${formatDistance(route.distanceMeters)}, ` +
    `${formatDuration(route.trafficSeconds)}, ` +
    `arriving at ${formatTime(route.eta)}. ${note}`;
  const usa = usaWarningText(route);
  if (usa) summary += ` ${usa}`;
  speak(summary);
}

/** Hide the suggestion bar. */
function hideSuggestions() {
  els.suggestBar.hidden = true;
  els.suggestChips.innerHTML = '';
}

/**
 * Show a tappable list of candidate places. Never auto-picks — the
 * user chooses which destination they meant. `title`/`spoken` let the
 * POI fallback phrase the prompt differently from the fuzzy gazetteer.
 */
function showSuggestions(query, candidates, { title, spoken } = {}) {
  els.suggestChips.innerHTML = '';
  els.suggestLabel.textContent = title ?? `No “${query}” found — did you mean…`;
  for (const c of candidates) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggest-chip';
    const name = document.createTextNode(c.name);
    chip.appendChild(name);
    if (c.province) {
      const prov = document.createElement('span');
      prov.className = 'chip-prov';
      prov.textContent = `, ${c.province}`;
      chip.appendChild(prov);
    }
    chip.addEventListener('click', () => {
      hideSuggestions();
      const label = c.label ?? (c.province ? `${c.name}, ${c.province}` : c.name);
      els.searchInput.value = label;
      routeToDestination({
        lat: c.lat,
        lon: c.lon,
        label,
        confidence: 1,
      }).catch((err) => showStatus(err.message || 'Something went wrong.'));
    });
    els.suggestChips.appendChild(chip);
  }
  els.suggestBar.hidden = false;
  speak(spoken ?? `I couldn't find ${query}. Did you mean ${candidates[0].name}?`);
}

async function handleDestinationQuery(query) {
  if (!query || !query.trim()) return;
  hideSuggestions();
  hideAutocomplete();
  clearPoiMarkers();

  // A tag on its own filters saved places — "go to family" lists
  // every place tagged family.
  const stripped = stripTravelWords(query);
  const tagged = stripped ? placesWithTag(stripped) : [];
  if (tagged.length > 0) {
    hideStatus();
    // Nearest first — the same "near wins" rule as the typeahead.
    const origin = acOrigin();
    const nearest = [...tagged].sort(
      (a, b) =>
        haversineKm(origin.lat, origin.lon, a.lat, a.lon) -
        haversineKm(origin.lat, origin.lon, b.lat, b.lon)
    );
    showSuggestions(
      stripped,
      nearest.map((p) => ({
        name: p.name,
        province: p.label,
        label: p.name,
        lat: p.lat,
        lon: p.lon,
      })),
      {
        title: `Places tagged “${stripped}” — tap one`,
        spoken: `You have ${tagged.length} saved place${tagged.length > 1 ? 's' : ''} tagged ${stripped}. Tap the one you want.`,
      }
    );
    return;
  }

  // Saved places — "go to Grandma's House" beats any geocoder.
  const saved = findSavedPlace(query);
  if (saved) {
    await routeToDestination({ lat: saved.lat, lon: saved.lon, label: saved.name, confidence: 1 });
    return;
  }

  // Category browse — a bare "what I need" word ("oil change", "coffee",
  // "gas") pins EVERY nearby match, coloured by open / closing-soon /
  // opens-later / closed-today. Travel-word phrasings ("take me to gas")
  // keep the immediate nearest-match behaviour, and multi-stop requests
  // keep planning through errands mode below.
  const IMMEDIATE_INTENT_RE =
    /\b(?:take me|drive me|go to|drive to|navigate to|route to|directions to)\b/i;
  if (!IMMEDIATE_INTENT_RE.test(query)) {
    const cat = categoryFor(stripTravelWords(query));
    if (cat) {
      await browseCategory(cat);
      return;
    }
  }

  // Errands mode — several stops, visited in the most efficient order.
  if (isErrandsQuery(query)) {
    await handleErrandsQuery(query);
    return;
  }

  showStatus(`Resolving “${query}”…`, { sticky: true });

  try {
    // Address-shaped queries get the full fallback chain —
    // geocoder.ca → Nominatim → Photon. Anything else goes straight
    // to geocoder.ca with the suggestion fallbacks below.
    const dest = isAddressQuery(query) ? await geocodeChain(query) : await geocodeAddress(query);

    // geocoder.ca returns low confidence for bare place names and
    // ambiguous matches — treat those as "maybe mis-heard" and offer
    // suggestions rather than committing to one result.
    if (dest.confidence < 0.5 && (await offerFallbacks(query))) return;

    await routeToDestination(dest);
  } catch (err) {
    // Every geocoder came up empty — fuzzy gazetteer, then nearby POIs.
    if (await offerFallbacks(query)) return;
    showStatus(err.message || 'Something went wrong.');
    speak(err.message || 'Sorry, something went wrong.');
  }
}

/**
 * Suggestion fallbacks for queries the address geocoder can't commit
 * to: fuzzy gazetteer towns first, then nearby POIs — business names
 * like "home hardware" that geocoder.ca has never heard of. Returns
 * true when a suggestion list is showing.
 */
async function offerFallbacks(query) {
  const candidates = await suggestPlaces(query, { limit: 5 });
  if (candidates.length > 0) {
    hideStatus();
    showSuggestions(query, candidates);
    return true;
  }

  try {
    const pos = await getAccuratePosition();
    const center = map.getCenter();
    const near = pos ?? { lat: center.lat, lon: center.lng };
    const results = await searchPOI(query, { near, limit: 5 });
    if (results.length > 0) {
      // Closest first — that's usually the one they meant.
      const cosLat = Math.cos((near.lat * Math.PI) / 180);
      const d2 = (r) => (r.lat - near.lat) ** 2 + ((r.lon - near.lon) * cosLat) ** 2;
      results.sort((a, b) => d2(a) - d2(b));
      hideStatus();
      showSuggestions(
        query,
        results.map((r) => ({
          name: r.name,
          province:
            r.label
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p !== r.name)
              .join(', ') || undefined,
          label: r.label,
          lat: r.lat,
          lon: r.lon,
        })),
        {
          title: `Nearby “${query}” — tap one to route there`,
          spoken: `I found some nearby places for ${query}. Tap the one you want.`,
        }
      );
      return true;
    }
  } catch {
    /* no POI fallback either — the caller reports the error */
  }
  return false;
}

/* ---------------- category browse (pins on the map) ---------------- */

const POI_LIMIT = 16;
const POI_RADIUS_M = 15000;
const SEARCH_AREA_PILL_KM = 3; // centre moved this far → offer "Search this area"

function clearPoiMarkers() {
  for (const m of state.poiMarkers) m.remove();
  state.poiMarkers = [];
  state.poiSearch = null;
  if (els.searchAreaBtn) els.searchAreaBtn.hidden = true;
}

/** Minutes-of-day (0..1440+, overnight ends wrap) → "5 pm" app format. */
function minutesToClock(min) {
  const d = new Date();
  d.setHours(Math.floor((min % 1440) / 60), min % 60, 0, 0);
  return formatTime(d);
}

/** The human line for a place's open/closed classification. */
function poiStatusPhrase(st) {
  switch (st.state) {
    case 'open':
      return st.allDay ? 'Open 24 hours' : `Open · closes ${minutesToClock(st.closesAtMin)}`;
    case 'closing-soon':
      return `⚠️ Closing soon — ${minutesToClock(st.closesAtMin)}`;
    case 'opens-later':
      return `Opens ${minutesToClock(st.opensAtMin)} today`;
    case 'closed-today':
      return 'Closed today';
    default:
      return 'Hours unknown';
  }
}

/** Search radius for "Search this area": half the visible diagonal. */
function viewportSearchRadiusM() {
  const b = map.getBounds();
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  const spanKm = Math.max(
    haversineKm(sw.lat, sw.lng, ne.lat, ne.lng),
    haversineKm(sw.lat, sw.lng, sw.lat, ne.lng)
  );
  return Math.min(40000, Math.max(1500, Math.round(spanKm * 500)));
}

/**
 * Browse a category: pin every nearby match, coloured by open/closed
 * status, tappable for details + Navigate. Panning away or zooming out
 * afterwards offers "Search this area" to re-run the browse around the
 * new viewport. Overpass supplies the data (with opening_hours); when
 * it can't be reached the Nominatim POI search fills in with
 * "hours unknown" pins — same UI, honest degradation.
 */
async function browseCategory(cat, { near: nearOpt, radiusM = POI_RADIUS_M, fit = true } = {}) {
  clearPoiMarkers();
  showStatus(`${cat.icon} Finding ${cat.label} near you…`, { sticky: true });

  let near = nearOpt ?? state.lastFix;
  if (!near) near = await getAccuratePosition().catch(() => null);
  if (!near) {
    const c = map.getCenter();
    near = { lat: c.lat, lon: c.lng };
  }

  let places = [];
  let degraded = false;
  try {
    places = await searchCategoryPOI(cat, { near, radiusM, limit: POI_LIMIT });
  } catch {
    degraded = true; // Overpass unreachable — Nominatim fallback below
  }
  if (places.length === 0 && degraded) {
    try {
      places = (await searchPOI(cat.search, { near, limit: POI_LIMIT })).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        name: p.name,
        kind: '',
        openingHours: null,
        phone: null,
        website: null,
        address: p.label && p.label !== p.name ? p.label : null,
      }));
    } catch {
      /* no fallback either — the empty case reports below */
    }
  }

  if (places.length === 0) {
    hideStatus();
    const sorry = `No ${cat.label} found nearby.`;
    showStatus(sorry);
    speak(sorry);
    return;
  }

  hideStatus();
  state.poiSearch = {
    cat,
    origin: near,
    radiusM,
    // Suppress the "Search this area" pill during our own fitBounds.
    suppressPillUntil: Date.now() + 1500,
  };

  const counts = { open: 0, soon: 0, later: 0, closed: 0, unknown: 0 };
  const bounds = new maplibregl.LngLatBounds([near.lon, near.lat], [near.lon, near.lat]);

  for (const p of places) {
    const st = openingStatus(p.openingHours);
    if (st.state === 'open') counts.open++;
    else if (st.state === 'closing-soon') counts.soon++;
    else if (st.state === 'opens-later') counts.later++;
    else if (st.state === 'closed-today') counts.closed++;
    else counts.unknown++;

    const el = document.createElement('div');
    el.className = `poi-marker ${st.state}`;
    el.textContent = cat.icon;

    const info = document.createElement('div');
    info.className = 'poi-info';
    const nm = document.createElement('strong');
    nm.textContent = p.name;
    info.appendChild(nm);
    const meta = document.createElement('span');
    meta.className = `poi-status ${st.state}`;
    meta.textContent = poiStatusPhrase(st);
    info.appendChild(meta);
    const extra = document.createElement('span');
    extra.className = 'poi-extra';
    const bits = [
      p.address,
      Number.isFinite(p.distanceKm)
        ? `${p.distanceKm < 10 ? p.distanceKm.toFixed(1) : Math.round(p.distanceKm)} km away`
        : null,
      degraded ? 'hours unavailable' : null,
    ].filter(Boolean);
    extra.textContent = bits.join(' · ');
    if (extra.textContent) info.appendChild(extra);
    const nav = document.createElement('button');
    nav.type = 'button';
    nav.className = 'nav-here-btn';
    nav.textContent = 'Navigate';
    nav.addEventListener('click', () => {
      clearPoiMarkers();
      routeToDestination({ lat: p.lat, lon: p.lon, label: p.name, confidence: 1 }).catch(
        (err) => showStatus(err.message || 'Something went wrong.')
      );
    });
    info.appendChild(nav);

    const popup = new maplibregl.Popup({ closeButton: true, offset: 24 }).setDOMContent(info);
    state.poiMarkers.push(
      new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lon, p.lat])
        .setPopup(popup)
        .addTo(map)
    );
    bounds.extend([p.lon, p.lat]);
  }

  if (fit) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 600 });
  }

  // Plain-language status line + spoken summary.
  const bits = [`${counts.open} open now`];
  if (counts.soon) bits.push(`${counts.soon} closing soon`);
  if (counts.later) bits.push(`${counts.later} opening later`);
  if (counts.closed) bits.push(`${counts.closed} closed today`);
  showStatus(`${cat.icon} ${places.length} ${cat.label} nearby — ${bits.join(', ')}`);
  speak(
    `I found ${places.length} ${places.length === 1 ? 'place' : 'places'} for ${cat.label} nearby — ` +
      bits.join(', ') +
      '. Tap one on the map to navigate.'
  );
}

/* "Search this area" — the browse re-queried around the new viewport. */
els.searchAreaBtn.addEventListener('click', () => {
  const browse = state.poiSearch;
  if (!browse) return;
  const c = map.getCenter();
  void browseCategory(browse.cat, {
    near: { lat: c.lat, lon: c.lng },
    radiusM: viewportSearchRadiusM(),
  });
});

// Offer the pill once the viewport has moved meaningfully away from the
// searched area — panned >3 km, or zoomed out past 1.5× the radius.
map.on('moveend', () => {
  const browse = state.poiSearch;
  if (!browse) return;
  if (Date.now() < (browse.suppressPillUntil ?? 0)) return;
  const c = map.getCenter();
  const movedKm = haversineKm(c.lat, c.lng, browse.origin.lat, browse.origin.lon);
  const widened = viewportSearchRadiusM() > browse.radiusM * 1.5;
  els.searchAreaBtn.hidden = !(movedKm > SEARCH_AREA_PILL_KM || widened);
});

/* ---------------- typeahead autocomplete ---------------- */

/*
 * Live suggestions under the search box, ranked for how you actually
 * travel: near places first, common (often-visited) places second,
 * tagged places further away third, then everything else — drawn from
 * 🏷️ saved places, 🕘 recent trips and 📍 Photon addresses, ten at
 * most. The most probable match fills in the rest of the field
 * inline, selected, so keep-typing refines it: Enter picks the
 * highlighted row, Tab takes the completion, Esc dismisses.
 */
const AC = {
  timer: null, // debounce handle
  seq: 0, // race guard — stale responses never render
  typed: '', // the user's raw text, without any inline completion
  full: '', // the inline completion currently applied ('' = none)
  items: [],
  active: -1,
  open: false,
};

/** Two results within ~50 m of each other are the same place. */
function sameSpot(a, b) {
  return Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005;
}

/** Saved places & recent trips matching the text — instant, offline. */
function acLocalItems(query) {
  const t = normalizeName(query);
  if (!t) return [];
  const items = [];
  for (const p of getSavedPlaces()) {
    const name = normalizeName(p.name);
    const tagHit = p.tags.some((tag) => normalizeName(tag).includes(t));
    if (name.includes(t) || tagHit) {
      items.push({
        kind: 'saved',
        name: p.name,
        label: p.name,
        sub: p.label,
        lat: p.lat,
        lon: p.lon,
        tags: p.tags,
      });
    }
  }
  for (const trip of getTrips()) {
    if (!normalizeName(trip.label).includes(t)) continue;
    if (items.some((i) => sameSpot(i, trip))) continue;
    items.push({
      kind: 'trip',
      name: trip.label,
      label: trip.label,
      sub: 'recent trip',
      lat: trip.lat,
      lon: trip.lon,
    });
  }
  return items;
}

/** Best guess at "here": latest GPS fix, route origin, or map view. */
function acOrigin() {
  if (state.lastFix) return { lat: state.lastFix.lat, lon: state.lastFix.lon };
  if (state.origin) return state.origin;
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

/** Within this radius of "here", a place counts as near. */
const NEAR_KM = 25;

/** Coordinate key — trips to the same spot share a key. */
const spotKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

/**
 * Rank suggestions: near places first, common (frequently visited)
 * places second, tagged places further away third, everything else
 * after. Distance breaks ties within each tier; frequency breaks
 * them within "common".
 */
function rankAcItems(items) {
  const origin = acOrigin();
  const visits = new Map();
  for (const t of getTrips()) {
    const k = spotKey(t.lat, t.lon);
    visits.set(k, (visits.get(k) || 0) + 1);
  }
  const tierOf = (item) => {
    if (haversineKm(origin.lat, origin.lon, item.lat, item.lon) <= NEAR_KM) return 0;
    if ((visits.get(spotKey(item.lat, item.lon)) || 0) >= 2) return 1;
    if (item.kind === 'saved' && item.tags && item.tags.length > 0) return 2;
    return 3;
  };
  return items
    .map((item, i) => {
      const freq = visits.get(spotKey(item.lat, item.lon)) || 0;
      return {
        item,
        i,
        tier: tierOf(item),
        km: haversineKm(origin.lat, origin.lon, item.lat, item.lon),
        freq,
      };
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 1 && a.freq !== b.freq) return b.freq - a.freq; // common: most visited first
      if (a.km !== b.km) return a.km - b.km;
      return a.i - b.i;
    })
    .map((e) => e.item);
}

function scheduleAutocomplete(typed) {
  clearTimeout(AC.timer);
  AC.timer = setTimeout(() => {
    AC.timer = null;
    void runAutocomplete(typed);
  }, 250);
}

async function runAutocomplete(typed) {
  // "go to emi…" — suggest for what follows the travel words.
  const query = stripTravelWords(typed) || typed;
  if (query.length < 3 || isErrandsQuery(query)) {
    hideAutocomplete();
    return;
  }

  // Local matches appear instantly; Photon refines the list after.
  // Bump the sequence first — any earlier in-flight response is stale.
  const seq = ++AC.seq;
  const items = rankAcItems(acLocalItems(query));
  renderAc(items, typed);

  try {
    // Photon leans toward "here" too — the near-first ranking starts
    // server-side.
    const remote = await geocodePhoton(query, { near: acOrigin() });
    for (const r of remote) {
      if (!items.some((i) => sameSpot(i, r))) {
        items.push({
          kind: 'photon',
          name: r.primary,
          label: r.label,
          sub: r.secondary,
          lat: r.lat,
          lon: r.lon,
        });
      }
    }
  } catch {
    /* offline — the local matches stand */
  }
  if (seq !== AC.seq) return; // the user typed on — stale
  renderAc(rankAcItems(items).slice(0, 10), typed);
}

function renderAc(items, typed) {
  if (items.length === 0) {
    hideAutocomplete();
    return;
  }
  AC.items = items;
  AC.active = 0;
  els.autocomplete.innerHTML = '';
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'ac-item' + (i === 0 ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === 0));
    const icon = document.createElement('span');
    icon.className = 'ac-icon';
    icon.textContent = item.kind === 'saved' ? '🏷️' : item.kind === 'trip' ? '🕘' : '📍';
    const text = document.createElement('span');
    text.className = 'ac-text';
    const name = document.createElement('span');
    name.className = 'ac-name';
    name.textContent = item.name;
    text.appendChild(name);
    if (item.sub) {
      const sub = document.createElement('span');
      sub.className = 'ac-sub';
      sub.textContent = item.sub;
      text.appendChild(sub);
    }
    row.append(icon, text);
    // pointerdown (with preventDefault) beats the blur a plain click
    // would trigger — the tap lands before the box loses focus.
    row.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      pickAcItem(i);
    });
    els.autocomplete.appendChild(row);
  });
  els.autocomplete.hidden = false;
  AC.open = true;

  // Inline completion: the most probable result fills in the rest of
  // the field, selected, so further typing refines instead of appending.
  const top = items[0];
  if (top.label.toLowerCase().startsWith(typed.toLowerCase())) {
    els.searchInput.value = top.label;
    els.searchInput.setSelectionRange(typed.length, top.label.length);
    AC.full = top.label;
  } else {
    AC.full = '';
  }
}

/** Route straight to a dropdown row — no re-geocode needed. */
function pickAcItem(i) {
  const item = AC.items[i];
  if (!item) return;
  hideAutocomplete();
  AC.typed = item.label;
  els.searchInput.value = item.label;
  els.searchInput.blur();
  routeToDestination({ lat: item.lat, lon: item.lon, label: item.label, confidence: 1 }).catch(
    (err) => showStatus(err.message || 'Something went wrong.')
  );
}

/** Highlight a row (arrow keys) and mirror it into the field. */
function highlightAc() {
  const rows = els.autocomplete.querySelectorAll('.ac-item');
  rows.forEach((row, i) => {
    const on = i === AC.active;
    row.classList.toggle('active', on);
    row.setAttribute('aria-selected', String(on));
    if (on) row.scrollIntoView({ block: 'nearest' });
  });
  const item = AC.items[AC.active];
  if (!item) return;
  els.searchInput.value = item.label;
  if (item.label.toLowerCase().startsWith(AC.typed.toLowerCase())) {
    els.searchInput.setSelectionRange(AC.typed.length, item.label.length);
  } else {
    els.searchInput.setSelectionRange(item.label.length, item.label.length);
  }
  AC.full = item.label;
}

function hideAutocomplete() {
  clearTimeout(AC.timer);
  AC.timer = null;
  AC.seq++; // invalidate any in-flight typeahead
  AC.open = false;
  AC.full = '';
  AC.items = [];
  AC.active = -1;
  els.autocomplete.hidden = true;
  els.autocomplete.innerHTML = '';
}

/* ---------------- errands mode ---------------- */

/**
 * Errands mode — "errands: ikea, burger king around lunch, thrift store",
 * or plain task talk: "I need to go to home hardware, buy gas, and
 * groceries." Each stop is resolved (POI → address → gazetteer), then
 * OSRM's trip service picks the most efficient visiting order. Numbered
 * markers and the stop list make "continue to the next destination"
 * plain to see.
 */
async function handleErrandsQuery(query) {
  const fragments = parseErrands(query);
  if (fragments.length === 0) {
    const msg = 'Name a few places — e.g. "errands: ikea, burger king, thrift store".';
    showStatus(msg);
    speak('Name a few places for your errands.');
    return;
  }

  showStatus('Finding your location…', { sticky: true });
  const origin = await getAccuratePosition();
  if (origin) {
    state.origin = origin;
  } else {
    const c = map.getCenter();
    state.origin = { lat: c.lat, lon: c.lng };
    showStatus('Using map centre as your starting point — enable location for better results.', { sticky: true });
  }

  try {
    showStatus(`Planning ${fragments.length} stop${fragments.length === 1 ? '' : 's'}…`, { sticky: true });
    const result = await runErrands(state.origin, fragments, {
      onProgress: (frag, i, total) =>
        showStatus(`Finding “${frag}”… (${i + 1}/${total})`, { sticky: true }),
    });
    state.errands = result;
    state.route = result; // same shape as a single route
    state.alternatives = []; // the trip service has no alternatives
    resetRouteOffers();
    state.lastSpokenEta = result.eta.getTime(); // baseline for shift detection
    state.destination = result.stops[result.stops.length - 1] ?? null;
    renderErrands();
    hideStatus();

    let summary;
    if (result.stops.length === 1) {
      // A single task ("take me to the pharmacy") — plain route wording.
      const s = result.stops[0];
      summary =
        `Nearest match: ${s.name || s.label}. ` +
        `${formatDistance(result.distanceMeters)}, ${formatDuration(result.trafficSeconds)}, ` +
        `arriving at ${formatTime(result.eta)}.`;
    } else {
      const order = result.stops.map((s, i) => `${i + 1}. ${s.name || s.label}`).join(', then ');
      summary =
        `${result.stops.length} stops in the best order: ${order}. ` +
        `${formatDistance(result.distanceMeters)}, ${formatDuration(result.trafficSeconds)}, ` +
        `last stop by ${formatTime(result.eta)}.`;
    }
    if (result.skipped.length > 0) {
      summary += ` Couldn't find: ${result.skipped.join(', ')}.`;
    }
    speak(summary);
  } catch (err) {
    showStatus(err.message || 'Could not plan those errands.');
    speak(err.message || 'Sorry, I could not plan those errands.');
  }
}

/** Draw the errands route: line, numbered stops, stop list, HUD. */
function renderErrands() {
  const { errands } = state;
  if (!errands) return;
  removeDropPin(); // a committed errands run replaces any tapped pin

  if (state.destMarker) {
    state.destMarker.remove();
    state.destMarker = null;
  }

  setRouteLine(errands);
  setAltRouteLines([]); // errands mode has no alternative routes
  clearRouteChoiceMarkers(); // …and no choice badges from a prior single-route route
  els.altChips.hidden = true; // legacy chip row never used now
  els.usaBanner.hidden = true;

  const bounds = errands.geometry.reduce(
    (b, [lon, lat]) => b.extend([lon, lat]),
    new maplibregl.LngLatBounds(errands.geometry[0], errands.geometry[0])
  );
  map.fitBounds(bounds, { padding: { top: 110, bottom: 130, left: 40, right: 40 }, duration: 800 });

  // Numbered markers — the number is the visiting order.
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = errands.stops.map((stop, i) => {
    const el = document.createElement('div');
    el.className = 'stop-marker';
    el.textContent = String(i + 1);
    return new maplibregl.Marker({ element: el })
      .setLngLat([stop.lon, stop.lat])
      .setPopup(new maplibregl.Popup({ closeButton: false }).setText(stop.label))
      .addTo(map);
  });

  setIncidentMarkers(errands.incidents);
  setSlowdownBadges(errands, errandsBadgeRange(errands));
  setHud(errands);

  renderStopList();
  els.errandsList.hidden = false;

  els.panel.hidden = false;
  els.saveRow.hidden = true; // errands cards stay lean — no save form
  startNavigating();
}

/** Rebuild the errands stop list — numbers, names, ETAs, ✓ when done. */
function renderStopList() {
  const { errands } = state;
  if (!errands) return;
  els.errandsList.innerHTML = '';
  errands.stops.forEach((stop, i) => {
    const li = document.createElement('li');
    if (stop.done) li.classList.add('done');
    const num = document.createElement('span');
    num.className = 'stop-num';
    num.textContent = stop.done ? '✓' : String(i + 1);
    const name = document.createElement('span');
    name.className = 'stop-name';
    name.textContent = stop.label;
    const eta = document.createElement('span');
    eta.className = 'stop-eta';
    eta.textContent = stop.done ? 'done' : formatTime(stop.arriveAt);
    li.append(num, name, eta);
    els.errandsList.appendChild(li);
  });
}

/** End any errands run — markers, list, state. */
function clearErrands() {
  state.errands = null;
  for (const m of state.stopMarkers) m.remove();
  state.stopMarkers = [];
  els.errandsList.hidden = true;
  els.errandsList.innerHTML = '';
}

function renderRoute() {
  const { route, destination } = state;
  if (!route) return;
  clearErrands(); // a fresh single destination ends any errands run

  // Route line — one feature per coloured stretch, plus the muted
  // gray alternatives underneath and their chips.
  setRouteLine(route);
  setAltRouteLines(state.alternatives ?? []);

  // Fit bounds
  const bounds = route.geometry.reduce(
    (b, [lon, lat]) => b.extend([lon, lat]),
    new maplibregl.LngLatBounds(route.geometry[0], route.geometry[0])
  );
  map.fitBounds(bounds, { padding: { top: 110, bottom: 130, left: 40, right: 40 }, duration: 800 });

  // Destination marker
  if (state.destMarker) state.destMarker.remove();
  const el = document.createElement('div');
  el.className = 'dest-marker';
  state.destMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([destination.lon, destination.lat])
    .addTo(map);

  setIncidentMarkers(route.incidents);
  setSlowdownBadges(route);
  renderRouteChoices();
  checkUsaWarning(route, { speakWarning: false }); // the caller composes the voice line
  setHud(route);
  // Refresh the right-rail speed-limit badge from this route's HERE
  // spans[] (maxSpeedKmh). A new destination usually lands on a
  // highway with a different posted limit.
  refreshSpeedLimit();
  // Auto-record every routed destination into recent trips so the search
  // box's recall + "go to <label>" voice commands work without a
  // visible Save Route pill. Errands mode already records per stop, so
  // skip the duplicate record-trip here.
  if (!state.errands && destination) {
    recordTrip({ label: destination.label, lat: destination.lat, lon: destination.lon });
  }

  els.panel.hidden = false;

  // 🏷️ Offer to name the destination — unless this exact spot is
  // already saved (under any name).
  const alreadySaved = getSavedPlaces().some(
    (p) => Math.abs(p.lat - destination.lat) < 0.0005 && Math.abs(p.lon - destination.lon) < 0.0005
  );
  els.saveRow.hidden = alreadySaved;
  if (!alreadySaved) {
    els.saveName.value = '';
    els.saveTags.value = '';
  }

  // True selection mode: routes are computed and shown with all
  // candidate badges on the map, but navigation does NOT auto-start.
  // The user explicitly begins the trip by tapping the
  // #start-route-btn in the route panel — badges only select a route.
  // Switching to an alternative keeps selection mode active until
  // they tap Start, so they can keep comparing.
  //
  // Gated on !state.navigating so a mid-drive `switchToAlternative`
  // (silence deviation, refresh re-preference) doesn't yank the Start
  // CTA back onto the screen once we're already moving.
  els.startRouteBtn.hidden = state.navigating;
}

/* ---------------- shared render helpers ---------------- */

/** (Re)draw the ⚠️ incident markers along a route. */
function setIncidentMarkers(incidents) {
  for (const m of state.incidentMarkers) m.remove();
  state.incidentMarkers = incidents.map((ev) => {
    const mEl = document.createElement('div');
    mEl.className = 'incident-marker' + (ev.closure ? ' closure' : '');
    mEl.textContent = ev.closure ? '⛔' : '⚠️';
    return new maplibregl.Marker({ element: mEl })
      .setLngLat([ev.lon, ev.lat])
      .setPopup(
        new maplibregl.Popup({ closeButton: false }).setText(
          `${ev.roadway ? ev.roadway + ': ' : ''}${ev.description}`
        )
      )
      .addTo(map);
  });
}

/** Fill the route stats (distance, ETA, arrival). Shared by routes and errands. */
function setHud(route) {
  els.statDistance.textContent = formatDistance(route.distanceMeters);
  els.statDuration.textContent = formatDuration(route.trafficSeconds);
  els.statEta.textContent = formatTime(route.eta);
  // New route object → new per-km profile + a fresh progress anchor;
  // the local ETA engine (js/eta.js) re-times it on every GPS fix.
  if (state.kmProfile?.route !== route) {
    state.kmProfile = buildKmProfile(route);
    if (state.kmProfile) state.kmProfile.route = route;
    state.lastProgressM = 0;
    state.progressVertex = 0;
    state.limitsFetchedUpTo = -1;
  }
}

/**
 * Refresh the right-rail speed-limit badge. The number shown is the
 * POSTED limit of the road under the car: the current bucket's limit
 * comes from Overpass (queried at the car's own position — see
 * ensurePostedLimits), and only when that's unavailable does the
 * router's implied speed for the km stand in — a km-average across
 * intersections and ramps, not a signed limit. Before navigation
 * starts (selection mode), the badge shows the limit where the trip
 * STARTS — never the highest limit anywhere on the route.
 */
function refreshSpeedLimit() {
  let limit = null;
  const profile = state.kmProfile;
  if (state.navigating && profile && Number.isFinite(state.lastProgressM)) {
    const { bucket } = bucketAt(profile, state.lastProgressM);
    limit = bucket?.limitKmh ?? bucket?.impliedKmh ?? null;
  }
  if (!Number.isFinite(limit)) {
    const first = profile?.buckets?.[0];
    limit =
      first?.limitKmh ??
      first?.impliedKmh ??
      (state.errands ?? state.route)?.maxSpeedKmh ??
      null;
  }
  els.speedLimit.textContent =
    Number.isFinite(limit) && limit > 0 ? String(Math.round(limit)) : '—';
  // Spec §10.9 — once the text is rendered, recolor the ring based on
  // the comparator band (current speed vs posted limit, with hysteresis).
  paintSpeedLimitBadge(limit, state.currentSpeedKmh);
}

/**
 * Spec §10.9 — speed-limit comparator.
 *
 * Asymmetric band thresholds around the posted limit (GPS is noisy at
 * 1 Hz, ±2–3 km/h on a phone, so a symmetric 10/10 split flickers):
 *
 *   current <= limit - 5      → 'ok'    (green ring, well under)
 *   limit - 5  < current <= limit + 5  → 'ok'    (at the limit)
 *   limit + 5  < current <= limit + 15 → 'warn'  (yellow ring, edging over)
 *   current > limit + 15      → 'over'  (red ring, clearly speeding)
 *
 * A 2 km/h hysteresis (HYSTERESIS_KMH) prevents oscillation around the
 * threshold when the GPS fix jitters. We only *enter* a stricter band
 * (ok → warn → over) once the raw sample crosses the threshold; we only
 * *leave* a stricter band back to the next-lower one when the raw sample
 * drops HYSTERESIS_KMH below that threshold. The previous band is
 * remembered in `state.speedLimitBand`.
 *
 * Inputs in km/h (NOT m/s). Returns one of: 'ok' | 'warn' | 'over' | 'idle'.
 * 'idle' means we don't have a posted limit or a current speed yet.
 */
const BAND_OK_CEILING_KMH = 5;       // at-or-below limit + 5 is still green
const BAND_WARN_CEILING_KMH = 15;    // at-or-below limit + 15 is yellow
const HYSTERESIS_KMH = 2;           // drop 2 km/s past threshold before relaxing

function speedLimitBand(limitKmh, currentKmh, prevBand) {
  if (!Number.isFinite(limitKmh) || limitKmh <= 0) return 'idle';
  if (!Number.isFinite(currentKmh) || currentKmh < 0) return 'idle';

  // Hysteresis: from a stricter band, require the sample to drop this
  // many km/h past the threshold before relaxing. We treat the
  // hysteresis as a *uniform* buffer regardless of direction — keeps the
  // comparator trivially predictable.
  const h = HYSTERESIS_KMH;

  // Compute the band the raw sample belongs to right now.
  const overLimit = currentKmh - limitKmh;
  let raw;
  if (overLimit <= BAND_OK_CEILING_KMH) raw = 'ok';
  else if (overLimit <= BAND_WARN_CEILING_KMH) raw = 'warn';
  else raw = 'over';

  // No prior band → no hysteresis.
  if (prevBand !== 'ok' && prevBand !== 'warn' && prevBand !== 'over') return raw;

  // Allow relaxing from stricter → less strict only after a full band-step
  // of headroom. The thresholds below are the "must drop below" lines for
  // moving one band down.
  if (prevBand === 'over' && raw !== 'over') {
    // Must drop below warn ceiling (- hysteresis) to leave over.
    if (currentKmh > limitKmh + BAND_WARN_CEILING_KMH - h) return 'over';
    return raw;
  }
  if (prevBand === 'warn' && raw === 'ok') {
    // Must drop below ok ceiling (- hysteresis) to leave warn.
    if (currentKmh > limitKmh + BAND_OK_CEILING_KMH - h) return 'warn';
    return 'ok';
  }
  // Tightening is always immediate.
  return raw;
}

/** Write the comparator state to the badge + announce via aria. */
function paintSpeedLimitBadge(limitKmh, currentKmh) {
  const el = els.speedLimit;
  const prev = state.speedLimitBand;
  const band = speedLimitBand(limitKmh, currentKmh, prev);
  state.speedLimitBand = band;
  el.dataset.state = band;
  // a11y: state lives in aria-label so screen readers can speak it.
  // (aria-live on the element would otherwise repeat every tick.)
  const limitText = Number.isFinite(limitKmh) && limitKmh > 0
    ? `${Math.round(limitKmh)} km/h` : 'no posted limit';
  const curText = Number.isFinite(currentKmh) && currentKmh >= 0
    ? `${Math.round(currentKmh)} km/h` : 'unknown speed';
  const phrase = {
    ok:    `${curText}, at or under the ${limitText} limit`,
    warn:  `${curText}, ${Math.round(currentKmh - limitKmh)} over`,
    idle:  `${curText}, ${limitText}`,
    over:  `${curText}, ${Math.round(currentKmh - limitKmh)} over — slow down`,
  }[band];
  el.setAttribute('aria-label', `Speed limit badge. ${phrase}.`);
}

function updateSpeedHud(speedMps = null) {
  const kmh = Number.isFinite(speedMps) && speedMps >= 0 ? Math.round(speedMps * 3.6) : null;
  state.currentSpeedKmh = kmh;
  els.currentSpeed.textContent = kmh === null ? '—' : String(kmh);
  // Spec §3 Zone 2 / Right-rail speed-limit module — sourced from the
  // current segment (OSRM implied speed, or the Overpass posted limit).
  // Refreshed on every fix, since a new road usually means a new limit.
  refreshSpeedLimit();
}

/* ------- 3-colour line, badges & plain-language notes ------- */

/**
 * The driven part of the line — grey, stretched to the live fix so it
 * meets the cursor. Null when there's nothing meaningful to draw yet.
 */
function drivenCoords(route, progressVertex) {
  if (!Number.isFinite(progressVertex) || progressVertex < 1) return null;
  const geo = route.geometry;
  if (!Array.isArray(geo) || progressVertex >= geo.length) return null;
  const coords = geo.slice(0, progressVertex + 1);
  const fix = state.lastFix;
  if (fix) {
    const last = coords[coords.length - 1];
    if (last[0] !== fix.lon || last[1] !== fix.lat) coords.push([fix.lon, fix.lat]);
  }
  return coords.length >= 2 ? coords : null;
}

/**
 * A run's coords minus the driven part. Runs sit on route.geometry with
 * inclusive [startIdx, endIdx] vertex ranges (coords = the slice), so
 * the clip is index arithmetic. Fully driven runs drop out; the one the
 * car is inside starts at its clipped tail so the coloured line meets
 * the grey one under the cursor.
 */
function clipRunCoords(run, progressVertex) {
  if (!Number.isFinite(progressVertex) || progressVertex < 1) return run.coords;
  const s = Number.isFinite(run.startIdx) ? run.startIdx : 0;
  const e = Number.isFinite(run.endIdx) ? run.endIdx : 0;
  if (e <= progressVertex) return null; // fully driven
  if (s >= progressVertex) return run.coords; // fully ahead
  return run.coords.slice(progressVertex - s); // starts at the car's vertex
}

/**
 * GeoJSON for the route source: one feature per coloured stretch — and,
 * while navigating, a grey feature for the part already driven followed
 * by the traffic-coloured remainder, so the line itself shows progress.
 */
function routeLineFeatures(route, progressVertex = null) {
  const driven = drivenCoords(route, progressVertex);
  const drivenFeature = driven
    ? {
        type: 'Feature',
        properties: { color: TRAFFIC.colors.travelled },
        geometry: { type: 'LineString', coordinates: driven },
      }
    : null;
  const runs = route.runs ?? [];
  if (runs.length > 0) {
    const features = drivenFeature ? [drivenFeature] : [];
    for (const r of runs) {
      const coords = clipRunCoords(r, progressVertex);
      if (!coords || coords.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: { color: r.color },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  if (drivenFeature) {
    // No runs to clip — split the plain geometry at the car.
    return {
      type: 'FeatureCollection',
      features: [
        drivenFeature,
        {
          type: 'Feature',
          properties: { color: TRAFFIC.colors.neutral },
          geometry: {
            type: 'LineString',
            coordinates: route.geometry.slice(
              Math.min(progressVertex, route.geometry.length - 1)
            ),
          },
        },
      ],
    };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { color: TRAFFIC.colors.neutral },
        geometry: { type: 'LineString', coordinates: route.geometry },
      },
    ],
  };
}

/** Draw the coloured route line (the white casing sits under each stretch). */
function setRouteLine(route) {
  map.getSource('route').setData(routeLineFeatures(route));
}

/**
 * Live progress on the line: the driven kilometres go grey, the traffic
 * colours stay ahead. Called on every GPS fix — same cadence as the ETA.
 */
function updateRouteLineProgress() {
  const route = state.errands ?? state.route;
  const src = map.getSource('route');
  if (!src || !route) return;
  src.setData(routeLineFeatures(route, state.navigating ? state.progressVertex : null));
}

/** Draw the muted gray alternative lines beneath the primary. */
function setAltRouteLines(alts) {
  const src = map.getSource('alt-routes');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: (alts ?? []).map((a) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: a.geometry },
    })),
  });
}

/*
 * Route-choice data model
 *
 * `state.route` is the user's selected primary; `state.alternatives` are
 * the other routes returned by the last computeRoute(). To keep the
 * bottom card minimal we now show one tappable badge per route *on the
 * map* (anchored at each route's geometric midpoint) — not as a chip
 * row. The badges advertise:
 *   - selected   : the active route (always, on the primary)
 *   - fastest    : ⚡ shortest travel time (ties → first wins)
 *   - eco        : 🍃 shortest distance (fuel proxy; ties → first wins)
 *   - usa        : ⚠ marks the route as crossing the USA border
 *   - canada-via : 🍁 marks the synthesized Canada-via route
 *
 * `rating` (selected | alt) lets the CSS paint the *active* route on top
 * of the others and let alternatives look like offers (slight pulse).
 *
 * The bottom-card #alt-chips row stays hidden — the only visible card
 * addition is the benefit chip on the *selected* offer when a
 * mid-drive alternative beats the primary by ≥ the quicker-route
 * threshold (handled in renderRouteChoices()).
 */

/** Clear the on-map choice badges. Called before re-rendering. */
function clearRouteChoiceMarkers() {
  for (const m of state.choiceMarkers) m.remove();
  state.choiceMarkers = [];
}

/**
 * Compute the [midpoint] lon/lat of a route's geometry for badge placement.
 * Returns [lon, lat] suitable for maplibregl.Marker.setLngLat().
 */
function routeMidpoint(geom) {
  if (!geom || geom.length === 0) return null;
  const idx = Math.floor(geom.length / 2);
  const [lon, lat] = geom[idx];
  return [lon, lat];
}

/**
 * Whether a route's midpoint lies inside the current map viewport. A
 * badge pinned to a line that isn't on screen is just visual noise — we
 * only render the ones the driver could plausibly choose right now.
 */
function routeInViewport(geom) {
  const coord = routeMidpoint(geom);
  if (!coord) return false;
  const b = map.getBounds();
  return b.contains([coord[0], coord[1]]);
}

/**
 * Tag each candidate route with the badges it wins. Ties resolve to the
 * first occurrence (so the user's chosen primary gets priority if it
 * happens to also be fastest/eco). Returns a list of
 * {route, badges:[...], isPrimary} records ready for rendering.
 */
function buildRouteChoiceList() {
  const pool = [];
  if (state.route) pool.push({ route: state.route, isPrimary: true });
  for (const a of state.alternatives ?? []) {
    pool.push({ route: a, isPrimary: false });
  }
  if (pool.length === 0) return [];

  // Find the winner of each crown — ties go to the first entry.
  const fastestIdx = pool
    .map((p, i) => ({ i, t: p.route.trafficSeconds }))
    .sort((a, b) => a.t - b.t)[0].i;
  const ecoIdx = pool
    .map((p, i) => ({ i, d: p.route.distanceMeters }))
    .sort((a, b) => a.d - b.d)[0].i;

  return pool.map((entry, i) => {
    const badges = [];
    if (entry.isPrimary) badges.push('selected');
    if (i === fastestIdx) badges.push('fastest');
    if (i === ecoIdx) badges.push('eco');
    if (entry.route.crossesUsa) badges.push('usa');
    if (entry.route.canadaVia) badges.push('canada-via');
    return { ...entry, badges };
  });
}

/**
 * Render one badge onto the map. Anchors at the route's geometric
 * midpoint and tints by the highest-priority badge (selected > fastest
 * > eco > usa > canada-via > alt).
 */
function renderRouteChoiceMarker(entry) {
  const coord = routeMidpoint(entry.route.geometry);
  if (!coord) return null;
  const el = document.createElement('button');
  el.type = 'button';
  const classes = ['route-badge', entry.isPrimary ? 'selected' : 'alt'];
  if (entry.badges.includes('fastest')) classes.push('badge-fastest');
  if (entry.badges.includes('eco')) classes.push('badge-eco');
  if (entry.badges.includes('usa')) classes.push('badge-usa');
  if (entry.badges.includes('canada-via')) classes.push('badge-canada-via');
  el.className = classes.join(' ');
  el.setAttribute('aria-label', describeRouteChoice(entry));

  // Compose the badge content. Most-important chip first; if both
  // fastest and eco win the same route, show both markers.
  const iconRow = document.createElement('span');
  iconRow.className = 'route-badge-icons';
  if (entry.badges.includes('fastest')) {
    const f = document.createElement('span');
    f.className = 'route-badge-icon icon-fastest';
    f.textContent = '⚡';
    f.title = 'Fastest';
    iconRow.appendChild(f);
  }
  if (entry.badges.includes('eco')) {
    const e = document.createElement('span');
    e.className = 'route-badge-icon icon-eco';
    e.textContent = '🍃';
    e.title = 'Shortest';
    iconRow.appendChild(e);
  }
  if (entry.badges.includes('usa')) {
    const u = document.createElement('span');
    u.className = 'route-badge-icon icon-usa';
    u.textContent = '⚠';
    u.title = 'Crosses into USA';
    iconRow.appendChild(u);
  }
  el.appendChild(iconRow);

  const time = document.createElement('span');
  time.className = 'route-badge-time';
  time.textContent = formatDuration(entry.route.trafficSeconds);
  el.appendChild(time);

  const dist = document.createElement('span');
  dist.className = 'route-badge-dist';
  dist.textContent = formatDistance(entry.route.distanceMeters);
  el.appendChild(dist);

  // Click behaviour: a badge only ever *selects* a route — it never
  // starts navigation. Navigation begins exclusively from the
  // #start-route-btn "Start navigation" CTA in the route panel.
  //   selection mode — the primary badge is inert (it's already the
  //     active candidate); alternatives promote to primary and stay
  //     in selection mode.
  //   navigation mode — the primary badge isn't rendered at all;
  //     alternatives swap into primary mid-drive.
  if (!entry.isPrimary) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchToAlternative(entry.route);
    });
  }

  const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat(coord)
    .addTo(map);
  state.choiceMarkers.push(marker);
  return marker;
}

/** Human-readable string used as the badge's aria-label. */
function describeRouteChoice(entry) {
  const parts = [];
  if (entry.isPrimary) {
    parts.push('Selected route');
  } else {
    parts.push('Alternative route');
  }
  parts.push(formatDuration(entry.route.trafficSeconds));
  parts.push(formatDistance(entry.route.distanceMeters));
  if (entry.badges.includes('fastest')) parts.push('fastest');
  if (entry.badges.includes('eco')) parts.push('shortest');
  if (entry.badges.includes('usa')) parts.push('crosses USA');
  if (entry.badges.includes('canada-via')) parts.push(`Canada via ${entry.route.canadaVia}`);
  return parts.join(', ');
}

/**
 * Replace the on-map choice badges.
 *
 *   • Selection mode (no navigation started) — including the primary's
 *     badge. The user hasn't picked yet; seeing all candidates' times
 *     and crowns side-by-side on the map *is* the selection UI.
 *   • Navigation mode (`state.navigating === true`) — the primary's
 *     badge is suppressed; the user has already committed to a route
 *     and the line itself + bottom card stats imply the choice.
 *     Alternatives remain shown so the driver can still pick one of them.
 *
 * Only routes whose geometric midpoint is inside the current viewport
 * get a marker: a line that isn't on screen can't be selected, so its
 * badge would just be clutter.
 *
 * The chip row in the bottom card stays hidden — only the primary's
 * stats + (when applicable) the quicker-card CTA remain visible there.
 */
function renderRouteChoices() {
  clearRouteChoiceMarkers();
  // The bottom card chip row is no longer used; keep it cleared so any
  // legacy styling doesn't expand the panel.
  els.altChips.innerHTML = '';
  els.altChips.hidden = true;
  const list = buildRouteChoiceList();
  for (const entry of list) {
    // In selection mode (not yet navigating) the user still needs to
    // compare all candidates on the map — keep the primary's badge so
    // the chosen-so-far route stays in the comparison set with its
    // time, distance and (if applicable) ⚡ / 🍃 crowns visible.
    // Once navigating, the primary's badge disappears because the user
    // has already committed to that route; only alternatives remain
    // tappable on the map.
    if (entry.isPrimary && state.navigating) continue;
    if (!routeInViewport(entry.route.geometry)) continue;
    renderRouteChoiceMarker(entry);
  }
}

/**
 * Swap to a chosen alternative — the old primary becomes one itself.
 *
 * Options:
 *   silent: true when the driver is the one who chose the route via
 *     a deliberate action that already had its own UX (a mid-drive
 *     deviation, where announcing "switched to chip 2" would be
 *     noise the moment the user physically turned the wheel). The
 *     visual swap still happens; only the spoken line is suppressed.
 */
function switchToAlternative(alt, { silent = false } = {}) {
  const old = state.route;
  const rest = (state.alternatives ?? []).filter((a) => a !== alt);
  state.alternatives = old ? [old, ...rest] : rest;
  state.route = alt;
  state.lastSpokenEta = alt.eta.getTime();
  // Remember the choice — the every-minute refresh re-applies it
  // instead of yanking the user back onto the fastest route.
  state.routePreference = alt.canadaVia
    ? { canadaVia: alt.canadaVia, crossesUsa: false }
    : { crossesUsa: alt.crossesUsa };
  resetRouteOffers();
  renderRoute();
  if (silent) return;
  const kind = alt.crossesUsa
    ? 'route via the USA'
    : alt.canadaVia
      ? `Canadian route via ${alt.canadaVia}`
      : 'Canadian route';
  speak(
    `Taking the ${kind}: ${formatDuration(alt.trafficSeconds)}, arriving at ${formatTime(alt.eta)}.`
  );
}

/**
 * Great-circle distance (km) from a lon/lat point to the nearest point on
 * a polyline of [lon, lat] vertices. Used to decide whether the driver
 * has physically turned onto an alternative route.
 */
function distanceToSegmentKm(lat, lon, geom) {
  if (!Array.isArray(geom) || geom.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < geom.length; i++) {
    const [ax, ay] = geom[i - 1];
    const [bx, by] = geom[i];
    const dx = bx - ax;
    const dy = by - ay;
    const seg2 = dx * dx + dy * dy;
    let t = 0;
    if (seg2 > 0) {
      t = ((lon - ax) * dx + (lat - ay) * dy) / seg2;
      t = Math.max(0, Math.min(1, t));
    }
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = haversineKm(lat, lon, py, px);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Thresholds in metres for "this fix is on the alternative line and not
 * the active one". Tuned so a normal multi-lane road doesn't trigger a
 * phantom switch when GPS drifts; a deliberate turn onto a parallel
 * highway always exceeds both.
 */
const DEVIATION_ON_ALT_MAX_M = 50; // within 50 m of an alternative
const DEVIATION_OFF_PRIMARY_MIN_M = 80; // and > 80 m off the active route

/**
 * Called from the geolocation handler. If the vehicle is sitting on an
 * alternative route's line and clearly off the primary, promote that
 * alternative to the active one (silently — the driver already knows
 * they turned). We only fire once per alternative to avoid toggling
 * back and forth at a junction overlap.
 */
function detectRouteDeviation(lat, lon) {
  if (!state.route) return;
  const offPrimaryM = distanceToSegmentKm(lat, lon, state.route.geometry) * 1000;
  if (offPrimaryM < DEVIATION_OFF_PRIMARY_MIN_M) return; // still on the active route
  for (const alt of state.alternatives ?? []) {
    const dToAlt = distanceToSegmentKm(lat, lon, alt.geometry) * 1000;
    if (dToAlt > DEVIATION_ON_ALT_MAX_M) continue;
    switchToAlternative(alt, { silent: true });
    return;
  }
}

/** "+min" slowdown pills on the coloured line — worst stretches first. */
function setSlowdownBadges(route, range = null) {
  for (const m of state.badgeMarkers) m.remove();
  state.badgeMarkers = [];
  const inRange = (r) => !range || (r.midIdx > range.minVertex && r.midIdx < range.maxVertex);
  const candidates = (route.runs ?? [])
    .filter((r) => r.color !== TRAFFIC.colors.neutral && r.extraSeconds >= 60 && inRange(r))
    .sort((a, b) => b.extraSeconds - a.extraSeconds)
    .slice(0, TRAFFIC.maxBadges);
  for (const run of candidates) {
    const mins = Math.max(1, Math.round(run.extraSeconds / 60));
    const el = document.createElement('div');
    el.className =
      'slowdown-badge ' + (run.color === TRAFFIC.colors.heavy ? 'heavy' : 'moderate');
    el.textContent = `+${mins} min`;
    const marker = new maplibregl.Marker({ element: el }).setLngLat(run.midpoint).addTo(map);
    // The popup names the nearest town — filled in once the gazetteer lands.
    nearestTownName(run.midpoint[1], run.midpoint[0]).then((town) => {
      marker.setPopup(
        new maplibregl.Popup({ closeButton: false }).setText(
          (town ? `Near ${town} — ` : '') +
            `typical traffic adds about ${mins} min over ${Math.max(1, Math.round(run.lengthKm))} km.`
        )
      );
    });
    state.badgeMarkers.push(marker);
  }
}

/** Errands: badge only the leg currently being driven. */
function errandsBadgeRange(errands) {
  const nextIdx = errands.stops.findIndex((s) => !s.done);
  if (nextIdx === -1) return { minVertex: Infinity, maxVertex: Infinity }; // all done
  return { minVertex: -1, maxVertex: errands.legBoundaries?.[nextIdx] ?? Infinity };
}

/** Plain-language traffic note built from the coloured stretches. */
async function trafficSummary(route, { forVoice = false } = {}) {
  const slow = (route.runs ?? []).filter(
    (r) => r.color !== TRAFFIC.colors.neutral && r.extraSeconds >= 60
  );
  if (slow.length === 0) {
    return 'Roads look clear for this drive — no slowdowns expected.';
  }
  const worst = slow.reduce((a, b) => (b.extraSeconds > a.extraSeconds ? b : a));
  const mins = Math.max(1, Math.round(worst.extraSeconds / 60));
  const town = await nearestTownName(worst.midpoint[1], worst.midpoint[0]);
  const where = town ? ` near ${town}` : '';
  const heavy = worst.color === TRAFFIC.colors.heavy;
  if (slow.length === 1) {
    return forVoice
      ? `Mostly clear, with ${heavy ? 'a heavy slowdown' : 'a slow stretch'}${where} adding about ${mins} minutes.`
      : `Mostly clear — ${heavy ? 'a heavy slowdown' : 'one slow stretch'}${where} (+${mins} min)`;
  }
  return forVoice
    ? `${slow.length} slow stretches ahead — the worst${where} adds about ${mins} minutes.`
    : `${slow.length} slow stretches — worst${where} (+${mins} min)`;
}

let townCache = null;
/** Nearest gazetteer town to a point — names the slow stretches. */
async function nearestTownName(lat, lon) {
  if (!townCache) townCache = await loadPlaces();
  let best = null;
  let bestKm = Infinity;
  for (const p of townCache) {
    const km = haversineKm(lat, lon, p.la, p.lo);
    if (km < bestKm) {
      bestKm = km;
      best = p;
    }
  }
  return best ? best.n : null;
}

/* ------- USA crossings & quicker-route offers ------- */

/** Voice line for "the fastest route crosses into the USA", or null. */
function usaWarningText(route) {
  if (!route.crossesUsa) return null;
  const alts = state.alternatives ?? [];
  const idx = alts.findIndex((a) => !a.crossesUsa);
  if (idx === -1) return null;
  const via = alts[idx].canadaVia ? `, via ${alts[idx].canadaVia},` : '';
  return `Heads up: the fastest route crosses into the USA. Route ${idx + 2}${via} stays in Canada — tap its chip to switch.`;
}

/** Show/hide the USA banner; speak the warning once per route. */
function checkUsaWarning(route, { speakWarning = true } = {}) {
  const msg = usaWarningText(route);
  if (!msg) {
    els.usaBanner.hidden = true;
    return;
  }
  els.usaBanner.hidden = false;
  if (!state.usaWarned) {
    state.usaWarned = true;
    if (speakWarning) speak(msg);
  }
}

/** Identity of a quicker-route offer — its distance + adjusted time. */
function quickerKey(alt) {
  return `${Math.round(alt.distanceMeters)}-${Math.round(alt.trafficSeconds)}`;
}

/**
 * Mid-drive "Quicker route" card. Alternatives ride along with every
 * route compute (the initial one + off-route reroutes), so this only
 * reads them: offer the best one when it saves ≥
 * ALT_ROUTES.minSavingsSeconds; quietly drop a card whose advantage
 * has evaporated. Never auto-switch — the user taps Switch, or
 * dismisses.
 */
function evaluateQuickerRoute(route) {
  let alts = route.alternatives ?? [];
  // A deliberate "Stays in Canada" choice is respected — never tempt
  // the user back across the border with a quicker USA route.
  if (state.routePreference?.crossesUsa === false) {
    alts = alts.filter((a) => !a.crossesUsa);
  }
  const best = [...alts].sort((a, b) => a.trafficSeconds - b.trafficSeconds)[0];
  const savingsOf = (alt) => (alt ? route.trafficSeconds - alt.trafficSeconds : 0);

  // Card already up — keep it honest, or drop it.
  if (state.quickerRoute) {
    const savings = savingsOf(best);
    if (!best || savings < ALT_ROUTES.minSavingsSeconds) {
      state.quickerRoute = null;
      hideQuickerCard();
    } else {
      state.quickerRoute = { route: best, savingsSeconds: savings, key: quickerKey(best) };
      els.quickerText.textContent = `Quicker route · saves ~${Math.round(savings / 60)} min`;
    }
    return;
  }

  const savings = savingsOf(best);
  if (!best || savings < ALT_ROUTES.minSavingsSeconds) return;
  const key = quickerKey(best);
  if (key === state.dismissedQuickerKey) return; // the user said no to this one

  state.quickerRoute = { route: best, savingsSeconds: savings, key };
  els.quickerText.textContent = `Quicker route · saves ~${Math.round(savings / 60)} min`;
  els.quickerCard.hidden = false;
  if (state.spokenQuickerKey !== key) {
    state.spokenQuickerKey = key;
    speak(
      `A quicker route is available — it saves about ${Math.round(savings / 60)} minutes. Tap Switch to take it.`
    );
  }
}

function hideQuickerCard() {
  els.quickerCard.hidden = true;
}

/** Reset the per-route offer state — new route, new chances. */
function resetRouteOffers() {
  state.offRouteStreak = 0;
  state.lastRerouteAt = 0;
  state.usaWarned = false;
  state.quickerRoute = null;
  state.spokenQuickerKey = null;
  state.dismissedQuickerKey = null;
  hideQuickerCard();
}

els.quickerAccept.addEventListener('click', () => {
  const offer = state.quickerRoute;
  state.quickerRoute = null;
  hideQuickerCard();
  if (offer) switchToAlternative(offer.route);
});

els.quickerDismiss.addEventListener('click', () => {
  const offer = state.quickerRoute;
  state.quickerRoute = null;
  hideQuickerCard();
  if (offer) state.dismissedQuickerKey = offer.key;
});

function clearRoute() {
  state.route = null;
  state.destination = null;
  state.lastSpokenEta = null;
  state.alternatives = [];
  state.routePreference = null;
  state.kmProfile = null;
  state.speedRatio = 1;
  state.lastProgressM = 0;
  state.progressVertex = 0;
  resetRouteOffers();
  clearPoiMarkers();
  clearErrands();
  hideTurnBanner();
  stopNavigating();
  if (map.getSource('route')) {
    map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
  }
  if (map.getSource('alt-routes')) {
    map.getSource('alt-routes').setData({ type: 'FeatureCollection', features: [] });
  }
  for (const m of state.badgeMarkers) m.remove();
  state.badgeMarkers = [];
  clearRouteChoiceMarkers();
  els.altChips.innerHTML = '';
  els.altChips.hidden = true;
  els.usaBanner.hidden = true;
  if (els.startRouteBtn) els.startRouteBtn.hidden = true;
  if (state.destMarker) {
    state.destMarker.remove();
    state.destMarker = null;
  }
  for (const m of state.incidentMarkers) m.remove();
  state.incidentMarkers = [];
  els.panel.hidden = true;
  els.saveRow.hidden = true;
  els.searchInput.value = '';
  hideSuggestions();
  hideAutocomplete();
  removeDropPin();
  // Spec §3 keeps the 45° pitch — a fresh map state is just a north-
  // up bearing reset, not a flat view. The user tilts the dial for a
  // reason; we don't second-guess it on cancel.
  map.easeTo({ bearing: 0, duration: 400 });
  // Speed-limit badge has no route to source from — back to dash.
  refreshSpeedLimit();
}

/* ---------------- navigation mode ---------------- */

/*
 * Auto-follow pause. A user gesture on the map (drag, zoom, rotate,
 * pitch) stops the camera following the GPS — "let me look around" —
 * and a "Back to location" pill appears. Tapping it re-centers on
 * the latest fix and resumes the follow.
 */

/** User gesture → stop following; surface the contextual Recenter (Slot 2).
 *  Mode-independent (spec §1): works both in standby tracking and during
 *  active navigation — any pan/swipe pauses the auto-follow. */
function pauseFollow() {
  if (!state.following) return;
  state.following = false;
  els.backToLoc.hidden = false;
}

/** Recenter → re-center on the latest fix, resume following (spec §6). */
function resumeFollow() {
  state.following = true;
  els.backToLoc.hidden = true;
  const fix = state.lastFix;
  if (fix) {
    map.flyTo({
      center: [fix.lon, fix.lat],
      zoom: 17,
      essential: true,
    });
  }
}

els.backToLoc.addEventListener('click', resumeFollow);

/* Breadcrumb menu (Zone 2 focal anchor) — quick options flyout. */
function toggleBreadcrumbMenu(force) {
  const open = force ?? els.breadcrumbMenu.hidden;
  els.breadcrumbMenu.hidden = !open;
  els.breadcrumbBtn.setAttribute('aria-expanded', String(open));
}

els.breadcrumbBtn.addEventListener('click', () => {
  toggleBreadcrumbMenu();
});

document.addEventListener('pointerdown', (e) => {
  if (els.breadcrumbMenu.hidden) return;
  if (els.breadcrumbBtn.contains(e.target) || els.breadcrumbMenu.contains(e.target)) return;
  toggleBreadcrumbMenu(false);
});

function startNavigating() {
  if (!state.route) return;
  stopNavigating(); // clear any previous watch before following the new route
  stopStandbyWatch(); // the navigation watch takes over the cursor + HUD
  state.navigating = true;
  state.following = true; // fresh route → follow again; any paused pill is stale
  els.backToLoc.hidden = true;
  // The Start CTA has done its job — collapse it now that we're moving.
  if (els.startRouteBtn) els.startRouteBtn.hidden = true;
  // Mode flipped from selection → navigation. The primary's badge must
  // collapse so it doesn't compete with itself on the map; alternatives
  // remain shown so the driver can still switch while driving.
  renderRouteChoices();

  // Snap the camera to the driver immediately on tap. The standby watch
  // has been collecting fixes throughout selection mode; the most recent
  // one (state.lastFix) is fresh enough (≤ a few seconds old) to use as
  // the initial camera target. Waiting for the *next* fix to arrive
  // would make Start feel sluggish — the user already knows where they
  // are, they want the camera to follow them NOW. The subsequent nav
  // watch tick will refine the position with a fresh fix and a smooth
  // easeTo if the driver has moved since this snap.
  if (state.lastFix) {
    map.easeTo({
      center: [state.lastFix.lon, state.lastFix.lat],
      zoom: Math.max(map.getZoom(), 15.5),
      pitch: 55,
      duration: 400,
    });
  }

  if ('geolocation' in navigator) {
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lon, heading, speed } = pos.coords;
        // Cache the fix for the live re-time loop, and check whether
        // we've reached the next errands stop.
        state.lastFix = { lat, lon, at: pos.timestamp };
        state.gpsLocked = true;
        updateLocationCursor({ lat, lon, heading, speedMps: speed });
        updateSpeedHud(speed);
        checkStopProximity();
        updateTurnBanner();
        // Movement cancels the save form: the first fix of this
        // navigation is the baseline; ~100 m away means the vehicle
        // is moving and the moment to name the place has passed.
        if (!state.navFirstFix) {
          state.navFirstFix = { lat, lon };
        } else if (!els.saveRow.hidden) {
          const movedKm = haversineKm(state.navFirstFix.lat, state.navFirstFix.lon, lat, lon);
          if (movedKm >= 0.1) cancelSaveForm();
        }
        // Mid-drive: did the driver physically turn onto an alternative?
        // If so, silently promote that route to primary so the next
        // re-render doesn't fight the user's actual choice.
        detectRouteDeviation(lat, lon);
        // Local ETA math on every fix, and the off-route watch: the
        // route is computed once and only recomputed when the car
        // actually leaves it (see checkOffRoute below).
        tickNavigationEta();
        checkOffRoute(lat, lon);
        if (!state.following) return; // the user is looking around
        map.easeTo({
          center: [lon, lat],
          zoom: Math.max(map.getZoom(), 15.5),
          bearing: Number.isFinite(heading) ? heading : map.getBearing(),
          pitch: 55,
          duration: 600,
        });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
  }

  startRouteRefresh();
}

function stopNavigating() {
  state.navigating = false;
  els.backToLoc.hidden = true; // follow is over — nothing to return to
  hideTurnBanner();
  // Mode flipped back to selection: re-render so the primary's badge
  // reappears (along with any alternatives) for the next pick.
  renderRouteChoices();
  stopRouteRefresh();
  if (state.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(state.watchId);
  }
  state.watchId = null;
  state.navFirstFix = null; // next navigation gets a fresh movement baseline
  startStandbyWatch(); // spec §1: zero-touch tracking resumes post-navigation
}

/* ---------------- live navigation: local ETA + off-route reroute ---------------- */

// No periodic re-route. The route is computed once; the only slow tick
// re-pulls Ontario 511 events and re-colours the SAME geometry (local
// math, no router call). A full recompute happens only when the car
// physically leaves the route.
const TRAFFIC_REFRESH_MS = 5 * 60 * 1000;
const ARRIVED_RADIUS_KM = 0.15; // within 150 m of a stop = arrived
const SPEAK_SHIFT_SECONDS = 5 * 60; // speak when arrival shifts ≥ 5 min
// Off-route reroute: how far off the line counts as "left the route",
// how many consecutive fixes confirm it (one bad fix is GPS drift),
// and how long to wait between attempts when a reroute fails.
const REROUTE_OFF_METERS = 150; // mid-point of the 120–200 m band
const REROUTE_CONFIRM_FIXES = 2;
const REROUTE_RETRY_MS = 15 * 1000;

let refreshInFlight = false;

/**
 * The user's chip choice, re-applied after every reroute. A preference
 * set by switchToAlternative() — e.g. the guaranteed Canadian route —
 * must survive the off-route recompute, or the app would yank them
 * back onto the fastest (possibly USA) route moments after they
 * deliberately left it.
 */
function applyRoutePreference(fresh) {
  const pref = state.routePreference;
  if (!pref) return fresh;
  const pool = [fresh, ...(fresh.alternatives ?? [])];
  if (pref.canadaVia) {
    // The synthesized Canadian route — same via-town when possible.
    return (
      pool.find((r) => r.canadaVia === pref.canadaVia) ??
      pool.find((r) => !r.crossesUsa) ?? // via-town moved — any Canadian route
      fresh
    );
  }
  return pool.find((r) => r.crossesUsa === pref.crossesUsa) ?? fresh;
}

function startRouteRefresh() {
  stopRouteRefresh();
  // The every-minute full re-route is gone — see TRAFFIC_REFRESH_MS.
  // Only the 511 events re-colour rides a timer now.
  state.refreshTimer = setInterval(() => void refreshTrafficColors(), TRAFFIC_REFRESH_MS);
}

function stopRouteRefresh() {
  if (state.refreshTimer !== null) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

/** Redraw the route line without moving the camera. */
function updateRouteLine(route) {
  setRouteLine(route);
}

/** Silent errands display refresh — line, incidents, HUD, stop list. */
function updateErrandsDisplay() {
  const { errands } = state;
  if (!errands) return;
  updateRouteLine(errands);
  setIncidentMarkers(errands.incidents);
  setSlowdownBadges(errands, errandsBadgeRange(errands));
  setHud(errands);
  renderStopList();
  state.stopMarkers.forEach((m, i) => {
    if (!errands.stops[i]?.done) return;
    const el = m.getElement();
    el.classList.add('done');
    el.textContent = '✓';
  });
}

/**
 * Recompute the active route from where the car actually is. Event-
 * driven only — off-route deviation (checkOffRoute) or an errands stop
 * reached (checkStopProximity); there is no timer anymore. Silent
 * unless the arrival time shifts by five minutes or more.
 */
async function refreshActiveRoute({ reason = null } = {}) {
  if (!state.navigating || refreshInFlight) return;
  const origin = state.lastFix ?? state.origin;
  if (!origin) return;
  refreshInFlight = true;
  try {
    if (reason === 'off-route') {
      state.offRouteStreak = 0;
      speak('Rerouting.');
    }
    if (state.errands) {
      const remaining = state.errands.stops.filter((s) => !s.done);
      if (remaining.length === 0) {
        stopRouteRefresh();
        return;
      }
      const fresh = await refreshErrands(origin, remaining);
      let i = 0;
      for (const stop of state.errands.stops) {
        if (stop.done) continue;
        stop.legSeconds = fresh.stops[i].legSeconds;
        stop.arriveAt = fresh.stops[i].arriveAt;
        i++;
      }
      // Map the refreshed leg boundaries (remaining stops only)
      // back onto the full stop list — done stops keep a stale,
      // unused marker slot.
      let bi = 0;
      const legBoundaries = state.errands.stops.map((s) =>
        s.done ? -1 : fresh.legBoundaries[bi++]
      );
      Object.assign(state.errands, {
        geometry: fresh.geometry,
        distanceMeters: fresh.distanceMeters,
        freeFlowSeconds: fresh.freeFlowSeconds,
        trafficSeconds: fresh.trafficSeconds,
        eta: fresh.eta,
        congestionFactor: fresh.congestionFactor,
        incidents: fresh.incidents,
        runs: fresh.runs,
        legBoundaries,
      });
      updateErrandsDisplay();
      maybeSpeakEtaShift(fresh.eta);
    } else if (state.route && state.destination) {
      const fresh = await computeRoute(origin, state.destination);
      // Honour the user's chip choice — if they picked the Canadian
      // route (or any other), keep them on it across refreshes.
      const chosen = applyRoutePreference(fresh);
      state.route = chosen;
      state.alternatives = [fresh, ...(fresh.alternatives ?? [])].filter((r) => r !== chosen);
      updateRouteLine(chosen);
      setAltRouteLines(state.alternatives);
      setIncidentMarkers(chosen.incidents);
      setSlowdownBadges(chosen);
      // Re-render on-map choice badges so a faster lead from the latest
      // live-traffic check is visible immediately, and the user can tap
      // the badge to switch (no separate Switch CTA required).
      renderRouteChoices();
      setHud(chosen);
      evaluateQuickerRoute({ ...chosen, alternatives: state.alternatives });
      checkUsaWarning(chosen);
      if (chosen.distanceMeters <= ARRIVED_RADIUS_KM * 1000) {
        stopRouteRefresh();
        hideQuickerCard();
        speak('You have arrived at your destination.');
        return;
      }
      maybeSpeakEtaShift(chosen.eta);
    }
  } catch {
    /* transient network or routing hiccup — checkOffRoute retries */
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Slow tick: re-pull Ontario 511 events and re-colour the SAME route
 * geometry — incident delays, "+min" badges, and the per-km buckets'
 * incident shares. No router call, no camera move, no alternatives
 * churn; the local ETA engine just picks up the fresh buckets.
 */
async function refreshTrafficColors() {
  if (!state.navigating) return;
  const route = state.errands ?? state.route;
  if (!route?.geometry) return;
  try {
    const adj = await trafficAdjust(route.freeFlowSeconds, route.geometry);
    Object.assign(route, {
      trafficSeconds: adj.trafficSeconds,
      congestionFactor: adj.congestionFactor,
      incidents: adj.incidents,
      runs: adj.runs,
    });
    state.kmProfile = buildKmProfile(route); // fresh incident shares
    if (state.kmProfile) state.kmProfile.route = route;
    setRouteLine(route);
    setIncidentMarkers(route.incidents);
    setSlowdownBadges(route, state.errands ? errandsBadgeRange(state.errands) : null);
    tickNavigationEta();
  } catch {
    /* next tick */
  }
}

/**
 * Local ETA on every GPS fix — the per-km engine in js/eta.js. Live
 * speed on the current partial km, the personal speed ratio on the
 * future kms, incident delay added raw. Zero router calls: OSRM is
 * only asked for a new route when the car actually leaves this one.
 */
function tickNavigationEta() {
  const route = state.errands ?? state.route;
  if (!state.navigating || !route || !state.lastFix || !state.kmProfile) return;
  const profile = state.kmProfile;
  const prog = progressAt(profile, state.lastFix, profile.lastVertex ?? null);
  if (!prog) return;
  profile.lastVertex = prog.vertex;
  // Monotonic: a fix near a folded part of the line can't rewind the
  // remaining distance or the ETA.
  state.lastProgressM = Math.max(state.lastProgressM, prog.progressM);
  // The drawn progress follows the same monotonic anchor as the ETA,
  // at route-geometry vertex granularity.
  state.progressVertex = vertexAtM(profile, state.lastProgressM);
  updateRouteLineProgress();

  const speedKmh = state.currentSpeedKmh;
  const { index: bucketIdx, bucket } = bucketAt(profile, state.lastProgressM);
  const refKmh = bucket?.limitKmh ?? bucket?.impliedKmh ?? null;
  state.speedRatio = updateSpeedRatio(state.speedRatio, { speedKmh, refKmh });
  // Learn into the persistent profile — real driving speeds only, and
  // never on a stretch flagged with a live incident: traffic is an
  // event, not a habit. (The 45%-of-limit congestion guard and the
  // 150% GPS-glitch guard live inside the profile.) Two tiers: the
  // speed-limit bucket scalar (posted limit × multiplier) and, only
  // for persistently deviant heavily-traveled roads, a segment
  // override (OSM node pair).
  const incidentFlag = (bucket?.incidentS ?? 0) > 0;
  if (
    refKmh !== null &&
    Number.isFinite(speedKmh) &&
    speedKmh >= RATIO_SAMPLE_MIN_KMH &&
    !incidentFlag
  ) {
    driverProfile.recordSample(refKmh, speedKmh);
    if (bucket?.segKey) driverProfile.recordSegmentSample(bucket.segKey, speedKmh, refKmh);
  }

  const remain = remainingSeconds(profile, {
    progressM: state.lastProgressM,
    speedKmh,
    ratio: state.speedRatio,
    predict: (ref, segKey) => driverProfile.predictSpeed(ref, segKey),
  });
  route.trafficSeconds = Math.max(30, Math.round(remain));
  route.eta = new Date(Date.now() + route.trafficSeconds * 1000);

  // Remaining distance + time, live on every fix (not every minute).
  els.statDistance.textContent = formatDistance(Math.max(0, profile.totalM - state.lastProgressM));
  els.statDuration.textContent = formatDuration(route.trafficSeconds);
  els.statEta.textContent = formatTime(route.eta);
  maybeSpeakEtaShift(route.eta);

  void ensurePostedLimits(bucketIdx);
}

/**
 * Off-route watch. Two consecutive fixes ≥ REROUTE_OFF_METERS from the
 * active line (and outside the retry cooldown) trigger a single
 * recompute from the current position. detectRouteDeviation() above
 * already handles the cheaper case — the driver moved onto a route we
 * already have — with zero API calls.
 */
function checkOffRoute(lat, lon) {
  if (!state.navigating) {
    state.offRouteStreak = 0;
    return;
  }
  const route = state.errands ?? state.route;
  if (!route?.geometry) return;
  const offM = distanceToSegmentKm(lat, lon, route.geometry) * 1000;
  if (offM <= REROUTE_OFF_METERS) {
    state.offRouteStreak = 0;
    return;
  }
  state.offRouteStreak++;
  if (state.offRouteStreak < REROUTE_CONFIRM_FIXES) return;
  if (Date.now() - state.lastRerouteAt < REROUTE_RETRY_MS) return;
  state.lastRerouteAt = Date.now();
  state.offRouteStreak = 0;
  speak("You've left the route — rerouting.");
  void refreshActiveRoute({ reason: 'off-route' });
}

/* ---------------- posted limits (Overpass, best-effort) ---------------- */

const LIMITS_LOOKAHEAD_BUCKETS = 5; // fetch limits for the next ~5 km

/**
 * Lazily fetch posted speed limits for the buckets just ahead (once
 * per window) and stamp them into the profile. Overpass is best-effort
 * — when it's slow or down the badge and the ratio keep using the
 * router's implied speeds, so this never blocks anything.
 */
async function ensurePostedLimits(currentBucket) {
  const profile = state.kmProfile;
  if (!profile) return;
  const endBucket = Math.min(profile.buckets.length - 1, currentBucket + LIMITS_LOOKAHEAD_BUCKETS);
  if (endBucket <= state.limitsFetchedUpTo) return; // window already known
  const from = state.limitsFetchedUpTo + 1;
  // Claim the window before the fetch so concurrent fixes can't double
  // it; a failed window stays claimed — the implied-speed fallback
  // covers it, and the next route starts a fresh window.
  state.limitsFetchedUpTo = endBucket;
  // Point 0 is the CAR ITSELF, so the current bucket learns the posted
  // limit of the road under the car — not a km-midpoint blend of
  // whatever else shares the kilometre. The rest are the midpoints of
  // the buckets ahead.
  const pts = [];
  const fix = state.lastFix;
  if (fix) pts.push([fix.lat, fix.lon]);
  for (let b = from; b <= endBucket; b++) {
    const mid = (profile.buckets[b].startM + profile.buckets[b].endM) / 2;
    const v = profile.geometry[vertexAtM(profile, mid)];
    if (v) pts.push([v[1], v[0]]);
  }
  if (pts.length === 0) return;
  try {
    const out = await fetchPostedLimits(pts); // server proxy → phone-direct
    const liveIdx = fix ? 1 : 0;
    // The car's own reading wins for the current bucket.
    const cur = profile.buckets[Math.min(currentBucket, profile.buckets.length - 1)];
    if (fix && cur && Number.isFinite(out[0]?.limitKmh) && out[0].limitKmh > 0) {
      cur.limitKmh = out[0].limitKmh;
    }
    for (let i = liveIdx; i < out.length; i++) {
      const b = from + (i - liveIdx);
      if (b < profile.buckets.length && Number.isFinite(out[i]?.limitKmh) && out[i].limitKmh > 0) {
        profile.buckets[b].limitKmh = out[i].limitKmh;
      }
    }
    refreshSpeedLimit();
  } catch {
    /* best-effort — implied speeds carry the badge + ratio */
  }
}

/** Speak only when the arrival time shifts meaningfully. */
function maybeSpeakEtaShift(eta) {
  const t = eta.getTime();
  if (state.lastSpokenEta === null) {
    state.lastSpokenEta = t;
    return;
  }
  const shift = Math.abs(t - state.lastSpokenEta) / 1000;
  if (shift < SPEAK_SHIFT_SECONDS) return;
  const later = t > state.lastSpokenEta;
  state.lastSpokenEta = t;
  const mins = Math.round(shift / 60);
  speak(
    later
      ? `Traffic update: arrival is now about ${mins} minutes later, ${formatTime(eta)}.`
      : `Good news: arrival moved up about ${mins} minutes, ${formatTime(eta)}.`
  );
}

/** GPS fix landed — check whether we've reached the next errands stop. */
function checkStopProximity() {
  if (!state.errands || !state.lastFix) return;
  const next = state.errands.stops.find((s) => !s.done);
  if (!next) return;
  if (haversineKm(state.lastFix.lat, state.lastFix.lon, next.lat, next.lon) > ARRIVED_RADIUS_KM) {
    return;
  }
  next.done = true;
  const remaining = state.errands.stops.filter((s) => !s.done).length;
  const name = next.name || next.label;
  if (remaining > 0) {
    speak(`Reached ${name}. ${remaining} stop${remaining > 1 ? 's' : ''} to go.`);
    updateErrandsDisplay();
    void refreshActiveRoute(); // re-time the rest right away
  } else {
    stopRouteRefresh();
    speak(`That's the last stop — you've arrived at ${name}.`);
    updateErrandsDisplay();
  }
}

/* ---------------- turn-by-turn guidance ---------------- */

let _turnCumCache = null;
let _turnCumRoute = null;
let _turnBannerRoute = null;

/** Cumulative distance (metres) at each vertex of a route geometry. */
function getTurnCumDist(route) {
  if (_turnCumRoute === route && _turnCumCache) return _turnCumCache;
  const geo = route.geometry;
  const cum = [0];
  for (let i = 1; i < geo.length; i++) {
    cum.push(cum[i - 1] + haversineKm(geo[i - 1][1], geo[i - 1][0], geo[i][1], geo[i][0]) * 1000);
  }
  _turnCumCache = cum;
  _turnCumRoute = route;
  return cum;
}

/** Arrow character for a maneuver type + modifier. */
function turnIconFor(m) {
  const t = m.type;
  const mod = m.modifier;
  if (t === 'arrive') return '🏁';
  if (t === 'depart') return '🚗';
  if (t === 'new name') return '→';
  if (t === 'merge') return mod === 'slight left' ? '↖' : mod === 'slight right' ? '↗' : '⇥';
  if (t === 'fork') return mod === 'slight left' ? '↖' : mod === 'slight right' ? '↗' : '↕';
  if (t === 'on ramp') return '⤴';
  if (t === 'off ramp') return '⤵';
  if (t === 'end of road') return mod === 'left' ? '↰' : mod === 'right' ? '↱' : '↩';
  if (t === 'turn') {
    if (mod === 'sharp left') return '↩';
    if (mod === 'sharp right') return '↪';
    if (mod === 'slight left') return '↖';
    if (mod === 'slight right') return '↗';
    if (mod === 'left') return '↰';
    if (mod === 'right') return '↱';
    return '→';
  }
  if (t === 'continue') {
    if (mod === 'left') return '↖';
    if (mod === 'right') return '↗';
    return '↑';
  }
  return '↑';
}

/** Human-readable instruction for a maneuver. */
function turnInstructionFor(m) {
  const t = m.type;
  const mod = m.modifier;
  if (t === 'arrive') return 'Destination';
  if (m.name) return m.name;
  if (t === 'depart') return 'Head out';
  if (t === 'new name') return 'Continue';
  if (t === 'merge') return 'Merge ahead';
  if (t === 'fork') return mod ? `Take ${mod} fork` : 'Take fork';
  if (t === 'on ramp') return 'Take ramp';
  if (t === 'off ramp') return 'Take exit';
  if (t === 'end of road') return 'End of road';
  if (t === 'turn') return 'Next turn';
  if (t === 'continue') return 'Continue';
  return 'Continue';
}

/** Arrow character for a lane's indications. */
function laneArrowFor(indications) {
  if (!indications || indications.length === 0) return '·';
  const s = indications.join('+');
  if (s === 'straight') return '↑';
  if (s === 'left') return '←';
  if (s === 'right') return '→';
  if (s === 'slight left') return '↖';
  if (s === 'slight right') return '↗';
  if (s === 'straight+left') return '↑←';
  if (s === 'straight+right') return '↑→';
  if (s === 'straight+slight left') return '↑↖';
  if (s === 'straight+slight right') return '↑↗';
  if (s === 'slight left+slight right') return '↖↗';
  if (s === 'left+right') return '←→';
  return s;
}

/** Render the lane guidance row. */
function renderTurnLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    els.turnLanes.hidden = true;
    els.turnLanes.innerHTML = '';
    return;
  }
  els.turnLanes.innerHTML = '';
  for (const lane of lanes) {
    const div = document.createElement('div');
    div.className = 'lane' + (lane.valid ? ' valid' : '');
    div.textContent = laneArrowFor(lane.indications);
    div.title = lane.valid ? 'Use this lane' : 'Not for this turn';
    els.turnLanes.appendChild(div);
  }
  els.turnLanes.hidden = false;
}

/**
 * Update the turn banner based on the current GPS fix.
 * Finds the next upcoming maneuver and shows its icon, instruction,
 * distance along the route, and lane guidance.
 */
function updateTurnBanner() {
  const route = state.route;
  if (!route || !Array.isArray(route.maneuvers) || route.maneuvers.length === 0) {
    hideTurnBanner();
    return;
  }
  if (!state.lastFix) {
    hideTurnBanner();
    return;
  }

  // Reset spoken tracking if the route object changed (refresh).
  if (_turnBannerRoute !== route) {
    _turnBannerRoute = route;
    state.turnSpoken = null;
  }

  const { lat, lon } = state.lastFix;
  const geometry = route.geometry;
  if (!Array.isArray(geometry) || geometry.length < 2) {
    hideTurnBanner();
    return;
  }

  // Find the nearest vertex to the vehicle.
  let nearestIdx = 0;
  let nearestDist = Infinity;
  const stride = Math.max(1, Math.floor(geometry.length / 400));
  for (let i = 0; i < geometry.length; i += stride) {
    const d = haversineKm(geometry[i][1], geometry[i][0], lat, lon);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }

  // Find the next maneuver ahead of the vehicle.
  const next = route.maneuvers.find((m) => m.vertexIndex >= nearestIdx);
  if (!next) {
    hideTurnBanner();
    return;
  }

  // Distance along the route to the maneuver.
  const cum = getTurnCumDist(route);
  const distM = Math.max(0, cum[next.vertexIndex] - cum[nearestIdx]);

  // Update the banner.
  els.turnIcon.textContent = turnIconFor(next);
  els.turnInstruction.textContent = turnInstructionFor(next);
  els.turnDistance.textContent = `in ${formatDistance(distM)}`;
  renderTurnLanes(next.lanes);
  els.turnBanner.hidden = false;

  // Voice cue: speak the turn when within 500 m, once per maneuver.
  const key = `${next.type}/${next.modifier}/${next.vertexIndex}`;
  if (distM <= 500 && state.turnSpoken !== key) {
    state.turnSpoken = key;
    speak(turnInstructionFor(next));
  }
}

function hideTurnBanner() {
  els.turnBanner.hidden = true;
  state.turnSpoken = null;
  state.currentSpeedKmh = null;
  state.speedLimitBand = null; // Spec §10.9 — restart hysteresis on new destination
  // NOTE: centeredOnFirstFix / gpsLocked are NOT reset here — the
  // zero-touch standby watch (spec §1) keeps the cursor live across
  // navigation end, and re-flying the camera on every trip end would
  // yank the user's viewport. Only a full page reload re-centers.
  updateSpeedHud(null);
}

/* ---------------- events ---------------- */

els.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  els.searchInput.blur();
  handleDestinationQuery(els.searchInput.value);
});

els.micBtn.addEventListener('click', async () => {
  if (!isVoiceSupported()) {
    showStatus('Voice input is not supported in this browser — type your address instead.');
    return;
  }
  els.micBtn.classList.add('listening');
  showStatus('Listening… say a Canadian address.', { sticky: true });
  try {
    const transcript = await listenOnce({
      onEnd: () => els.micBtn.classList.remove('listening'),
    });
    els.searchInput.value = transcript;
    handleDestinationQuery(transcript);
  } catch (err) {
    els.micBtn.classList.remove('listening');
    showStatus(err.message);
  }
});

/* End navigation: the ✕ on the route card, or clearing the search box. */
els.closeBtn.addEventListener('click', () => {
  clearRoute();
  showStatus('Navigation ended.');
});

/* Begin navigation: the route-panel Start CTA — the only gesture that
 * starts navigation. In selection mode the user taps this to commit to
 * the current primary route; navigation begins and the button collapses. */
els.startRouteBtn.addEventListener('click', () => {
  if (!state.route) return;
  startNavigating();
});

/* ---------------- save-as-place (🏷️) ---------------- */

/**
 * Save the active destination under a name ("Grandma's House") with
 * optional tags ("family") — then "go to Grandma's House" just works.
 */
function saveCurrentDestination() {
  const d = state.destination;
  if (!d) return;
  const name = els.saveName.value.trim();
  if (!name) {
    showStatus('Give the place a name first — e.g. “Grandma’s House”.');
    els.saveName.focus();
    return;
  }
  const tags = els.saveTags.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  savePlace({ name, tags, lat: d.lat, lon: d.lon, label: d.label });
  els.saveRow.hidden = true;
  showStatus(`Saved “${name}” — next time, just say “go to ${name}”.`);
  speak(`Saved ${name}. Next time, just say, go to ${name}.`);
}

els.saveBtn.addEventListener('click', saveCurrentDestination);
for (const input of [els.saveName, els.saveTags]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrentDestination();
    }
  });
}

/** Hide the save form without saving — the ✕, or movement. */
function cancelSaveForm() {
  if (els.saveRow.hidden) return;
  els.saveRow.hidden = true;
  els.saveName.value = '';
  els.saveTags.value = '';
  showStatus('Save cancelled.');
}

els.saveCancel.addEventListener('click', cancelSaveForm);

els.searchInput.addEventListener('input', () => {
  const value = els.searchInput.value;
  if (!value.trim()) {
    hideAutocomplete();
    clearRoute();
    return;
  }
  // Recover the raw typed text when an inline completion is applied:
  // typing over the selected remainder yields typed-prefix + new chars.
  let typed = value;
  if (AC.full && value.length > AC.typed.length) {
    const prefix = value.slice(0, AC.typed.length);
    if (prefix.toLowerCase() === AC.typed.toLowerCase()) {
      typed = AC.typed + value.slice(AC.typed.length);
    }
  }
  AC.typed = typed;
  scheduleAutocomplete(typed);
});

/* No auto-popup on focus: tapping into the address bar just readies
   it for typing. The typeahead (saved places + recent trips + Photon
   addresses) appears once the user types — one consistent UI, and it
   never sits between the user and the keyboard. */

/* ---------------- tap-to-navigate (long-press the map) ---------------- */

/*
 * Long-press (or right-click) the map → a pin drops with a
 * "Navigate here" popup. Reverse-geocoding gives the pin a readable
 * label; the route card then offers the same 🏷️ save form as a typed
 * destination. Once the vehicle moves ~100 m, the save form cancels
 * itself — the moment to name the place has passed.
 */

const LONG_PRESS_MS = 550;

let pressTimer = null;
let pressStart = null;
let lastTouchPinAt = 0; // touch long-press marker — contextmenu dedupe

function removeDropPin() {
  // Null the state first: popup.remove() fires "close", whose handler
  // calls back in here — by then there's nothing left to remove.
  const pin = state.dropPin;
  const popup = state.dropPopup;
  state.dropPin = null;
  state.dropPopup = null;
  if (pin) pin.remove();
  if (popup) popup.remove();
}

function showDropPin(lngLat) {
  removeDropPin();
  const el = document.createElement('div');
  el.className = 'drop-pin';
  state.dropPin = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat(lngLat)
    .addTo(map);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-here-btn';
  btn.textContent = 'Navigate here';
  btn.addEventListener('click', () => {
    removeDropPin();
    void navigateToPin(lngLat);
  });

  // The popup needs a position before addTo(): MapLibre's internal
  // _update() refuses to render without one, which is why v0.2.14
  // showed an empty dialogue. It's tracked on state (not via
  // marker.setPopup) so removeDropPin() tears down exactly what was
  // added — no orphaned popups.
  const popup = new maplibregl.Popup({ closeButton: true, offset: 24 })
    .setLngLat(lngLat)
    .setDOMContent(btn);
  // Closing the popup (its ✕) takes the pin with it.
  popup.on('close', () => removeDropPin());
  state.dropPopup = popup;
  popup.addTo(map);
}

async function navigateToPin(lngLat) {
  const { lat, lng: lon } = lngLat;
  showStatus('Finding what’s there…', { sticky: true });
  try {
    const dest = await reverseGeocode(lat, lon);
    await routeToDestination(dest);
  } catch (err) {
    hideStatus();
    showStatus(err.message || 'Could not route to that spot.');
  }
}

// Long-press on touch, contextmenu (right-click / long-press) as a
// desktop-friendly equivalent. A drag or a second touch cancels the
// press — only a still, deliberate hold drops the pin.
map.getCanvasContainer().addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  pressStart = { x: t.clientX, y: t.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    lastTouchPinAt = Date.now();
    showDropPin(map.unproject([t.clientX, t.clientY]));
  }, LONG_PRESS_MS);
}, { passive: true });

map.getCanvasContainer().addEventListener('touchmove', (e) => {
  if (!pressStart) return;
  const t = e.touches[0];
  if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) {
    clearTimeout(pressTimer);
    pressTimer = null;
    pressStart = null;
  }
}, { passive: true });

map.getCanvasContainer().addEventListener('touchend', () => {
  clearTimeout(pressTimer);
  pressTimer = null;
  pressStart = null;
});

map.getCanvasContainer().addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Android fires contextmenu right after a touch long-press already
  // dropped the pin — don't stack a second one on top of it.
  if (Date.now() - lastTouchPinAt < 800) return;
  showDropPin(map.unproject([e.clientX, e.clientY]));
});

/* Typeahead keys: arrows move, Enter picks, Tab accepts, Esc dismisses. */
els.searchInput.addEventListener('keydown', (e) => {
  if (e.isComposing || !AC.open || AC.items.length === 0) return;
  const n = AC.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    AC.active = (AC.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    highlightAc();
  } else if (e.key === 'Enter') {
    e.preventDefault(); // the highlighted suggestion is the destination
    pickAcItem(Math.max(AC.active, 0));
  } else if (e.key === 'Tab' && AC.full) {
    e.preventDefault(); // keep focus in the search box
    AC.typed = AC.full;
    AC.full = '';
    els.searchInput.setSelectionRange(AC.typed.length, AC.typed.length);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    els.searchInput.value = AC.typed; // strip the inline completion
    hideAutocomplete();
  }
});

els.searchInput.addEventListener('blur', () => hideAutocomplete());

/* ---------------- voice-guidance mute toggle ---------------- */

function refreshVoiceToggle() {
  const muted = isMuted();
  els.voiceToggle.classList.toggle('muted', muted);
  els.voiceToggle.setAttribute('aria-pressed', String(muted));
  els.voiceToggle.setAttribute(
    'aria-label',
    muted ? 'Unmute voice guidance' : 'Mute voice guidance'
  );
  els.voiceToggle.title = muted ? 'Voice guidance off' : 'Voice guidance on';
}

els.voiceToggle.addEventListener('click', () => {
  setMuted(!isMuted());
  refreshVoiceToggle();
  showStatus(isMuted() ? 'Voice guidance off.' : 'Voice guidance on.');
});
refreshVoiceToggle();

if (!isVoiceSupported()) {
  els.micBtn.disabled = true;
  els.micBtn.title = 'Voice input not supported in this browser';
}

/* ---------------- PWA install prompt ---------------- */

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Keep the browser's mini-infobar from appearing; show our own button.
  e.preventDefault();
  deferredInstallPrompt = e;
  els.installBtn.hidden = false;
});

els.installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try {
    await deferredInstallPrompt.userChoice;
  } catch {
    /* user dismissed — non-fatal */
  }
  deferredInstallPrompt = null;
  els.installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  els.installBtn.hidden = true;
  showStatus('Schmaps installed — happy trails, eh.');
});

/* ---------------- service worker + self-update ---------------- */

let swRegistration = null;
let reloading = false;

// "Not now" is remembered per version — the prompt stays away, even
// across refreshes, until a genuinely newer worker is waiting.
const DISMISS_KEY = 'schmaps-dismissed-sw-version';

function showUpdateBar() {
  els.updateBar.hidden = false;
}

function hideUpdateBar() {
  els.updateBar.hidden = true;
}

/**
 * Ask a worker which VERSION it is (message handshake; workers that
 * predate the handler resolve to null after a short timeout).
 */
function getWorkerVersion(worker) {
  return new Promise((resolve) => {
    if (!worker) return resolve(null);
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => done(e.data?.version ?? null);
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      setTimeout(() => done(null), 1500);
    } catch {
      done(null);
    }
  });
}

/** Show the update prompt unless the user dismissed this exact version. */
async function maybeShowUpdateBar(worker) {
  const w = worker ?? swRegistration?.waiting;
  if (!w) return;
  let dismissed = null;
  try {
    dismissed = localStorage.getItem(DISMISS_KEY);
  } catch {
    /* private mode — just show the prompt */
  }
  const version = await getWorkerVersion(w);
  if (version && version === dismissed) return;
  showUpdateBar();
}

/**
 * Wipe every cache and reload — the fresh worker (or the network, if
 * the swap failed) re-serves the shell. Used both when a new worker
 * takes over and as the Update button's safety net, so a stuck update
 * can never leave the app on a stale shell.
 */
async function hardReload() {
  if (reloading) return;
  reloading = true;
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best-effort — reload regardless */
  }
  window.location.reload();
}

/**
 * Pull the live `sw.js` (cache-bypassed) and grab the VERSION it
 * declares. Used to detect a deploy that the browser's normal SW update
 * flow missed (e.g. a worker that skippedWaiting itself earlier, or a
 * CDN that served a 304 for a body that did change).
 */
async function fetchSwVersion() {
  try {
    const res = await fetch('sw.js', { cache: 'no-store' });
    if (!res.ok) return null;
    const txt = await res.text();
    const m = txt.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Ask the registry for a newer sw.js. If one has already installed and
 * is waiting, prompt the user — never swap versions under them.
 *
 * Belt-and-braces: also fetch the live sw.js body and compare its
 * declared VERSION to the active worker's. If they differ but
 * `reg.waiting` is still null (browser hasn't noticed the new body),
 * re-register to force the install + prompt.
 */
async function checkForUpdates() {
  if (!swRegistration) return;
  try {
    const reg = await swRegistration.update();
    if (reg.waiting) {
      void maybeShowUpdateBar(reg.waiting);
      return;
    }
    // Safety net: did the live sw.js change but the browser say nothing?
    const liveVersion = await fetchSwVersion();
    if (!liveVersion) return;
    const activeVersion = await getWorkerVersion(navigator.serviceWorker.controller);
    if (activeVersion && activeVersion !== liveVersion) {
      // Force the new body to be picked up and installed.
      await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      const reg2 = await navigator.serviceWorker.getRegistration();
      const next = reg2?.waiting ?? reg2?.installing;
      if (next) void maybeShowUpdateBar(next);
    }
  } catch {
    /* offline or unsupported — try again on the next tick */
  }
}

if ('serviceWorker' in navigator) {
  // Reload when a new worker takes over — but only for pages that were
  // already controlled (a first install must not reload). A page must
  // never keep running a stale app shell after a deploy: an old app.js
  // reaching for elements the new index.html no longer has crashes.
  const hadController = Boolean(navigator.serviceWorker.controller);

  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => hardReload());
  }

  window.addEventListener('load', async () => {
    try {
      swRegistration = await navigator.serviceWorker.register('sw.js');
    } catch {
      return; // offline support is best-effort
    }

    // A newer worker may already be waiting from a previous session.
    if (hadController && swRegistration.waiting) void maybeShowUpdateBar();

    // A worker that finishes installing while this tab is open → prompt.
    swRegistration.addEventListener('updatefound', () => {
      const next = swRegistration.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          void maybeShowUpdateBar(next);
        }
      });
    });

    // Check on launch, every 15 minutes, and when the tab becomes
    // visible again (throttled to once a minute).
    checkForUpdates();
    setInterval(checkForUpdates, 15 * 60 * 1000);
    let lastVisibleCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastVisibleCheck >= 60 * 1000) {
        lastVisibleCheck = Date.now();
        checkForUpdates();
      }
    });
  });

  // "Update" — swap to the waiting worker. Bulletproof by design: even
  // if the worker state changed since the prompt appeared, or the swap
  // never reaches us, the safety net below always lands on a fresh page.
  els.updateBtn.addEventListener('click', async () => {
    hideUpdateBar();
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* non-fatal */
    }
    showStatus('Updating to the latest version…', { sticky: true });

    // Safety net: no matter what happens below — no waiting worker, a
    // postMessage that never arrives, a controllerchange we never see —
    // the user still gets a cache-cleared reload within 4 seconds.
    setTimeout(hardReload, 4000);

    try {
      // Re-query the registry — the waiting worker may have changed or
      // vanished since the prompt appeared.
      if (!swRegistration) {
        swRegistration = await navigator.serviceWorker.register('sw.js');
      }
      await swRegistration.update().catch(() => {});
      const candidate = swRegistration.waiting || swRegistration.installing;
      if (!candidate) return; // nothing to swap — the reload is the fix
      const swap = () => candidate.postMessage({ type: 'SKIP_WAITING' });
      if (candidate.state === 'installed') {
        swap();
      } else {
        // Still installing — swap the moment it's ready.
        candidate.addEventListener('statechange', () => {
          if (candidate.state === 'installed') swap();
        });
      }
    } catch {
      /* the safety-net reload above still runs */
    }
  });

  // "Not now" — remember this version so the prompt stays away, even
  // across refreshes, until a genuinely newer worker is waiting.
  els.updateDismiss.addEventListener('click', async () => {
    const w = swRegistration?.waiting ?? swRegistration?.installing;
    const version = await getWorkerVersion(w);
    if (version) {
      try {
        localStorage.setItem(DISMISS_KEY, version);
      } catch {
        /* non-fatal */
      }
    }
    hideUpdateBar();
  });
}
