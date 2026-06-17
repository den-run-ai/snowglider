import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = 'dist';

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
    }
  };
}

export default defineConfig({
  base: '/',
  build: {
    outDir,
    sourcemap: true,
    rollupOptions: {
      input: {
        // Keep the existing page as Vite's HTML entry so dist/index.html is
        // emitted exactly as before (classic CDN + script-loader boot path).
        index: path.resolve(rootDir, 'index.html'),
        // Phase 2.0 (issue #84): a real ES-module bundle (three.js from npm)
        // emitted alongside the page to stand up the bundling pipeline. It is
        // not yet referenced by index.html; per-module conversions wire it in.
        bundle: path.resolve(rootDir, 'src/main.js')
      }
    }
  },
  plugins: [copyStaticAppFiles()]
});
