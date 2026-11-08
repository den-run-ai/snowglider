// @ts-check
// pwa-manifest-tests.js — validates the PWA install metadata shipped by PR 2
// (issue #358): the web app manifest (public/manifest.webmanifest), its icon
// asset, and the <link>/<meta> wiring in index.html. Reads the source files so it
// is deterministic without a build (the build-output presence is separately
// guarded by scripts/verify-pages-dist.sh + the build-pages CI step).
// Auto-discovered by tests/run-node-suite.js.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${name}`);
  if (condition) pass++;
  else fail++;
}

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'public', 'manifest.webmanifest');
const iconPath = path.join(root, 'public', 'icons', 'icon.svg');
const indexPath = path.join(root, 'index.html');

// --- Manifest file exists and is valid JSON with the required fields ---
check('manifest.webmanifest exists in public/', fs.existsSync(manifestPath));
check('icon.svg exists in public/icons/', fs.existsSync(iconPath));

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  check('manifest is valid JSON', false);
}

if (manifest) {
  check('manifest valid JSON parsed', true);
  check('name is SnowGlider', manifest.name === 'SnowGlider');
  check('short_name present', typeof manifest.short_name === 'string' && manifest.short_name.length > 0);
  check('start_url is /', manifest.start_url === '/');
  check('scope is /', manifest.scope === '/');
  check('display is standalone', manifest.display === 'standalone');
  check('background_color present', /^#[0-9a-fA-F]{3,8}$/.test(manifest.background_color || ''));
  check('theme_color present', /^#[0-9a-fA-F]{3,8}$/.test(manifest.theme_color || ''));
  // orientation must not lock to landscape in the first PR (mobile portrait must work).
  check('orientation is not locked to landscape', manifest.orientation !== 'landscape');
  check('icons is a non-empty array', Array.isArray(manifest.icons) && manifest.icons.length > 0);
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check('every icon has src/sizes/type', icons.every((i) => i && typeof i.src === 'string' && i.src && i.sizes && i.type));
  check('at least one icon covers any size (installability)', icons.some((i) => i.sizes === 'any'));
  // Chromium install eligibility wants explicit 192px + 512px icons advertised
  // (Codex #360). The scalable SVG is declared at those sizes to stay binary-free.
  check('declares an explicit 192x192 icon', icons.some((i) => String(i.sizes).split(/\s+/).includes('192x192')));
  check('declares an explicit 512x512 icon', icons.some((i) => String(i.sizes).split(/\s+/).includes('512x512')));
  check('a maskable icon is declared', icons.some((i) => typeof i.purpose === 'string' && i.purpose.includes('maskable')));
  check('every icon src resolves to a file that exists', icons.every((i) => {
    const rel = String(i.src).replace(/^\//, '');
    return fs.existsSync(path.join(root, 'public', rel));
  }));
}

// --- The icon is real SVG markup (keeps the repo binary-free) ---
if (fs.existsSync(iconPath)) {
  const svg = fs.readFileSync(iconPath, 'utf8');
  check('icon is SVG markup', /<svg[\s>]/.test(svg) && /<\/svg>/.test(svg));
}

// --- index.html wires the manifest + theme color + icons ---
const html = fs.readFileSync(indexPath, 'utf8');
check('index.html links the manifest', /<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/.test(html));
check('index.html declares a theme-color', /<meta[^>]+name="theme-color"/.test(html));
check('index.html links a favicon icon', /<link[^>]+rel="icon"[^>]+href="\/icons\/icon\.svg"/.test(html));
check('index.html links an apple-touch-icon', /<link[^>]+rel="apple-touch-icon"/.test(html));

console.log(`\nPWA MANIFEST TEST TOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
