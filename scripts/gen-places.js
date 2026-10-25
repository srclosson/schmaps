#!/usr/bin/env node
/**
 * Schmaps — Canadian place gazetteer generator.
 *
 * Downloads the GeoNames "cities1000" dump (all world places with
 * population >= 1000), filters to Canada, and emits a compact JSON
 * gazetteer used by the client-side fuzzy "did you mean" matcher.
 *
 * Data: GeoNames (https://www.geonames.org), CC-BY 4.0.
 *
 * Usage: node scripts/gen-places.js
 * Output: public/data/ca-places.json
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const CITIES_URL = 'https://download.geonames.org/export/dump/cities1000.zip';
const ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';
const OUT_FILE = path.join(__dirname, '..', 'public', 'data', 'ca-places.json');
const TMP_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'schmaps-places-'));

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return resolve(download(res.headers.location, dest));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

/** Strip accents/diacritics so "Montréal" matches "montreal". */
function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

async function main() {
  const zipPath = path.join(TMP_DIR, 'cities1000.zip');
  const txtPath = path.join(TMP_DIR, 'cities1000.txt');
  const adminPath = path.join(TMP_DIR, 'admin1.txt');

  console.log('Downloading GeoNames dumps…');
  await download(CITIES_URL, zipPath);
  await download(ADMIN1_URL, adminPath);

  // Unzip (cities1000.zip contains a single cities1000.txt)
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', TMP_DIR]);

  // Province/territory code → name
  const admin1 = new Map();
  for (const line of fs.readFileSync(adminPath, 'utf8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0].startsWith('CA.')) {
      admin1.set(parts[0].slice(3), parts[1]);
    }
  }

  const places = [];
  const seen = new Set();
  for (const line of fs.readFileSync(txtPath, 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f.length < 19 || f[8] !== 'CA') continue;
    const name = f[1];
    const lat = parseFloat(f[4]);
    const lon = parseFloat(f[5]);
    const provCode = f[10];
    const pop = parseInt(f[14], 10) || 0;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const prov = admin1.get(provCode) || provCode;
    const key = `${normalize(name)}|${prov}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ n: name, la: lat, lo: lon, p: prov, pop });
  }

  // Largest first so the matcher can short-circuit on population ties.
  places.sort((a, b) => b.pop - a.pop);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(places));
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`Wrote ${places.length} Canadian places (${kb} KB) → ${path.relative(process.cwd(), OUT_FILE)}`);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
