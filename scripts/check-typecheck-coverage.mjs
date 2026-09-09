#!/usr/bin/env node
// Keep every app/test/config file in an explicit compiler project. Checking new
// files must not depend on remembering an opt-in comment or a hand-edited glob.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Shrink this list as the classic browser harness migrates. Exemptions are exact
// paths, never patterns; a newly added test is checked regardless of its name.
export const LEGACY_EXCLUSIONS = {
  'tests/audio-tests.js': 'Legacy in-page suite uses mutable browser runner globals.',
  'tests/browser-avalanche-tests.js': 'Legacy in-page suite mutates classic game globals.',
  'tests/browser-regression-tests.js': 'Legacy in-page suite mutates classic game globals.',
  'tests/browser-tests.js': 'Legacy in-page suite mutates classic game globals.',
  'tests/browser-tree-tests.js': 'Legacy in-page suite mutates classic game globals.',
  'tests/camera-tests.js': 'Legacy in-page suite mutates classic game globals.',
  'tests/controls-tests.js': 'Legacy in-page suite uses mutable browser runner globals.',
  'tests/unified-test-runner.js': 'Classic browser suite registration and shared results.',
  'tests/verification/snowman_baseline.js': 'Frozen historical physics oracle; do not rewrite.',
};

/**
 * @param {string} root
 * @param {Record<string, string>} legacyExclusions
 */
export function auditTypecheckCoverage(root, legacyExclusions = LEGACY_EXCLUSIONS) {
  /** @type {string[]} */
  const errors = [];
  const included = new Set();
  const configs = ['tsconfig.json', 'tsconfig.tests.json', 'tsconfig.worker.json', 'tsconfig.e2e.json'];
  for (const config of configs) {
    const filename = path.join(root, config);
    const read = ts.readConfigFile(filename, ts.sys.readFile);
    if (read.error) {
      errors.push(`${config}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    for (const error of parsed.errors) {
      errors.push(`${config}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
    }
    // E2E TypeScript is strict; its imported JS helpers belong to the separate
    // default-on JS project. Never count unchecked JS roots as covered there.
    if ((config !== 'tsconfig.e2e.json' && !parsed.options.checkJs) || parsed.options.noCheck) {
      errors.push(`${config}: require checkJs:true and noCheck:false.`);
    }
    for (const filename of parsed.fileNames) {
      if (parsed.options.checkJs || filename.endsWith('.ts')) included.add(path.resolve(filename));
    }
  }

  const expected = ts.sys.readDirectory(root, ['.ts', '.js', '.mjs', '.cjs'],
    ['node_modules', 'dist', 'coverage', 'test-results'],
    ['src/**/*', 'tests/**/*', '*.config.ts', '*.config.js', '*.config.mjs', '*.config.cjs', 'scripts/check-typecheck-coverage.mjs']);
  for (const filename of expected) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    if (relative.endsWith('.d.ts')) continue;
    const isIncluded = included.has(path.resolve(filename));
    if (Object.hasOwn(legacyExclusions, relative)) {
      if (isIncluded) errors.push(`${relative}: remove its now-unnecessary legacy exemption.`);
      continue;
    }
    if (!isIncluded) errors.push(`${relative}: missing from every type-check project.`);
    // The compiler directive may appear after a license header or shebang. Do
    // not let a new directive silently defeat an otherwise complete include glob.
    if (/^\s*\/{2,}\s*@ts-nocheck\b/m.test(readFileSync(filename, 'utf8'))) {
      errors.push(`${relative}: @ts-nocheck is not an allowed type-check escape.`);
    }
  }
  for (const relative of Object.keys(legacyExclusions)) {
    if (!ts.sys.fileExists(path.join(root, relative))) {
      errors.push(`${relative}: remove the stale legacy exemption for a missing file.`);
    }
  }
  return { errors, checkedCount: included.size, legacyCount: Object.keys(legacyExclusions).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = auditTypecheckCoverage(root);
  if (result.errors.length) {
    console.error(result.errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Type-check coverage: ${result.checkedCount} project files; ${result.legacyCount} explicit legacy exceptions.`);
  }
}
