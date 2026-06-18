#!/usr/bin/env node
/**
 * Line-level LCOV merger for the honest-coverage work.
 *
 * Combines the c8 Node/verification LCOV (`coverage/lcov.info`) with the browser
 * LCOV produced by `browser-coverage.js` (`coverage/browser/lcov.info`) into a
 * single `coverage/lcov.info` for the Codecov upload.
 *
 * Why merge at the LCOV (line) level instead of with istanbul-lib-coverage:
 * c8 instruments Node's type-stripped `.ts` and Vite instruments its esbuild
 * output, so the two produce *different* statement/function/branch structures for
 * the same source file. Summing them as Istanbul objects (keyed by statement
 * index) would mis-attribute hits. LCOV records are keyed by the original `.ts`
 * line/function name/branch position, which both tools map back to identically,
 * so a record-level union is correct.
 *
 * Usage:
 *   node tests/coverage/merge-lcov.js --out coverage/lcov.info \
 *       coverage/lcov.info coverage/browser/lcov.info
 *
 * Missing inputs are skipped with a warning so the step is a no-op (or a simple
 * normalize) when, e.g., browser coverage was not collected. The output is fully
 * buffered before writing, so naming an input as the output is safe.
 */

const fs = require('fs');
const path = require('path');

// c8's `--all` placeholder for files with zero coverage. It is meaningless once
// real coverage exists, so it is dropped from function records during merge.
const EMPTY_REPORT_FN = '(empty-report)';

function parseArgs(argv) {
  let out = path.join('coverage', 'lcov.info');
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[++i];
    } else {
      inputs.push(argv[i]);
    }
  }
  if (inputs.length === 0) {
    inputs.push(path.join('coverage', 'lcov.info'), path.join('coverage', 'browser', 'lcov.info'));
  }
  return { out, inputs };
}

// Normalize an SF path to a stable repo-relative key so absolute (c8 in some
// environments) and relative (istanbul) paths for the same file collapse.
function normalizeSourcePath(sf) {
  let p = sf.trim().replace(/\\/g, '/');
  const cwd = process.cwd().replace(/\\/g, '/');
  if (p.startsWith(cwd + '/')) p = p.slice(cwd.length + 1);
  p = p.replace(/^\.\//, '');
  const srcIdx = p.indexOf('/src/');
  if (path.isAbsolute(p) && srcIdx !== -1) p = p.slice(srcIdx + 1);
  return p;
}

function emptyFile(sf) {
  return {
    sf,
    lines: new Map(),        // line -> hit count
    fns: new Map(),          // name -> { line, hits }
    branches: new Map()      // "line,block,branch" -> taken (number) | null
  };
}

function parseLcov(text) {
  const files = new Map();
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      const sf = normalizeSourcePath(line.slice(3));
      cur = files.get(sf);
      if (!cur) {
        cur = emptyFile(sf);
        files.set(sf, cur);
      }
    } else if (!cur) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [lineNo, count] = line.slice(3).split(',');
      const n = Number(lineNo);
      cur.lines.set(n, (cur.lines.get(n) || 0) + Number(count));
    } else if (line.startsWith('FN:')) {
      const idx = line.indexOf(',');
      const fnLine = Number(line.slice(3, idx));
      const name = line.slice(idx + 1);
      if (name !== EMPTY_REPORT_FN && !cur.fns.has(name)) {
        cur.fns.set(name, { line: fnLine, hits: 0 });
      }
    } else if (line.startsWith('FNDA:')) {
      const idx = line.indexOf(',');
      const hits = Number(line.slice(5, idx));
      const name = line.slice(idx + 1);
      if (name === EMPTY_REPORT_FN) continue;
      const fn = cur.fns.get(name) || { line: 0, hits: 0 };
      fn.hits += hits;
      cur.fns.set(name, fn);
    } else if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',');
      const key = `${parts[0]},${parts[1]},${parts[2]}`;
      const takenRaw = parts[3];
      const prev = cur.branches.get(key);
      if (takenRaw === '-') {
        if (prev === undefined) cur.branches.set(key, null);
      } else {
        cur.branches.set(key, (prev || 0) + Number(takenRaw));
      }
    }
    // LF/LH/FNF/FNH/BRF/BRH/TN are recomputed, so ignore them on input.
  }
  return files;
}

function mergeInto(target, incoming) {
  for (const [sf, file] of incoming) {
    let dst = target.get(sf);
    if (!dst) {
      dst = emptyFile(sf);
      target.set(sf, dst);
    }
    for (const [ln, count] of file.lines) {
      dst.lines.set(ln, (dst.lines.get(ln) || 0) + count);
    }
    for (const [name, fn] of file.fns) {
      const existing = dst.fns.get(name);
      if (existing) {
        existing.hits += fn.hits;
        if (!existing.line) existing.line = fn.line;
      } else {
        dst.fns.set(name, { line: fn.line, hits: fn.hits });
      }
    }
    for (const [key, taken] of file.branches) {
      if (dst.branches.has(key)) {
        const prev = dst.branches.get(key);
        if (taken === null && prev === null) continue;
        dst.branches.set(key, (prev || 0) + (taken || 0));
      } else {
        dst.branches.set(key, taken);
      }
    }
  }
}

function serialize(files) {
  const out = [];
  for (const sf of [...files.keys()].sort()) {
    const file = files.get(sf);
    out.push('TN:');
    out.push(`SF:${sf}`);

    const fnNames = [...file.fns.keys()].sort((a, b) => file.fns.get(a).line - file.fns.get(b).line);
    let fnHit = 0;
    for (const name of fnNames) {
      out.push(`FN:${file.fns.get(name).line},${name}`);
    }
    for (const name of fnNames) {
      const hits = file.fns.get(name).hits;
      if (hits > 0) fnHit++;
      out.push(`FNDA:${hits},${name}`);
    }
    out.push(`FNF:${fnNames.length}`);
    out.push(`FNH:${fnHit}`);

    const branchKeys = [...file.branches.keys()].sort((a, b) => {
      const pa = a.split(',').map(Number);
      const pb = b.split(',').map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
    let brHit = 0;
    for (const key of branchKeys) {
      const taken = file.branches.get(key);
      if (taken !== null && taken > 0) brHit++;
      out.push(`BRDA:${key},${taken === null ? '-' : taken}`);
    }
    if (branchKeys.length > 0) {
      out.push(`BRF:${branchKeys.length}`);
      out.push(`BRH:${brHit}`);
    }

    const lineNos = [...file.lines.keys()].sort((a, b) => a - b);
    let lineHit = 0;
    for (const ln of lineNos) {
      const count = file.lines.get(ln);
      if (count > 0) lineHit++;
      out.push(`DA:${ln},${count}`);
    }
    out.push(`LF:${lineNos.length}`);
    out.push(`LH:${lineHit}`);
    out.push('end_of_record');
  }
  return out.join('\n') + '\n';
}

function mergeLcovText(texts) {
  const merged = new Map();
  for (const text of texts) {
    mergeInto(merged, parseLcov(text));
  }
  return serialize(merged);
}

function main() {
  const { out, inputs } = parseArgs(process.argv.slice(2));
  const merged = new Map();
  let read = 0;
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.warn(`merge-lcov: input not found, skipping: ${input}`);
      continue;
    }
    mergeInto(merged, parseLcov(fs.readFileSync(input, 'utf8')));
    read++;
  }
  if (read === 0) {
    console.error('merge-lcov: no input LCOV files found; nothing written');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, serialize(merged));

  let totalLF = 0;
  let totalLH = 0;
  for (const file of merged.values()) {
    totalLF += file.lines.size;
    for (const c of file.lines.values()) if (c > 0) totalLH++;
  }
  const pct = totalLF === 0 ? 0 : ((totalLH / totalLF) * 100).toFixed(2);
  console.log(`merge-lcov: merged ${read} report(s) into ${out}`);
  console.log(`merge-lcov: ${merged.size} files, ${totalLH}/${totalLF} lines (${pct}%)`);
}

module.exports = {
  parseLcov,
  mergeInto,
  serialize,
  mergeLcovText,
  normalizeSourcePath
};

if (require.main === module) {
  main();
}
