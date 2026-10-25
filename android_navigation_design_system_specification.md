# Android Navigation Design System Specification (`NAV_DESIGN_SYSTEM.md`)

> **INSTRUCTION FOR AI CODING ASSISTANTS:**
> You must strictly follow all design tokens, spatial layout structures, component rules, and code patterns in this document when generating or modifying any UI code for this application. High density, screen real estate preservation, zero-touch initial GPS lock, full-screen PWA display execution, and HERE Maps vector rendering are critical priorities.

**Contents**
1. Ergonomic Principles & Real Estate Management
2. Vehicle / Location Cursor Specification (State-Driven)
3. Screen Spatial Grid & Key Zones
4. Design Tokens & Color Specs
5. Typography Scale (Compact & Glanceable)
6. Dynamic Swipe & Recenter Logic Pattern
7. PWA Fullscreen & Display Configuration
8. HERE Maps (HERE WeGo) Platform Integration
9. Rules for AI Code Generation
10. **Theme System (Light / Dark / System / Lighting)** ← *new in this revision*
11. Rules for AI Code Generation (Theme) ← *new in this revision*

## 1. Ergonomic Principles & Real Estate Management

The primary objective of this layout is **maximum map visibility**. All HUD controls, dialogs, and overlays are docked into compact perimeter zones (Top Bar, Right Rail, Left Stack) to leave the central canvas unobstructed.

### Core Startup & Tracking Rules:

* **Zero-Touch GPS Startup & Immediate Zoom:** Upon app launch, GPS initialization and lock must start immediately. The map must immediately auto-center and animate zoom into the current location cursor without requiring any user interaction or button tap.

* **No Persistent Location/Recenter Button:** Do **NOT** render a persistent "My Location" or "Recenter" button by default. Screen real estate is strictly preserved for the map canvas during active tracking.

* **Dynamic "Return to Location" Trigger (Pan/Swipe Away):**
  * When the user performs a drag, pan, or swipe gesture on the map canvas, auto-follow tracking pauses.
  * **ONLY AT THIS MOMENT**, the "Return to Location" / "Recenter" button dynamically surfaces in **Left Pane Slot 2**.
  * Tapping the "Return to Location" button re-engages live tracking, smooth-animates the camera back to the location cursor, and immediately hides the button again.

* **Compact Density:** Avoid oversized cards. Padding must remain tight (`p-2` to `p-3`).

---

## 2. Vehicle / Location Cursor Specification (State-Driven)

The location cursor is a core HUD element representing the user's live position and heading. It switches dynamically between two standard navigation icon states:

```
+------------------------------------+------------------------------------+
| STATE A: STATIONARY / UNCERTAIN    | STATE B: ACTIVE MOTION / HEAVY     |
| (Speed < 2 km/h or No Heading)     | (Speed >= 2 km/h with Heading)     |
+------------------------------------+------------------------------------+
| - Pulsing Blue Position Dot        | - Directional Navigation Arrow     |
| - Semi-transparent Accuracy Halo   | - Distinct Pointed Heading Cone    |
| - Heading Cone optional / soft     | - Rotates in real-time to GPS bearing|
+------------------------------------+------------------------------------+
```

### Cursor State Rules:

1. **Stationary State (`isMoving === false`):**
   * Solid blue location dot with a subtle pulsating outer accuracy ring (`location-pulse`).
   * Used when vehicle speed is below 2 km/h or heading accuracy is unconfirmed.

2. **Directional Motion State (`isMoving === true`):**
   * Sharp 3D or 2D navigation arrow/chevron oriented in the direction of travel (bearing angle).
   * High-contrast border (white/black outline) for maximum visibility over all map styles.

---

## 3. Screen Spatial Grid & Key Zones

The screen is divided into 3 specific structural zones:

```
+-------------------------------------------------------------------------+
| [ZONE 1: TOP BAR] - Nav Search Text Input + Integrated Mic [Right-Just] |
+------------------------------------+------------------------------------+
| [ZONE 3: LEFT HAND PANE]           | [ZONE 2: RIGHT HAND RAIL]          |
|                                    |                                    |
| - Slot 1 (Top):                    | - Breadcrumb Menu Button           |
|   Turn Instructions & Directions   |   (Focal Point at Top-Right Corner) |
|                                    |   (Width matches Right Rail)       |
| - Slot 2 (Middle - Dynamic Only):  |                                    |
|   "Return to Location" Button      | - Speed Indicator                  |
|   (Appears ONLY after pan/swipe)   |   & Speed Limit Sign               |
|                                    |                                    |
| - Slot 3 (Bottom):                 |                                    |
|   Trip Info (ETA, Dist, Time)     |                                    |
|   & Route Actions / Save Button    |                                    |
+------------------------------------+------------------------------------+
```

### Zone 1: Top Navigation Search Bar
* **Position:** Fixed top bar span across the upper viewport. Accounts for safe area top insets.
* **Elements:**
  * Text input box for destination entry using HERE Geocoding & Search API.
  * Integrated microphone/talk icon docked inside the right boundary of the text input (Android Standard behavior).

### Zone 2: Right Hand Rail (Control Dock)
* **Width:** Uniform fixed width (`w-16` sm:`w-20` / ~64px-80px).
* **Intersection Focal Point:** At the top-right intersection sits the **Breadcrumb Menu** button. Its width defines the width of all items in the Right Rail.
* **Docked Modules:**
  * **Breadcrumb Menu:** Opens quick options (Audio toggle, layer options, map style switcher, settings).
  * **Speedometer Module:** Compact current speed indicator computed from GPS trajectory.
  * **Speed Limit Badge:** Compact circular/rectangular speed limit sign driven by HERE Routing/Attributes API.

### Zone 3: Left Hand Pane (3 Dialog Slots)
Fully left-justified flex column containing up to 3 distinct dialog zones:
1. **Slot 1 (Top - Maneuver Dialog):** Compact turn direction arrow, distance, and next maneuver street name (powered by HERE Routing API).
2. **Slot 2 (Middle - Dynamic Recenter Slot):** **Hidden by default.** Dynamically slides/fades in ONLY when the driver swipes or pans away from the active location view.
3. **Slot 3 (Bottom - Trip Summary & Route Dialog):** Compact row holding Remaining Distance, ETA time, and Arrival Time. Alternative-route choice is **not** shown here — each displayed route (active + alternatives) carries its own tappable on-map badge anchored at its geometric midpoint (see §3.1). A named-save form appears below the stats only when the destination is not already in the user's saved-places library.

### 3.1 On-Map Route Choice Badges

Badge visibility is driven by the current **mode**:

- **Selection mode** (`state.navigating === false`) — every route in the pool, **including the primary**, gets a badge. The user hasn't picked yet; comparing all candidates' times, distances, and crowns side-by-side on the map *is* the selection UI. The primary is rendered with a "selected" tint, and the bottom card shows an explicit **Start** CTA (`#start-route-btn`). Selection mode is now a *real* phase of the trip, not just a render shortcut: navigation does not auto-start when `renderRoute()` finishes; the user must commit via the Start CTA.

- **Navigation mode** (`state.navigating === true`) — the primary's badge is hidden (the active route is implied by the line + bottom card stats) and the Start CTA is collapsed (hidden). Only the alternatives render, so they can still be picked mid-trip.

The mode-driven re-render fires from three places:
1. `startNavigating()` — collapses the primary's badge so it doesn't compete with itself on the map, and hides `#start-route-btn`.
2. `stopNavigating()` — restores the primary's badge alongside the alternatives for the next pick, and re-shows `#start-route-btn` only if a route is still set.
3. `switchToAlternative(alt, { silent })` (called by both user taps and `detectRouteDeviation`) — already invokes `renderRoute()`, which in turn re-renders the choice list under whatever mode is active.

**Committing to a route (selection → navigation)**

The user leaves selection mode in exactly one way:
- **Tap the Start CTA** in the route panel (`#start-route-btn`) — full-width blue button below the route stats, labeled "▶ Start navigation". Its click handler calls `startNavigating()`.

Badges never start navigation — they only select a route. After the user commits, `state.navigating` flips true, the Start CTA hides, the primary's badge disappears from the map, and the camera follows the GPS fix.

Switching to an alternative *does not* leave selection mode — it stays in selection mode with the new primary, so the user can keep comparing or back out by tapping ✕. Navigation begins only on the explicit Start gesture.

The badge carries three rows:

1. **Icon row** — one chip per crown the route wins:
   - ⚡ **fastest** — shortest `trafficSeconds` (ties go to the first entry)
   - 🍃 **eco** — shortest `distanceMeters` (fuel proxy; ties go to the first entry)
   - ⚠ **usa** — appended when `route.crossesUsa === true`
   - 🍁 **canada-via** — appended when `route.canadaVia` is set
2. **Time row** — `formatDuration(route.trafficSeconds)`.
3. **Distance row** — `formatDistance(route.distanceMeters)`.

A route can carry multiple crowns — a route that is both fastest AND shortest shows both ⚡ and 🍃.

| State | Visual | Behavior |
|-------|--------|------------|
| `alt`      | White surface with a 2px gray ring (dark theme: panel-dark surface), accent icons keep their semantic color | Tap calls `switchToAlternative(route)` (stays in selection mode; does not start navigation) |
| `selected` (selection mode) | Blue surface, white border, lifted z-index | Inert — the primary is already the active candidate; navigation starts only from the Start CTA |
| `selected` (navigation mode) | Blue surface, white border, lifted z-index | Not rendered — primary badge is hidden during navigation |

**Selection rules**
- The badge pool is mode-dependent.
  - **Selection mode** — `state.route` (primary) **and** `state.alternatives[]` are all rendered as badges so the user can compare every candidate including the current default. The primary's badge is inert — it's a label, not a button.
  - **Navigation mode** — the primary's badge is filtered; only `state.alternatives[]` render. The active route is already implied by the active-route line + the bottom card stats + the Start CTA being hidden.
- Only routes that are actually choices render: `state.alternatives[]` always; `state.route` additionally in selection mode only. Crowns (fastest, eco, usa, canada-via) are still computed over the whole pool including the primary — this preserves the "best of all options" semantics.
- Tapping an `alt` badge promotes that route to primary via `switchToAlternative(route)` — the previous primary moves to `state.alternatives` so the user can always flip back without re-routing. **This does not start navigation; selection mode continues** so the user can keep comparing or back out.
- `state.routePreference` (set in `switchToAlternative`) is honored on every 60s refresh via `applyRoutePreference()`, so a manual switch survives traffic-refresh rebuilds.

**Viewport culling**
- A badge is only rendered for alternatives whose geometric midpoint lies inside `map.getBounds()` at render time. Lines that scroll out of view (and therefore can't be picked) also scroll out of the badge list, so the map stays clean.
- A `map.on('moveend', …)` listener re-runs `renderRouteChoices()` whenever the user pans or zooms, so badges appear/disappear the moment their lines enter/leave the viewport — no stale badges stuck on an off-screen route.

**Mid-drive refresh contract**
- The 60s `refreshActiveRoute()` re-renders both the active line and the alternatives via `renderRouteChoices()`, so the badge crowns update in lock-step with live traffic — ⚡ may move from one route to another as the fastest path changes.
- The camera does not refit during a refresh — the driver keeps seeing the same map frame, only the badges and ⚡ / 🍃 crown ownership change.

**Deviation auto-select (silent)**
- While navigating, every geolocation fix runs `detectRouteDeviation(lat, lon)`. If the vehicle is within `DEVIATION_OFF_PRIMARY_MIN_M` (80 m) of the active route AND within `DEVIATION_ON_ALT_MAX_M` (50 m) of an alternative's polyline, that alternative is promoted to `state.route` via `switchToAlternative(alt, { silent: true })`. The spoken announcement ("Taking the alternative route …") is skipped — the driver already knows they turned, the verbal line would be noise.
- The freshly-promoted route inherits `state.routePreference` so the 60s refresh honours it.
- The previously-active route drops into `state.alternatives`, so the user can still tap its now-visible badge to switch back if they reconsider.

**In-flight offer channels (dual)**
- **Silent visual** — the on-map badge is always present for every visible alternative, so glanceable alternatives never go away.
- **Verbal + CTA** — `#quicker-card` (a slide-up pill anchored at the bottom of the screen) appears only when the fastest alternative saves ≥ `ALT_ROUTES.minSavingsSeconds` AND the user hasn't already dismissed this exact key. The card speaks "A faster route saves X minutes — tap Switch" and the user can tap the on-map badge to accept instead.

**Tap interaction rules**
- Badges never start navigation — the only gesture that starts navigation is the Start CTA (`#start-route-btn`).
- In selection mode, the primary's badge is inert (already the active candidate).
- In selection mode, tapping an `alt` badge promotes that route to primary (stays in selection mode).
- In navigation mode, the primary has no badge on the map; only `alt` badges exist, and tapping one swaps to it (no spoken announcement unless the swap is non-text).
- The map's existing camera-pause-on-gesture behavior still applies; tapping a badge does not pan or zoom the map.
- The badge's pointer-events are enabled on MapLibre's `marker` element (default) so taps do not bleed through to the map.
- The Start CTA (`#start-route-btn`) is an in-card sibling of the route stats; it is the sole entry point into navigation mode.

**Why on-map (vs. a bottom-card chip row)**
- Keeps the bottom navigation card free for Distance/ETA/Arrive + the named save form.
- The badge sits next to the line it describes — no mental mapping from chip → polyline.
- A driver can compare all routes at a glance without looking away from the road.

---

## 4. Design Tokens & Color Specs

All themes must adapt via CSS variables. Colors are tuned for high legibility without washing out the underlying HERE vector map.

```css
:root {
  /* Compact Spatial Sizing */
  --right-rail-width: 72px;
  --top-bar-height: 52px;
  --nav-card-bg: rgba(255, 255, 255, 0.92);
  --nav-surface: #f1f5f9;
  --nav-primary: #1e3a8a;
  --nav-primary-text: #ffffff;
  --nav-accent: #2563eb;
  --nav-text-main: #0f172a;
  --nav-text-sub: #475569;
  --nav-border: rgba(203, 213, 225, 0.8);
  --nav-route: #2563eb;
  --cursor-color: #2563eb;
  --cursor-border: #ffffff;
}

.dark {
  --nav-card-bg: rgba(22, 30, 46, 0.92);
  --nav-surface: #1f293d;
  --nav-primary: #3b82f6;
  --nav-primary-text: #ffffff;
  --nav-accent: #60a5fa;
  --nav-text-main: #f8fafc;
  --nav-text-sub: #94a3b8;
  --nav-border: rgba(46, 58, 82, 0.8);
  --nav-route: #38bdf8;
  --cursor-color: #38bdf8;
  --cursor-border: #0b0f17;
}
```

---

## 5. Typography Scale (Compact & Glanceable)

| Data Element | Font Type | Sizing Class | Sizing Rem/px |
| :--- | :--- | :--- | :--- |
| **Search Input & Placeholder** | Sans-Serif | `text-sm font-medium` | 14px |
| **Turn Distance** | Monospace | `font-mono text-2xl font-extrabold` | 24px |
| **Turn Street Name** | Sans-Serif | `text-base font-bold` | 16px |
| **Speedometer Number** | Monospace | `font-mono text-2xl font-black` | 24px |
| **ETA / Trip Info** | Monospace | `font-mono text-sm font-bold` | 14px |
| **Micro Labels (LIMIT, ETA)** | Sans-Serif | `text-[10px] font-bold uppercase` | 10px |

---

## 6. Dynamic Swipe & Recenter Logic Pattern

```javascript
// State tracking
let isAutoFollowing = true;

// 1. Detect drag/pan on map to surface Recenter button
map.on('dragstart', () => {
  if (isAutoFollowing) {
    isAutoFollowing = false;
    showReturnToLocationButton();
  }
});

// 2. Recenter button click action
function handleReturnToLocation() {
  isAutoFollowing = true;
  hideReturnToLocationButton();
  map.flyTo({
    center: [currentUserLng, currentUserLat],
    zoom: 17,
    essential: true
  });
}
```

---

## 7. PWA Fullscreen & Display Configuration

To ensure the web app runs in full screen without standard title bars or browser chrome obstructing the map, the PWA configuration must follow these constraints:

### Web Application Manifest (`manifest.json`)
```json
{
  "name": "Android Navigation",
  "short_name": "Nav",
  "start_url": "/",
  "display": "fullscreen",
  "display_override": ["window-controls-overlay", "fullscreen", "standalone"],
  "theme_color": "#00000000",
  "background_color": "#0f172a",
  "orientation": "any"
}
```

### Viewport & Transparent Status Bar Meta Tags (`index.html`)
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="theme-color" content="#00000000" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

### Safe Area CSS Rules
Ensure UI elements respect safe areas (camera notches, Android gesture bars) while the map extends edge-to-edge behind them:
```css
#map-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
}

.hud-overlay {
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}
```

---

## 8. HERE Maps (HERE WeGo) Platform Integration

Map rendering, tiles, geocoding, and routing services are provided by the **HERE Location Services (HERE WeGo)** ecosystem.

### Provider API & Style Setup
* **Tile Engine:** MapLibre GL JS / HERE Maps Vector Tile API v2.
* **Vector Tile Endpoint:**
  `https://vector.hereapi.com/v2/vectortiles/base/mc/{z}/{x}/{y}/omv?apiKey={HERE_API_KEY}`
* **Default Styles:**
  * **Day:** `explore.day` / HERE Normal Day Vector Style
  * **Night:** `explore.night` / HERE Normal Night Vector Style

### Routing & Geocoding Services
* **Routing API:** `https://router.hereapi.com/v8/routes`
  * Route calculation for driving, truck, or walking.
  * Turn-by-turn maneuver instruction extraction for **Left Pane Slot 1**.
* **Geocoding & Autocomplete:** `https://autosuggest.search.hereapi.com/v1/autosuggest`
  * Destination queries in **Zone 1 Top Search Bar**.

### JavaScript Map Engine Initialization
```javascript
import maplibregl from 'maplibre-gl';

const HERE_API_KEY = process.env.HERE_API_KEY;

const map = new maplibregl.Map({
  container: 'map-container',
  style: `[https://assets.vector.hereapi.com/styles/berlin/base/mapbox/tilezen/style.json?apiKey=$](https://assets.vector.hereapi.com/styles/berlin/base/mapbox/tilezen/style.json?apiKey=$){HERE_API_KEY}`,
  center: [currentUserLng, currentUserLat],
  zoom: 17,
  pitch: 45,
  bearing: 0
});
```

---

## 9. Rules for AI Code Generation

1. **Zero-Touch Startup:** Do NOT add a "My Location" or "Find Me" button on initial render. GPS auto-lock and camera centering must trigger automatically on app mount.
2. **Conditional Button Visibility:** The "Return to Location" button MUST be hidden (`display: none` or omitted from DOM) until a user pan/swipe event is detected. Once clicked, it must hide again immediately.
3. **Dual-State Cursor Mandatory:** Always render the location cursor. Use a pulsating circle when stopped/stationary and a directional heading arrow when in motion.
4. **Screen Real Estate First:** Do not generate cards wider than `320px` on the left pane, or buttons wider than `var(--right-rail-width)` on the right rail.
5. **PWA Fullscreen Execution:** Ensure HTML layout utilizes `viewport-fit=cover` and transparent status bar properties so the map canvas fills the full display height without white space or system bar clipping.
6. **HERE Maps Integration:** All map tiles, route computations, search autosuggestions, and speed limit metadata must strictly query HERE Location Services endpoints (`*.hereapi.com`). Do not reference Stadia Maps or Mapbox tiles.

---

## 10. Theme System (Light / Dark / System / Lighting)

The app surface (chrome, panels, buttons, the location cursor) and the **map basemap** are both themeable. Four mutually exclusive modes are exposed to the user; three are reactive, one is explicit.

### 10.1 Modes & Resolved Tokens

| Mode | Surface (CSS) | Map style URL (HERE) | Reactive? |
|---|---|---|---|
| `light` | light tokens | HERE Berlin **Day** (`berlin/base/.../style.json`) | no |
| `dark` | dark tokens | HERE Berlin **Night** (`berlin/night/.../style.json`) | no |
| `system` | `prefers-color-scheme: light\|dark` | matches resolved surface | yes (OS toggle) |
| `lighting` | dark when `lux ≤ 5`, else light | matches resolved surface | yes (DeviceLight + fallbacks) |

Resolved tokens (the `data-theme` attribute on `<html>` plus the resolved map style URL) must agree at all times — a `light` surface with a night map, or vice-versa, is a spec violation.

### 10.2 UI Surface

The theme picker lives inside the existing **breadcrumb quick-options menu** (Zone 2 — `§3`), as four menu items stacked above the existing voice toggle. Selecting an item:
1. Sets the active mode in `state.theme`.
2. Persists the choice to `localStorage['schmaps.theme']`.
3. Re-runs the resolver (§10.4) and swaps both the CSS theme and the map style.

Each menu item shows its current active state with the existing menu-item affordance (✓ / highlight) used by the voice toggle. Long descriptions are not required — the icon + label is the affordance.

### 10.3 Persistence & First-Run

* **First-run default:** `system`. Rationale: matches the OS, zero configuration, and the user already opted into a theme preference elsewhere.
* **Persistence key:** `localStorage['schmaps.theme']`, values restricted to `'light' | 'dark' | 'system' | 'lighting'`. Any other value is treated as `system`.
* **Hydration:** On app mount, the resolved theme is applied *before* the first paint of any panel (`html[data-theme]` set in `<head>` via an inline `<script>` to avoid FOUC).
* **Service worker:** the theme preference is *not* part of the offline shell — it's a user preference and lives in `localStorage`, which the SW does not precache.

### 10.4 Resolver

```javascript
// Returns one of: 'light', 'dark'
function resolveTheme(mode, ctx) {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode === 'system') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (mode === 'lighting') {
    if (ctx.lux !== null && Number.isFinite(ctx.lux)) {
      return ctx.lux <= 5 ? 'dark' : 'light';
    }
    // No sensor (lighthouse, simulator, denied permission, iOS PWA):
    // fall back to system — strictly better than guessing wrong.
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}
```

The resolver is called whenever (a) the user picks a new mode, (b) `matchMedia('(prefers-color-scheme: dark)')` change fires (mode = `system`), (c) a `DeviceLightEvent` arrives (mode = `lighting`), or (d) the location cursor first reports (so we can debounce lighting changes to GPS-only contexts).

### 10.5 Reactive Listeners

* `system` mode listens to a `matchMedia('(prefers-color-scheme: dark)')` change event. No polling.
* `lighting` mode listens to `window.addEventListener('devicelight', e => …)` and applies a low-pass filter (`α = 0.2`) to avoid flicker from passing under a streetlight or a cloud shadow.
* If `devicelight` is unsupported or permission is denied, the listener simply never fires — the fallback in the resolver runs on every mode change and on app mount.
* **iOS PWA:** `DeviceLightEvent` is unsupported on iOS Safari. This is documented in the menu's tooltip for the `lighting` item: "Uses your phone's brightness sensor — falls back to system theme on devices without one."

### 10.6 Map Style Swap

The map basemap is decoupled from the CSS theme. Both must swap atomically — a `light` surface with a night map, or a dark chrome with a day map, is rejected.

```javascript
// On resolved-theme change:
async function applyMapTheme(resolved) {
  const url = `/api/here/style?theme=${resolved}`; // server caches both styles
  const styleJson = await fetch(url).then(r => r.json());
  // MapLibre requires a full style replacement; tiles reload is expected.
  map.setStyle(styleJson, { diff: false });
  // Re-add route / alt-route / incident / GPS-cursor sources after style swap.
  onStyleReady();
}
```

Server contract (§8 cross-reference): `GET /api/here/style?theme=light|dark` returns the corresponding HERE Berlin style with the apiKey injected. The server holds two cached styles (`HERE_LIGHT_STYLE_URL`, `HERE_DARK_STYLE_URL`) with independent 24h TTLs so a change to one variant doesn't invalidate the other.

### 10.7 Design Tokens Affected (Dark Variants)

Per §4, the following tokens require dark counterparts. Default light values are unchanged; dark overrides live in `[data-theme="dark"]` (and `[data-theme="light"]`, redundantly, for explicit pinning):

| Token | Light | Dark |
|---|---|---|
| `--bg-app` | `#ffffff` | `#0e1116` |
| `--bg-panel` | `rgba(255,255,255,0.92)` | `rgba(22,27,34,0.92)` |
| `--text-primary` | `#1f2933` | `#e6edf3` |
| `--text-muted` | `#52606d` | `#8b949e` |
| `--border-subtle` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.10)` |
| `--accent-blue` | `#1e88e5` | `#58a6ff` |
| `--shadow-panel` | `0 2px 8px rgba(0,0,0,0.12)` | `0 2px 8px rgba(0,0,0,0.50)` |

Route / traffic / incident colors (from `TRAFFIC.colors` in `config.js`) are theme-independent — they must remain legible on both day and night maps.

### 10.8 Status Bar & Safe-Area (Android Chrome — known limitation)

**Strategy (v0.2.55 → v0.2.56):** the OS status bar is hidden entirely via `display: fullscreen`. The map and HUD extend edge-to-edge under the cutout, and top-level chrome slides up into the freed notch area using `env(safe-area-inset-top)` (which resolves to `0` in fullscreen). No `theme-color` is visible because the system bar is gone.

**`theme-color` config (defense-in-depth):** even though the bar is hidden, we still emit two theme-aware `<meta name="theme-color">` tags so the OS task-switcher card and the cold-start splash paint with the right color if the user briefly drops out of fullscreen:

```html
<meta name="theme-color" content="#0e1116" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#e2e8f0" media="(prefers-color-scheme: light)">
<!-- fallback; public/js/theme.js#applyThemeColor() rewrites this on theme flip -->
<meta name="theme-color" content="#e2e8f0">
```

The values match the HERE map letterbox so when the OS does paint a status bar it visually merges with the map. Android Chrome silently rejects 8-digit hex with transparency (`#00000000`) and paints a solid color, so we deliberately emit opaque values.

**Known limitation — mid-session `theme-color` is ignored (v0.2.55 → v0.2.56).** Android Chrome reads the `<meta name="theme-color">` ONCE at app launch (after the PWA install prompt) and does not repaint the status bar in response to either:

- JS mutations of the `content` attribute (`applyThemeColor()` in `public/js/theme.js` is correct — the change is observable in DevTools, just not in the OS bar)
- `matchMedia` `change` events on `(prefers-color-scheme: …)`

This is tracked as [crbug.com/980790](https://crbug.com/980790). The workaround is the `display: fullscreen` above — by hiding the OS chrome entirely, the unrepaintable color is moot. To actually paint a different status-bar color mid-session on a web app requires **Bubblewrap + TWA** with `ChromeCustomTabs.setColorScheme` and a Java custom-tabs client — out of scope for v0.2.x.

### 10.9 Speed-Limit Comparator (current speed vs posted limit)

The `#speed-limit` badge in Zone 2 (Right Hand Rail) is a glanceable speed-limit sign. Beyond just showing the posted number, the **outer border color** signals how the user's current speed relates to that posted limit. This mirrors the convention in Waze / Apple Maps / HERE WeGo so users can read the badge peripherally while their eyes stay on the road.

**Bands (asymmetric; GPS is noisy at 1 Hz, ±2–3 km/h on a phone):**

| Current speed vs posted limit | Band | Ring colour | Interior wash |
|---|---|---|---|
| ≤ limit + 5 km/h | `ok` | `--speed-limit-ok` | `--speed-limit-ok-bg` |
| limit + 5 … limit + 15 km/h | `warn` | `--speed-limit-warn` | `--speed-limit-warn-bg` |
| > limit + 15 km/h | `over` | `--speed-limit-over` (= `--red`) | `--speed-limit-over-bg` |
| no posted limit OR no current speed | `idle` | (base `--red`, unchanged) | `--speed-limit-bg` (base) |

The `+5 km/h` green ceiling is what absorbs GPS jitter — a 100 km/h limit reads green anywhere from ~97 to ~105. Going to +5 km/h exceeds the limit and flips the badge to yellow. Sustained 15+ km/h over flips to red.

**Hysteresis.** A **2 km/h deadband** prevents oscillation at the threshold. We only *enter* a stricter band (ok → warn → over) immediately on a raw sample that crosses the threshold; we only *leave* a stricter band back to the next-lower one when the raw sample drops 2 km/h *past* the threshold for the next band down. Implemented in [`speedLimitBand()`](public/js/app.js:1255) with the previous band remembered in `state.speedLimitBand`.

**Theme tokens.** Six new tokens (three ring + three wash), each pinned in both theme blocks (§10.7):

- `--speed-limit-ok` — ring green (forest `#1f7a3a` light; brighter `#34d27a` dark)
- `--speed-limit-warn` — ring amber (`#b8860b` light; brighter `#f9c74f` dark)
- `--speed-limit-over` — ring reuses `--red` for both themes (already brand-correct)
- `--speed-limit-ok-bg` — wash (`#e3efe1` light; `#1a3829` dark)
- `--speed-limit-warn-bg` — wash (`#e9d9b2` light; `#2e2719` dark)
- `--speed-limit-over-bg` — wash (`#f1cfc9` light; `#2e1c19` dark)

The washes are explicit per-state hex (not `color-mix()` of the ring) so they survive rapid attribute flips on embedded browsers that cache the function output. See the CSS comment on `#speed-limit[data-state="ok"]` for the full rationale.

**Visual structure.** The base `#speed-limit` rule (theme tokens + red ring) is the **`idle` state**. The state selectors `#speed-limit[data-state="ok|warn|over|idle"]` swap the interior wash and the ring colour per state. `over` keeps the universal red ring but adds the red wash — instant recognition as a speed-limit sign **and** clear "you're speeding" feedback (colour reinforcement, not substitution).

**No CSS transition on `background`.** The comparator flips several times per second on a noisy GPS; a `transition: background` smears the colour into a wash that loses the band signal. Snap the colour change instantly — the ring colour is the high-signal cue, not a fade. (Initial v0.2.58 used `color-mix()` for the wash and a 150 ms transition; both were dropped on v0.2.60 in favour of explicit per-state hex tokens with no transition, after probes showed the shorthand+transition combo was unreliable across attribute flips in headless Chrome.)

**Accessibility.** The badge is `aria-hidden` by default (decorative on a pre-navigation map screen). On every refresh, `paintSpeedLimitBadge()` writes an `aria-label` like *"Speed limit badge. 65 km/h, at or under the 60 km/h limit."* so screen readers can describe the badge if inspected. We do **not** set `aria-live="polite"` on the badge — at 1 Hz GPS the badge would narrate every tick. A dedicated, debounced voice cue ("you are exceeding the speed limit by 10 kilometres an hour") is a separate feature; out of scope for v0.2.58.

**State machine discipline.** `state.speedLimitBand` is the single source of truth across ticks. Reset to `null` on every `clearRoute()` so a new destination restarts the hysteresis logic cleanly.

**Code locations:**

- Comparator + hysteresis: [`public/js/app.js#speedLimitBand()`](public/js/app.js:1255)
- DOM write + state machine: [`public/js/app.js#paintSpeedLimitBadge()`](public/js/app.js:1293)
- CSS state rules: [`public/css/app.css`](public/css/app.css:283) (`#speed-limit[data-state="..."]`)
- Tokens: `html[data-theme="dark"]` and `html[data-theme="light"]` blocks

---

## 11. Rules for AI Code Generation (Theme)

1. **Resolver is the source of truth.** UI components must consume `state.theme.resolved` (a `'light'|'dark'` value), never the raw mode. There is no "current theme is `system` and the OS says light" branch — the resolver flattens that to `light`.
2. **No FOUC.** The `<head>` must contain an inline `<script>` that reads `localStorage['schmaps.theme']` and sets `html[data-theme]` *before* `<body>` paints. Defer this script and the first dark-mode user sees a white flash on every navigation.
3. **Map style is part of the theme.** Never swap the CSS theme without also swapping the map style, and vice-versa. Use the helper from §10.6 — do not call `setStyle` directly from feature code.
4. **`lighting` falls back gracefully.** The fallback chain (sensor → system) is *silent*. Do not surface a toast or modal saying "this device has no light sensor" — the user picked `lighting`, the app does its best.
5. **No theme-dependent feature gating.** Dark mode is not a "premium" surface. Every feature (voice, OBD, errands, routing consensus, autosuggest) must work identically in both.
6. **No `setTimeout`-based theme polling.** Reactivity is event-driven: `matchMedia` change events for `system`, `devicelight` for `lighting`. A polling loop is a spec violation.
7. **Persistence is per-device.** Do not sync the theme preference across devices — a tablet in a dim room and a phone in daylight should both follow their own context.