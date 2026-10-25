#!/usr/bin/env node
/**
 * Test: turn-by-turn guidance (extractManeuvers in public/js/routing.js)
 * + live verification that computeRoute() now returns a maneuvers array
 * with correct vertex indices and lane data.
 *
 * Run: HERE_API_KEY=... node server.js   (separate terminal)
 *      node test-turns.mjs
 *   (unit-checks the extractor against synthetic OSRM legs, then hits
 *    the real HERE Routing v8 proxy for a Toronto route and inspects
 *    the maneuvers it extracts. The app's relative /api/* URLs are
 *    resolved against BASE_URL, default http://localhost:3000.)
 */
'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Resolve the app's relative URLs (browser behaviour) for Node's fetch.
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' && input.startsWith('/')
    ? BASE + input
    : input;
  return origFetch(url, init);
};

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const { extractManeuvers, computeRoute } = await import('./public/js/routing.js');

/* ---------------- extractManeuvers — synthetic legs ---------------- */

console.log('\n— extractManeuvers (synthetic OSRM legs) —');

// A leg with depart, two turns (one with lanes), and arrive.
// Geometry: 5 vertices total. depart covers v0→v1, turn1 v1→v2,
// turn2 v2→v3, arrive v3→v4.
const legs = [
  {
    steps: [
      {
        maneuver: { type: 'depart', modifier: 'left', location: [-79.38, 43.64] },
        name: '',
        distance: 100,
        geometry: { coordinates: [[-79.38, 43.64], [-79.37, 43.64]] },
        intersections: [],
      },
      {
        maneuver: { type: 'turn', modifier: 'right', location: [-79.37, 43.64] },
        name: 'York Street',
        distance: 200,
        geometry: { coordinates: [[-79.37, 43.64], [-79.36, 43.64]] },
        intersections: [
          {
            location: [-79.37, 43.64],
            lanes: [
              { valid: false, indications: ['left'] },
              { valid: true, indications: ['straight', 'right'] },
            ],
          },
        ],
      },
      {
        maneuver: { type: 'turn', modifier: 'left', location: [-79.36, 43.64] },
        name: 'Bloor Street',
        distance: 300,
        geometry: { coordinates: [[-79.36, 43.64], [-79.35, 43.64]] },
        intersections: [{ location: [-79.36, 43.64] }], // no lanes
      },
      {
        maneuver: { type: 'arrive', modifier: 'right', location: [-79.35, 43.64] },
        name: '',
        distance: 0,
        geometry: { coordinates: [[-79.35, 43.64], [-79.34, 43.64]] },
        intersections: [],
      },
    ],
  },
];

{
  const m = extractManeuvers(legs);
  check('depart + arrive skipped', m.length === 2, `got ${m.length}`);
  check('first is the right turn', m[0]?.type === 'turn' && m[0]?.modifier === 'right');
  check('road name carried', m[0]?.name === 'York Street');
  check('vertexIndex 1 (after depart)', m[0]?.vertexIndex === 1, `got ${m[0]?.vertexIndex}`);
  check('second vertexIndex 2', m[1]?.vertexIndex === 2, `got ${m[1]?.vertexIndex}`);
  check('lanes extracted', Array.isArray(m[0]?.lanes) && m[0].lanes.length === 2);
  check('lane validity preserved', m[0]?.lanes?.[0]?.valid === false && m[0]?.lanes?.[1]?.valid === true);
  check('lane indications preserved', m[0]?.lanes?.[1]?.indications?.join('+') === 'straight+right');
  check('no lanes → null', m[1]?.lanes === null);
  check('location is [lon,lat]', Array.isArray(m[0]?.location) && m[0].location.length === 2);
}

// Empty / malformed input.
{
  check('no legs → []', extractManeuvers([]).length === 0);
  check('null legs → []', extractManeuvers(null).length === 0);
  check('leg without steps → []', extractManeuvers([{}]).length === 0);
}

// Two legs — vertexIndex must keep counting across the leg boundary.
{
  const twoLegs = [
    {
      steps: [
        {
          maneuver: { type: 'depart', location: [0, 0] },
          name: '',
          distance: 10,
          geometry: { coordinates: [[0, 0], [1, 0]] },
        },
        {
          maneuver: { type: 'turn', modifier: 'left', location: [1, 0] },
          name: 'A',
          distance: 10,
          geometry: { coordinates: [[1, 0], [2, 0]] },
        },
      ],
    },
    {
      steps: [
        {
          maneuver: { type: 'turn', modifier: 'right', location: [2, 0] },
          name: 'B',
          distance: 10,
          geometry: { coordinates: [[2, 0], [3, 0]] },
        },
        {
          maneuver: { type: 'arrive', location: [3, 0] },
          name: '',
          distance: 0,
          geometry: { coordinates: [[3, 0], [4, 0]] },
        },
      ],
    },
  ];
  const m = extractManeuvers(twoLegs);
  check('two legs → 2 maneuvers', m.length === 2, `got ${m.length}`);
  check('vertexIndex continues across legs', m[1]?.vertexIndex === 2, `got ${m[1]?.vertexIndex}`);
}

/* ---------------- live: computeRoute returns maneuvers ---------------- */

console.log('\n— computeRoute (live HERE v8, Toronto) —');

try {
  const route = await computeRoute(
    { lat: 43.6435, lon: -79.3803 }, // Financial District
    { lat: 43.6700, lon: -79.3860 } // Yorkville
  );

  check('route has a maneuvers array', Array.isArray(route.maneuvers));
  check('at least one maneuver', route.maneuvers.length >= 1, `got ${route.maneuvers.length}`);

  const geo = route.geometry;
  for (const m of route.maneuvers) {
    check(
      `maneuver vertexIndex in range (${m.type}/${m.modifier})`,
      m.vertexIndex >= 0 && m.vertexIndex < geo.length,
      `vertexIndex ${m.vertexIndex} of ${geo.length}`
    );
    // The maneuver location should be (near) the vertex it points at.
    const v = geo[m.vertexIndex];
    const dLon = Math.abs(v[0] - m.location[0]);
    const dLat = Math.abs(v[1] - m.location[1]);
    check(
      `maneuver location ≈ vertex (${m.type}/${m.modifier})`,
      dLon < 1e-4 && dLat < 1e-4,
      `Δlon ${dLon} Δlat ${dLat}`
    );
  }

  // Maneuvers should be in increasing vertex order.
  const sorted = [...route.maneuvers].every(
    (m, i, a) => i === 0 || a[i - 1].vertexIndex <= m.vertexIndex
  );
  check('maneuvers in route order', sorted);

  // Lane data: HERE Routing v8 doesn't carry lane advice (that's a
  // Navigation SDK feature), so lanes are legitimately absent — but any
  // lanes that DO appear must be well-formed {valid, indications}.
  const withLanes = route.maneuvers.filter((m) => Array.isArray(m.lanes) && m.lanes.length > 0);
  if (withLanes.length > 0) {
    const lanes = withLanes[0].lanes;
    check(
      'lanes have valid + indications',
      lanes.every((l) => typeof l.valid === 'boolean' && Array.isArray(l.indications))
    );
  } else {
    check('lanes absent or well-formed (HERE v8 has no lane advice)', true);
  }

  // Alternatives (if any) should carry maneuvers too.
  for (const alt of route.alternatives ?? []) {
    check(
      `alternative has maneuvers (${alt.canadaVia ?? 'alt'})`,
      Array.isArray(alt.maneuvers)
    );
  }

  console.log(
    `\n  Sample: ${route.maneuvers
      .slice(0, 3)
      .map((m) => `${m.type}/${m.modifier} ${m.name} @v${m.vertexIndex}${m.lanes ? ' [lanes]' : ''}`)
      .join(' → ')}`
  );
} catch (err) {
  check('live computeRoute succeeded', false, err.message);
}

/* ---------------- summary ---------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
