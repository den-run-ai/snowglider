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
    sourcemap: true
  },
  plugins: [copyStaticAppFiles()]
});
