#!/usr/bin/env node
/**
 * Live end-to-end test: computeRoute() against the real OSRM server,
 * with the consensus layer active (witnesses absent without keys —
 * the graceful-degradation path). Verifies the RouteResult shape the
 * app consumes, including the new `consensus` field.
 *
 * Run: node test-live-route.mjs
 */
'use strict';

const { computeRoute, formatDuration } = await import('./public/js/routing.js');

const origin = { lat: 43.6532, lon: -79.3832 }; // Toronto
const destination = { lat: 45.4215, lon: -75.6972 }; // Ottawa

console.log('Computing route Toronto → Ottawa (live OSRM)…');
const route = await computeRoute(origin, destination);

const checks = [
  ['geometry is [lon,lat] pairs', Array.isArray(route.geometry) && route.geometry.length > 100],
  ['distanceMeters plausible (350–500 km)', route.distanceMeters > 350_000 && route.distanceMeters < 500_000],
  ['freeFlowSeconds plausible', route.freeFlowSeconds > 3600 && route.freeFlowSeconds < 6 * 3600],
  // trafficAdjust() rounds OSRM's float duration, so allow 1 s of slack.
  ['trafficSeconds ≈ freeFlowSeconds or more', route.trafficSeconds >= route.freeFlowSeconds - 1],
  ['eta is a Date ~now + trafficSeconds', route.eta instanceof Date && Math.abs(route.eta.getTime() - (Date.now() + route.trafficSeconds * 1000)) < 5000],
  ['congestionFactor present', typeof route.congestionFactor === 'number'],
  ['incidents is an array', Array.isArray(route.incidents)],
  ['runs is an array', Array.isArray(route.runs)],
  ['crossesUsa is boolean', typeof route.crossesUsa === 'boolean'],
  ['consensus is null or has sources', route.consensus === null || Array.isArray(route.consensus.sources)],
  ['alternatives is an array', Array.isArray(route.alternatives)],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

console.log(`\n  distance: ${(route.distanceMeters / 1000).toFixed(0)} km`);
console.log(`  free-flow: ${formatDuration(route.freeFlowSeconds)}`);
console.log(`  traffic-adjusted ETA: ${formatDuration(route.trafficSeconds)}`);
console.log(`  consensus: ${route.consensus ? JSON.stringify(route.consensus) : 'null (no witnesses — expected without keys)'}`);
console.log(`  alternatives: ${route.alternatives.length}`);

process.exit(failed > 0 ? 1 : 0);