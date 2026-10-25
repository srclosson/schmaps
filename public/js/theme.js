/**
 * Theme system — Spec §10 (Light / Dark / System / Lighting).
 *
 * Responsibilities:
 *   1. Resolve the user's chosen mode (light/dark/system/lighting) into a
 *      concrete {light|dark} resolved value, re-evaluating on:
 *        - a `prefers-color-scheme` media-query change (system),
 *        - a `devicelight` change smoothed by a low-pass filter
 *          (lighting — Spec §10.5, α = 0.2),
 *        - a manual menu pick (light/dark/system/lighting).
 *   2. Persist the chosen mode in localStorage['schmaps.theme'].
 *   3. Reflect the mode on the data-theme-mode/data-theme attributes so the
 *      CSS tokens flip (Spec §10.7) and update the menu's aria-pressed
 *      state (Spec §10.2).
 *   4. Swap the OpenFreeMap map style when resolved flips light↔dark
 *      (Spec §10.6) by hitting GET /api/osm/style?theme=… and re-adding
 *      any app-managed sources/layers after map.setStyle completes.
 *
 * Architecture:
 *   - This module is loaded as a classic <script> *before* js/app.js so it
 *     can mutate MAP.style (config.js export) BEFORE the map is
 *     constructed. The inline <head> script in index.html has already set
 *     `data-theme` and `data-theme-mode` for FOUC prevention — we just
 *     re-affirm them here once sensors are reachable.
 *   - The map instance is created in app.js; this module exports a
 *     `bindMap(map)` function that app.js calls inside its
 *     `map.on('load', …)` handler. After binding, every resolved-theme
 *     flip calls map.setStyle(url, { diff: false }) and re-adds our
 *     route/alt-route sources via app.js's onStyleReady() callback.
 */

import { MAP } from './config.js';

const STORAGE_KEY = 'schmaps.theme';

/* ---------- state ---------- */

const themeState = {
  /** User-chosen mode: 'light' | 'dark' | 'system' | 'lighting' */
  mode: 'system',
  /** Currently-applied resolved value: 'light' | 'dark' */
  resolved: 'light',
  /** Smoothed ambient-light reading, lux (Spec §10.5). */
  smoothedLux: null,
  /** Bound map instance once app.js hands it over. */
  map: null,
  /** Callback to re-add app-managed sources/layers after a style swap. */
  onStyleReady: null,
  // If the user picks a mode before bindMap() has run (i.e. while the
  // initial OSM style is still loading), the click would otherwise be
  // silently dropped because applyMapTheme bails when the map is null.
  // We stash the resolved value here and replay it from bindMap()
  // the moment the map is bound. Fix for: map stays dark when user
  // taps Light during the first few seconds before map.on(load).
  pendingResolved: null,
  // Monotonic counter; bumped on every applyMapTheme() entry. Used to
  // drop stale fetches when the user changes theme again before the
  // previous fetch resolves.
  swapToken: 0,
};

/* ---------- small helpers ---------- */

function readMode() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' || raw === 'lighting'
      ? raw
      : 'system';
  } catch {
    return 'system';
  }
}

function writeMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* private mode / quota — ignore */
  }
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Spec §10.4 — flatten the 4-mode matrix into a concrete {light|dark}.
 * `lighting` uses the smoothed lux with the threshold from §10.5
 * (≤ 20 lux → dark, otherwise light) and falls back to OS preference
 * if no sensor reading is available yet (first frame, iOS, denied).
 */
function resolveTheme(mode, ctx) {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode === 'system') return ctx.systemPrefersDark() ? 'dark' : 'light';
  // mode === 'lighting'
  if (ctx.smoothedLux === null || !Number.isFinite(ctx.smoothedLux)) {
    // No reading yet — graceful fallback per Spec §10.5.
    return ctx.systemPrefersDark() ? 'dark' : 'light';
  }
  return ctx.smoothedLux <= 20 ? 'dark' : 'light';
}

/* ---------- reactive listeners ---------- */

// Track the *original* handler refs so removeEventListener matches and
// the listeners actually get torn down when the user changes mode.
let systemMq = null;
let systemHandler = null;
let deviceLightHandler = null;

function startSystemListener(onChange) {
  systemMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (!systemMq) return;
  systemHandler = () => onChange();
  if (systemMq.addEventListener) systemMq.addEventListener('change', systemHandler);
  else if (systemMq.addListener) systemMq.addListener(systemHandler); // Safari < 14
}

function startLightingListener(onChange) {
  // Spec §10.5 — `devicelight` events carry a lux value. α = 0.2 low-pass
  // filters out noise (passing under a street lamp, screen-on reflection).
  deviceLightHandler = (ev) => {
    if (!ev || !Number.isFinite(ev.value)) return;
    const lux = ev.value;
    themeState.smoothedLux =
      themeState.smoothedLux === null ? lux : 0.2 * lux + 0.8 * themeState.smoothedLux;
    onChange();
  };
  window.addEventListener('devicelight', deviceLightHandler);
}

function stopSystemListener() {
  if (!systemMq) return;
  if (systemMq.removeEventListener && systemHandler) {
    systemMq.removeEventListener('change', systemHandler);
  } else if (systemMq.removeListener && systemHandler) {
    systemMq.removeListener(systemHandler);
  }
  systemMq = null;
  systemHandler = null;
}

function stopLightingListener() {
  if (deviceLightHandler) {
    window.removeEventListener('devicelight', deviceLightHandler);
    deviceLightHandler = null;
  }
}

/* ---------- DOM (menu buttons) ---------- */

const THEME_BUTTON_IDS = ['theme-light', 'theme-dark', 'theme-system', 'theme-lighting'];

function renderThemeButtons() {
  for (const id of THEME_BUTTON_IDS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const isActive = btn.getAttribute('data-theme-mode') === themeState.mode;
    btn.setAttribute('aria-pressed', String(isActive));
  }
}

function bindMenuButtons() {
  for (const id of THEME_BUTTON_IDS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-theme-mode');
      if (!next) return;
      setMode(next);
    });
  }
}

/* ---------- map style swap (Spec §10.6) ---------- */

function buildStyleUrl(theme) {
  // MAP.style is configured in js/config.js to '/api/osm/style'. On
  // init, primeStyleUrl() mutates MAP.style to include ?theme=<mode>
  // so the *initial* map construction uses the right URL. That means
  // on every subsequent call MAP.style already carries a `theme=`
  // param — appending another one would yield `?theme=dark&theme=light`,
  // and the Node server (which honours the FIRST theme param via
  // req.query) would return the wrong style. Strip any pre-existing
  // theme= from MAP.style before appending the new one.
  const base = MAP.style.replace(/[?&]theme=[^&]*/g, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}theme=${theme}`;
}

/**
 * Fetch the style JSON from the proxy. We pass the parsed object to
 * map.setStyle() (not the URL) to:
 *   1. defeat MapLibre's internal style cache, which can serve a stale
 *      JSON even when the URL changed;
 *   2. skip MapLibre's diff logic entirely — we want a hard reset, not
 *      an incremental patch, so the new background/road/building paints
 *      take effect on every layer that shares an id with the old style.
 * cache:'no-store' also busts any browser HTTP-cache snapshot.
 */
async function fetchStyleJson(resolved) {
  const url = buildStyleUrl(resolved);
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`style fetch ${res.status} for ${url}`);
  const j = await res.json();
  // Force a fresh deep-clone of layers/paint. MapLibre's painter
  // uses object identity (not deep equality) to decide whether a
  // paint property changed; reusing the same parsed JSON across
  // two setStyle() calls can therefore skip the re-paint entirely.
  // We rebuild each layer object so every paint/layout/source-layer
  // object is a fresh reference, guaranteeing a full repaint.
  if (Array.isArray(j.layers)) {
    j.layers = j.layers.map((l) => {
      // Rebuild layer with fresh paint/layout/filter objects ONLY if
      // those fields are present in the source. MapLibre's validator
      // rejects `layout: undefined` (object expected, undefined
      // found) and `filter: undefined` (array expected, undefined
      // found), so we must omit the key entirely when absent.
      const out = { ...l };
      if (l.paint) out.paint = { ...l.paint };
      if (l.layout) out.layout = { ...l.layout };
      if (l.filter) out.filter = JSON.parse(JSON.stringify(l.filter));
      return out;
    });
  }
  return j;
}

/**
 * Fetch the requested theme style JSON from the server proxy and apply
 * it to the bound map. After the style loads, re-fire onStyleReady so
 * app.js can re-add route/alt-route/cursor sources.
 *
 * `onStyleReady` is called once `map.isStyleLoaded()` is true. We pass
 * the new style JSON so app.js can wire it up the same way the initial
 * load does — keeping a single source of truth for "what does the map
 * need after a style swap".
 */
async function applyMapTheme(resolved) {
  const m = themeState.map;
  console.log('[theme] applyMapTheme resolved=', resolved, 'map=', m ? 'BOUND' : 'null', 'cur=', themeState.resolved, 'pending=', themeState.pendingResolved);
  if (!m) {
    // Map not bound yet — initial style is still fetching. Stash the
    // desired resolved value so bindMap() can replay it the moment the
    // map is bound. Without this, a user tap during the first 2-3s
    // would be silently dropped and the map would stay on its initial
    // (potentially mismatched) style for the rest of the session.
    themeState.pendingResolved = resolved;
    return;
  }
  if (themeState.resolved === resolved) return; // no-op
  // Bump the swap token so any in-flight applyMapTheme from a previous
  // tap can detect "I'm stale" after its fetch resolves and bail
  // instead of calling setStyle with the wrong theme.
  const myToken = ++themeState.swapToken;
  themeState.resolved = resolved;
  themeState.pendingResolved = null;

  // Fetch the JSON ourselves and hand MapLibre the parsed object.
  // See fetchStyleJson() for why this beats setStyle(url, {diff:false}).
  let styleObj;
  try {
    styleObj = await fetchStyleJson(resolved);
    // If a newer swap started while we were fetching, drop this one.
    if (myToken !== themeState.swapToken) {
      console.log('[theme] stale fetch for', resolved, 'token', myToken, '!=', themeState.swapToken, '— bailing');
      return;
    }
    const url = buildStyleUrl(resolved);
    // Inspect what we got back: id of background layer and its color.
    const bg = styleObj.layers?.find((l) => l.id === 'background');
    const bgColor = bg?.paint?.['background-color'];
    const hash = Array.from(new TextEncoder().encode(JSON.stringify(styleObj)))
      .reduce((a,b) => (a*31 + b) | 0, 0);
    console.log('[theme] fetched url=', url, 'layers=', styleObj.layers?.length, 'bg=', bgColor, 'jsonHash=', hash);
  } catch (err) {
    console.error('[theme] style fetch failed:', err);
    return;
  }
  // diff:false is a belt-and-braces fallback in case MapLibre's
  // object-mode code path tries to patch.
  m.setStyle(styleObj, { diff: false });

  // Wait for the style to actually be applied to the GL context, not
  // just the JSON to be parsed. `style.load` fires after paint setup
  // but before all tile fetches resolve; `idle` is the safer signal
  // that every layer has re-evaluated against the new style.
  const onIdle = () => {
    m.off('idle', onIdle);
    m.off('style.load', onIdle);
    console.log('[theme] idle after setStyle; onStyleReady=', typeof themeState.onStyleReady);
    if (typeof themeState.onStyleReady === 'function') {
      themeState.onStyleReady(resolved);
    }
  };
  m.once('style.load', onIdle);
  m.once('idle', onIdle);
}

/* ---------- apply the full state to the page ---------- */

/**
 * Rewrite the active <meta name="theme-color"> to match the resolved
 * theme. We can't rely on the `media` attribute alone because the user
 * may have explicitly picked 'light' or 'dark' which contradicts the
 * system preference — in that case the media-matching tag would still
 * fire on Android Chrome, painting the wrong color behind the status
 * bar. By keeping a third "override" tag with no `media` and editing its
 * `content` from JS, we win for every combination of mode × system.
 *
 * Solid colors are mandatory — Android Chrome drops the alpha channel
 * on theme-color (it paints a solid bar regardless), and a transparent
 * value yields a browser-default (often white) that's jarring against
 * the dark map canvas. The values mirror the CSS tokens --nav-bg so the
 * bar blends with the map's letterbox at the top edge before tiles
 * paint.
 */
const THEME_COLOR_BY_RESOLVED = {
  light: '#e2e8f0',
  dark: '#0e1116',
};

function applyThemeColor(resolved) {
  const color = THEME_COLOR_BY_RESOLVED[resolved] || THEME_COLOR_BY_RESOLVED.light;
  // Find the override tag (the one WITHOUT a `media` attribute). That's
  // our JS-controlled slot. The other two with `media=` are left alone
  // so OS-level flips still work for users on 'system' mode.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    if (!m.hasAttribute('media')) {
      m.setAttribute('content', color);
      return;
    }
  }
}

function applyResolved(resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', themeState.mode);
  applyThemeColor(resolved);
  renderThemeButtons();
  return applyMapTheme(resolved);
}

function applyTheme() {
  const resolved = resolveTheme(themeState.mode, {
    systemPrefersDark,
    smoothedLux: themeState.smoothedLux,
  });
  if (resolved === themeState.resolved && themeState.map) {
    // Already in this resolved state; just make sure buttons + attrs are fresh.
    document.documentElement.setAttribute('data-theme-mode', themeState.mode);
    renderThemeButtons();
    return;
  }
  return applyResolved(resolved);
}

/* ---------- mode transitions ---------- */

function setMode(next) {
  console.log('[theme] setMode next=', next, 'curMode=', themeState.mode, 'curResolved=', themeState.resolved, 'map=', themeState.map ? 'BOUND' : 'null');
  if (next !== 'light' && next !== 'dark' && next !== 'system' && next !== 'lighting') return;
  if (themeState.mode === next) return;
  themeState.mode = next;
  writeMode(next);
  stopSystemListener();
  stopLightingListener();

  // Apply data-theme-mode immediately so the menu highlights update
  // even if listener-driven resolution doesn't run (e.g. switching to
  // 'light' from 'lighting').
  document.documentElement.setAttribute('data-theme-mode', next);
  renderThemeButtons();

  // 'light'/'dark' need no sensor, just resolve + swap map style.
  if (next === 'light' || next === 'dark') {
    return applyResolved(next);
  }
  if (next === 'system') {
    startSystemListener(applyTheme);
    return applyTheme();
  }
  // next === 'lighting'
  startLightingListener(applyTheme);
  startSystemListener(applyTheme); // fallback per Spec §10.5
  return applyTheme();
}

/* ---------- public API ---------- */

/**
 * Called by app.js from inside its `map.on('load', …)` handler once the
 * initial style has loaded and any sources/layers it adds on first
 * load are in place.
 */
export function bindMap(mapInstance, onStyleReady) {
  console.log('[theme] bindMap pendingResolved=', themeState.pendingResolved, 'curResolved=', themeState.resolved);
  themeState.map = mapInstance;
  themeState.onStyleReady = onStyleReady || null;
  // If the user picked a mode (or a sensor fired) before the map was
  // bound, applyMapTheme stashed the desired resolved value in
  // pendingResolved. Replay it now so the visible map style matches
  // the user's intent.
  if (themeState.pendingResolved &&
      themeState.pendingResolved !== themeState.resolved) {
    const replay = themeState.pendingResolved;
    themeState.pendingResolved = null;
    themeState.resolved = replay;
    (async () => {
      let styleObj;
      try {
        styleObj = await fetchStyleJson(replay);
      } catch (err) {
        console.error('[theme] bindMap replay fetch failed:', err);
        return;
      }
      themeState.map.setStyle(styleObj, { diff: false });
      const onIdle = () => {
        themeState.map.off('idle', onIdle);
        themeState.map.off('style.load', onIdle);
        if (typeof themeState.onStyleReady === 'function') {
          themeState.onStyleReady(replay);
        }
      };
      themeState.map.once('style.load', onIdle);
      themeState.map.once('idle', onIdle);
    })();
    return;
  }
  themeState.pendingResolved = null;
  // Re-evaluate now that the map is bound — if the resolved theme has
  // flipped (e.g. localStorage said 'dark' but we painted light because
  // of a race), bring the map in sync with the DOM.
  return applyTheme();
}

/**
 * Returns the style URL the map should be *initialized* with, taking
 * the persisted user preference into account. Called once at module
 * load; we mutate MAP.style so app.js's `new maplibregl.Map({style: …})`
 * gets the right URL without any extra wiring.
 */
export function primeStyleUrl() {
  const mode = readMode();
  themeState.mode = mode;
  // The inline <head> script already wrote data-theme with a best-effort
  // guess. We re-affirm it here using the resolver so the very first
  // map paint matches what the resolver would pick (e.g. sensor data
  // is unavailable so system mode wins).
  const resolved = resolveTheme(mode, { systemPrefersDark, smoothedLux: null });
  themeState.resolved = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', mode);
  applyThemeColor(resolved);
  return buildStyleUrl(resolved);
}

/** Public getter — used by app.js or tests to read the current mode. */
export function getThemeMode() {
  return themeState.mode;
}

/** One-time bootstrap. Called automatically via initTheme() below. */
export function initTheme() {
  bindMenuButtons();
  // Prime MAP.style so the very first map paint uses the correct
  // theme URL. This is a write-once mutation — subsequent setStyle
  // calls go through applyMapTheme().
  MAP.style = primeStyleUrl();
  renderThemeButtons();

  // Spin up listeners for the modes that need them. 'light'/'dark' are
  // static; 'system'/'lighting' are reactive.
  if (themeState.mode === 'system') startSystemListener(applyTheme);
  if (themeState.mode === 'lighting') {
    startLightingListener(applyTheme);
    startSystemListener(applyTheme);
  }
}

// Auto-init on classic-script load. app.js will later call bindMap().
initTheme();