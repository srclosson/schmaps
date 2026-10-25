#!/usr/bin/env node
/**
 * Test: routing consensus algorithm (consensusEstimate in
 * public/js/routing.js) + the /api/routing/witness proxy contract.
 *
 * Run: node test-consensus.mjs
 *   (spins up server.js on a scratch port, exercises the endpoint,
 *    then runs consensus scenarios against the real algorithm)
 */
'use strict';

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

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

/* ---------------- consensus algorithm scenarios ---------------- */

console.log('\n— consensusEstimate scenarios —');

// Import the real module (Node 18+ understands ESM + fetch).
const { consensusEstimate } = await import('./public/js/routing.js');

// 1. Two witnesses agree with our estimate → average of all three.
{
  const r = consensusEstimate(1800, [
    { source: 'tomtom', durationSeconds: 1860 },
    { source: 'stadia', durationSeconds: 1740 },
  ]);
  check('3-way agreement averages all three', r?.seconds === 1800, JSON.stringify(r));
  check('all three sources listed', r?.sources.length === 3);
  check('nothing discarded', r?.discarded.length === 0);
}

// 2. One witness is an outlier → discarded, the agreeing pair averaged.
{
  const r = consensusEstimate(1800, [
    { source: 'tomtom', durationSeconds: 1850 },
    { source: 'stadia', durationSeconds: 3600 }, // wild outlier
  ]);
  check('outlier discarded', r?.discarded.includes('stadia'), JSON.stringify(r));
  check('pair averaged', r?.seconds === 1825, `got ${r?.seconds}`);
  check('pair sources', r?.sources.join(',') === 'schmaps,tomtom');
}

// 3. Witnesses agree with each other, we're the outlier → they win.
{
  const r = consensusEstimate(1800, [
    { source: 'tomtom', durationSeconds: 2500 },
    { source: 'stadia', durationSeconds: 2600 },
  ]);
  check('our estimate discarded', r?.discarded.includes('schmaps'), JSON.stringify(r));
  check('witness pair averaged', r?.seconds === 2550, `got ${r?.seconds}`);
}

// 4. No witnesses → null (no consensus possible).
{
  const r = consensusEstimate(1800, []);
  check('no witnesses → null', r === null);
}

// 5. Total disagreement → our estimate stands, both witnesses discarded.
{
  const r = consensusEstimate(1800, [
    { source: 'tomtom', durationSeconds: 900 },
    { source: 'stadia', durationSeconds: 3600 },
  ]);
  check('total disagreement keeps own estimate', r?.seconds === 1800, JSON.stringify(r));
  check('both witnesses discarded', r?.discarded.length === 2);
}

// 6. Long haul — percentage tolerance lets estimates breathe.
{
  // 3-hour drive: tolerance = max(120, 0.2 × 10800) = 2160 s.
  const r = consensusEstimate(10800, [
    { source: 'tomtom', durationSeconds: 12000 },
    { source: 'stadia', durationSeconds: 9500 },
  ]);
  check('long-haul 3-way agreement', r?.sources.length === 3, JSON.stringify(r));
  check(
    'long-haul average',
    r?.seconds === (10800 + 12000 + 9500) / 3,
    `got ${r?.seconds}`
  );
}

// 7. Short trip — flat floor keeps the window honest.
{
  // 5-min drive: tolerance = max(120, 0.2 × 300) = 120 s.
  const r = consensusEstimate(300, [
    { source: 'tomtom', durationSeconds: 380 },
    { source: 'stadia', durationSeconds: 900 },
  ]);
  check('short trip: stadia outlier discarded', r?.discarded.includes('stadia'), JSON.stringify(r));
  check('short trip: pair averaged', r?.seconds === 340, `got ${r?.seconds}`);
}

// 8. Only one witness, and it agrees → two-member cluster.
{
  const r = consensusEstimate(1800, [{ source: 'tomtom', durationSeconds: 1900 }]);
  check('single agreeing witness forms consensus', r?.sources.length === 2, JSON.stringify(r));
  check('single witness averaged', r?.seconds === 1850, `got ${r?.seconds}`);
}

// 9. Garbage witnesses are ignored, not fatal.
{
  const r = consensusEstimate(1800, [
    { source: 'tomtom', durationSeconds: NaN },
    { source: 'stadia', durationSeconds: 0 },
  ]);
  check('garbage witnesses → null', r === null, JSON.stringify(r));
}

/* ---------------- witness proxy endpoint ---------------- */

console.log('\n— /api/routing/witness proxy —');

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {}); // swallow the banner
server.stderr.on('data', (d) => process.stderr.write(d));

// Wait for the server to accept connections.
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  await delay(250);
  try {
    const res = await fetch(`${BASE}/api/health`);
    up = res.ok;
  } catch {
    up = false;
  }
}
check('server started', up);

if (up) {
  // Valid request — witnesses array present (errors allowed: no keys here).
  {
    const res = await fetch(`${BASE}/api/routing/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { lat: 43.6532, lon: -79.3832 },
        destination: { lat: 45.4215, lon: -75.6972 },
      }),
    });
    const data = await res.json();
    check('witness endpoint responds 200', res.status === 200);
    check('witnesses array present', Array.isArray(data.witnesses));
    check(
      'both engines reported (with error status, no keys set)',
      data.witnesses.length === 2 &&
        data.witnesses.every((w) => w.source && (w.error || w.durationSeconds)),
      JSON.stringify(data.witnesses)
    );
  }

  // Bad body → 400.
  {
    const res = await fetch(`${BASE}/api/routing/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: { lat: 1 } }),
    });
    check('missing destination → 400', res.status === 400);
  }

  // Garbage JSON → 400.
  {
    const res = await fetch(`${BASE}/api/routing/witness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    check('garbage body → 400', res.status === 400);
  }

  // GET is not allowed (405 from the method guard).
  {
    const res = await fetch(`${BASE}/api/routing/witness`);
    check('GET witness → 405', res.status === 405);
  }
}

server.kill();
await delay(250);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);