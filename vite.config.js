import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = 'dist';

// Replace the placeholder build-id meta in index.html with the actual build
// timestamp, so the badge on the start screen can never go stale. Computed once
// when the config is evaluated: build time for `vite build`, server-start time
// for the dev/preview/puppeteer servers. Runs in both serve and build (no
// `apply`), and only rewrites the meta content — index.html is otherwise
// untouched and is emitted by Vite itself (copyStaticAppFiles does not copy it).
function injectBuildId() {
  const buildId = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return {
    name: 'inject-build-id',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta name="build-id" content=")[^"]*(">)/,
        `$1${buildId}$2`
      );
    }
  };
}

function copyStaticAppFiles() {
  const entries = [
    ['src', 'src'],
    ['assets', 'assets'],
    ['tests', 'tests'],
    ['auth.html', 'auth.html'],
    ['CNAME', 'CNAME'],
    ['LICENSE', 'LICENSE'],
    ['README.md', 'README.md']
  ];

  return {
    name: 'copy-static-app-files',
    apply: 'build',
    async closeBundle() {
      const distDir = path.join(rootDir, outDir);
      await mkdir(distDir, { recursive: true });

      await Promise.all(entries.map(([from, to]) => {
        return cp(path.join(rootDir, from), path.join(distDir, to), {
          recursive: true,
          force: true
        });
      }));

      await rm(path.join(distDir, 'tests', 'verification'), {
        recursive: true,
        force: true
      });

      // Publish the three.js ESM build the page import map points at
      // (`/node_modules/three/build/three.module.min.js`). The bundled game never
      // hits the import map (Vite inlines three into the hashed chunk), but the
      // verbatim-copied browser tests in dist/tests load as `<script type="module">`
      // and import bare `three`, so on Pages — where node_modules is NOT published —
      // they'd 404 and the `?test=…` entry points would fail before registering
      // their window.run*Tests hooks. Since three@0.184 the module build is no
      // longer self-contained — `three.module.min.js` imports `./three.core.min.js`
      // (and a later release could split further) — so follow the relative-import
      // graph and copy every referenced build file, not just the entry. Still only
      // the three build dir, never all of node_modules (issue #84).
      const threeBuildRel = path.join('node_modules', 'three', 'build');
      await mkdir(path.join(distDir, threeBuildRel), { recursive: true });
      await copyThreeBuildGraph(
        path.join(rootDir, threeBuildRel),
        path.join(distDir, threeBuildRel),
        'three.module.min.js'
      );

      await transpileCopiedTypeScriptSources(path.join(distDir, 'src'));
      await rewriteCopiedThreeImports(path.join(distDir, 'src'));
      await rewriteCopiedThreeImports(path.join(distDir, 'tests'));
    }
  };
}

// Copy a three.js build entry file plus everything it pulls in through relative
// (`./…`) import specifiers, transitively. three's ESM build was a single
// self-contained file through r160 but split into `three.module.min.js` +
// `three.core.min.js` by 0.184, so publishing only the entry leaves the deployed
// `?test=…` pages 404-ing the core chunk. Walking the local import graph copies
// exactly the referenced sibling files (and survives any further split) without
// pulling in unrelated build artifacts (webgpu/tsl/etc.).
async function copyThreeBuildGraph(srcBuildDir, destBuildDir, entryFile) {
  const seen = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const source = await readFile(path.join(srcBuildDir, name), 'utf8');
    await writeFile(path.join(destBuildDir, name), source);

    for (const match of source.matchAll(/(?:from|import)\s*['"]\.\/([\w.-]+)['"]/g)) {
      queue.push(match[1]);
    }
  }
}

async function transpileCopiedTypeScriptSources(srcDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(srcDir, entry.name);

    if (entry.isDirectory()) {
      await transpileCopiedTypeScriptSources(filePath);
      return;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      return;
    }

    const source = await readFile(filePath, 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
        target: ts.ScriptTarget.ES2022
      },
      fileName: filePath
    });

    await writeFile(filePath.replace(/\.ts$/, '.js'), result.outputText);
    await rm(filePath, { force: true });
  }));
}

async function rewriteCopiedThreeImports(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await rewriteCopiedThreeImports(filePath);
      return;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      return;
    }

    const source = await readFile(filePath, 'utf8');
    const rewritten = source
      .replace(/(from\s+['"])three(['"])/g, '$1/node_modules/three/build/three.module.min.js$2')
      .replace(/(import\s*\(\s*['"])three(['"]\s*\))/g, '$1/node_modules/three/build/three.module.min.js$2');

    if (rewritten !== source) {
      await writeFile(filePath, rewritten);
    }
  }));
}

export default defineConfig({
  base: '/',
  build: {
    outDir,
    sourcemap: true,
    rollupOptions: {
      input: {
        // index.html is Vite's HTML entry. As of Phase 2.1 (issue #84) it loads
        // the ES-module bundle via `<script type="module" src="src/main.ts">`,
        // so Vite discovers src/main.ts (and its imports: three + avalanche.ts)
        // from the page itself and emits one hashed chunk referenced by
        // dist/index.html — no separate standalone input needed anymore.
        index: path.resolve(rootDir, 'index.html')
      }
    }
  },
  plugins: [
    injectBuildId(),
    // PWA service worker (issue #358, PR 3). `injectManifest` lets us hand-author the
    // routing in src/pwa/sw.ts (rather than generateSW) — REQUIRED here because dist/
    // also carries the copied src/, tests/, node_modules/three, auth.html and a large
    // MP3 for the deployed browser suites, which must NEVER be precached. The precache
    // globs are therefore tightly scoped to the true app shell (index.html + the hashed
    // Vite chunks/css + the PR-2 manifest/icons) with defensive globIgnores; the
    // build-artifact test (tests/pwa-build-artifact-tests.js) + verify-pages-dist.sh
    // fail the build if anything forbidden leaks into the generated precache list.
    // Placed BEFORE copyStaticAppFiles so it globs dist while it still holds only the
    // real bundle output — the copied src/tests aren't there yet.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      // We ship our own manifest (public/manifest.webmanifest, PR 2) and register the
      // SW ourselves (src/pwa/register-sw.ts), so disable the plugin's copies.
      manifest: false,
      injectRegister: false,
      injectManifest: {
        globPatterns: ['index.html', 'manifest.webmanifest', 'assets/*.js', 'assets/*.css', 'icons/*.svg'],
        // The ez-tree evergreen chunk is a ~4 MB lazy import (players only). Precaching
        // it would bloat the install and blow workbox's 2 MiB per-file ceiling; sw.ts
        // runtime-caches it (CacheFirst) instead, so it works offline after one online
        // load and otherwise falls back to the stylized cone trees — the SHELL precache
        // stays small (index + the core hashed chunk + css + manifest + icon).
        globIgnores: [
          '**/*.map',
          'assets/**/*.mp3',
          'assets/ez-tree*.js',
          'auth.html',
          'src/**',
          'tests/**',
          'node_modules/**',
          'README.md',
          'LICENSE',
        ],
      },
      devOptions: { enabled: false },
    }),
    copyStaticAppFiles()
  ]
});
