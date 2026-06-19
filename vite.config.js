import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defineConfig } from 'vite';

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

      // Publish the single three.js ESM build the page import map points at
      // (`/node_modules/three/build/three.module.min.js`). The bundled game never
      // hits the import map (Vite inlines three into the hashed chunk), but the
      // verbatim-copied browser tests in dist/tests load as `<script type="module">`
      // and import bare `three`, so on Pages — where node_modules is NOT published —
      // they'd 404 and the `?test=…` entry points would fail before registering
      // their window.run*Tests hooks. Copying just this one file (not all of
      // node_modules) keeps those deployed test pages resolving three (issue #84).
      const threeRel = path.join('node_modules', 'three', 'build', 'three.module.min.js');
      await mkdir(path.join(distDir, path.dirname(threeRel)), { recursive: true });
      await cp(path.join(rootDir, threeRel), path.join(distDir, threeRel), { force: true });

      await transpileCopiedTypeScriptSources(path.join(distDir, 'src'));
      await rewriteCopiedThreeImports(path.join(distDir, 'src'));
      await rewriteCopiedThreeImports(path.join(distDir, 'tests'));
    }
  };
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
  plugins: [injectBuildId(), copyStaticAppFiles()]
});
