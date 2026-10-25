#!/usr/bin/env node
/**
 * Schmaps icon generator.
 *
 * Uses schmaps.jpeg as the source artwork and writes the PNG icon set
 * used by the PWA manifest and install surfaces.
 *
 * Requires ImageMagick (`magick`).
 * Run: npm run icons
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'schmaps.jpeg');
const OUT = path.join(ROOT, 'public', 'icons');

if (!fs.existsSync(SRC)) {
  console.error(`Missing source artwork: ${SRC}`);
  process.exit(1);
}

const MAGICK = cp.spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0 ? 'magick' : null;
if (!MAGICK) {
  console.error('ImageMagick (`magick`) is required to generate icons.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

function run(args) {
  const res = cp.spawnSync(MAGICK, args, { stdio: 'pipe' });
  if (res.status !== 0) {
    const msg = String(res.stderr || res.stdout || 'magick failed').trim();
    throw new Error(msg);
  }
}

function writeIcon(name, size) {
  const out = path.join(OUT, name);
  run([
    SRC,
    '-auto-orient',
    '-gravity', 'center',
    '-crop', '1:1',
    '+repage',
    '-resize', `${size}x${size}^`,
    '-gravity', 'center',
    '-extent', `${size}x${size}`,
    '-strip',
    '-colors', '256',
    '-define', 'png:compression-level=9',
    '-define', 'png:compression-filter=5',
    '-define', 'png:compression-strategy=1',
    '-strip',
    out,
  ]);
  const bytes = fs.statSync(out).size;
  console.log(`  wrote ${name} (${bytes} bytes)`);
}

writeIcon('icon-64.png', 64);
writeIcon('icon-192.png', 192);
writeIcon('icon-512.png', 512);
writeIcon('icon-maskable-512.png', 512);
writeIcon('apple-touch-icon.png', 180);

console.log('🗺️ Schmaps icons written from schmaps.jpeg to public/icons/');
