// @ts-check
/**
 * Unit tests for the LCOV line-level merger (tests/coverage/merge-lcov.js).
 *
 * Guards the merge contract used to combine c8 (Node + verification) coverage
 * with Chromium browser coverage into a single coverage/lcov.info:
 *   - line (DA) hit counts are unioned/summed across reports
 *   - c8's `--all` synthetic `(empty-report)` function record is dropped
 *   - function (FN/FNDA) hits sum by name; branches (BRDA) union by position
 *   - LF/LH/FNF/FNH/BRF/BRH counters are recomputed and internally consistent
 *   - SF paths are normalized so absolute (c8) and relative (istanbul) keys merge
 */

const { mergeLcovText, normalizeSourcePath } = require('./coverage/merge-lcov');

console.log('\n🏂 SNOWGLIDER COVERAGE-MERGE TESTS 🏂');
console.log('=====================================\n');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`✅ PASS: ${name}`);
  } else {
    failures++;
    console.log(`❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Parse a serialized LCOV back into a per-file record lookup for assertions.
function recordsFor(lcov, sf) {
  const rec = { lines: {}, fns: {}, branches: {}, counters: {} };
  let inFile = false;
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) inFile = line.slice(3) === sf;
    else if (!inFile) continue;
    else if (line.startsWith('DA:')) {
      const [l, c] = line.slice(3).split(',');
      rec.lines[l] = Number(c);
    } else if (line.startsWith('FNDA:')) {
      const [c, name] = [line.slice(5, line.indexOf(',', 5)), line.slice(line.indexOf(',', 5) + 1)];
      rec.fns[name] = Number(c);
    } else if (line.startsWith('BRDA:')) {
      const p = line.slice(5).split(',');
      rec.branches[`${p[0]},${p[1]},${p[2]}`] = p[3];
    } else if (/^(LF|LH|FNF|FNH|BRF|BRH):/.test(line)) {
      const [k, v] = line.split(':');
      rec.counters[k] = Number(v);
    } else if (line === 'end_of_record') {
      inFile = false;
    }
  }
  return rec;
}

// --- Report A: c8-style. File covered, plus an `--all` empty-report placeholder. ---
const reportA = [
  'TN:',
  'SF:src/player-state.ts',
  'FN:10,stepPlayer',
  'FNDA:3,stepPlayer',
  'FNF:1',
  'FNH:1',
  'BRDA:10,0,0,2',
  'BRDA:10,0,1,0',
  'BRF:2',
  'BRH:1',
  'DA:1,1',
  'DA:2,0',
  'DA:3,1',
  'LF:3',
  'LH:2',
  'end_of_record',
  'TN:',
  'SF:src/snowglider.ts',
  'FN:1,(empty-report)',
  'FNDA:0,(empty-report)',
  'FNF:1',
  'FNH:0',
  'DA:1,0',
  'DA:2,0',
  'LF:2',
  'LH:0',
  'end_of_record',
  ''
].join('\n');

// --- Report B: browser-style. Adds coverage for the same and the browser-only file. ---
const reportB = [
  'TN:',
  'SF:src/player-state.ts',
  'FN:10,stepPlayer',
  'FNDA:5,stepPlayer',
  'FNF:1',
  'FNH:1',
  'BRDA:10,0,0,1',
  'BRDA:10,0,1,4',
  'BRF:2',
  'BRH:2',
  'DA:1,1',
  'DA:2,7',
  'DA:3,1',
  'LF:3',
  'LH:3',
  'end_of_record',
  'TN:',
  'SF:src/snowglider.ts',
  'FN:20,startGame',
  'FNDA:2,startGame',
  'FNF:1',
  'FNH:1',
  'DA:1,1',
  'DA:2,4',
  'LF:2',
  'LH:2',
  'end_of_record',
  ''
].join('\n');

const merged = mergeLcovText([reportA, reportB]);

const physics = recordsFor(merged, 'src/player-state.ts');
check('line hits sum across reports', physics.lines['2'] === 7, `got DA:2,${physics.lines['2']}`);
check('line covered in only one report becomes covered',
  physics.counters.LH === 3 && physics.counters.LF === 3,
  `LH:${physics.counters.LH} LF:${physics.counters.LF}`);
check('function hits sum by name', physics.fns.stepPlayer === 8, `got ${physics.fns.stepPlayer}`);
check('branch taken counts sum by position',
  physics.branches['10,0,0'] === '3' && physics.branches['10,0,1'] === '4',
  `b0=${physics.branches['10,0,0']} b1=${physics.branches['10,0,1']}`);
check('BRF/BRH recomputed', physics.counters.BRF === 2 && physics.counters.BRH === 2,
  `BRF:${physics.counters.BRF} BRH:${physics.counters.BRH}`);

const snow = recordsFor(merged, 'src/snowglider.ts');
check('empty-report placeholder dropped, real function kept',
  snow.fns['(empty-report)'] === undefined && snow.fns.startGame === 2,
  `keys=${Object.keys(snow.fns).join('|')}`);
check('browser coverage replaces all-zero c8 placeholder lines',
  snow.lines['2'] === 4 && snow.counters.LH === 2,
  `DA:2,${snow.lines['2']} LH:${snow.counters.LH}`);
check('FNF/FNH recomputed without placeholder',
  snow.counters.FNF === 1 && snow.counters.FNH === 1,
  `FNF:${snow.counters.FNF} FNH:${snow.counters.FNH}`);

check('no duplicate SF records', (merged.match(/^SF:/gm) || []).length === 2,
  `${(merged.match(/^SF:/gm) || []).length} SF lines`);
check('no (empty-report) anywhere in merged output', !merged.includes('(empty-report)'));

// Path normalization: absolute c8-style path and relative path collapse to one file.
const abs = `TN:\nSF:${process.cwd()}/src/audio.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
const rel = 'TN:\nSF:src/audio.ts\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record\n';
const mergedPaths = mergeLcovText([abs, rel]);
check('absolute and relative SF normalize to one record',
  (mergedPaths.match(/^SF:/gm) || []).length === 1 && mergedPaths.includes('SF:src/audio.ts'),
  mergedPaths.match(/^SF:.*/m) && mergedPaths.match(/^SF:.*/m)[0]);
check('normalizeSourcePath strips cwd prefix and ./',
  normalizeSourcePath(`${process.cwd()}/src/x.ts`) === 'src/x.ts' &&
  normalizeSourcePath('./src/y.ts') === 'src/y.ts');

console.log(`\n${failures === 0 ? '✅ ALL COVERAGE-MERGE TESTS PASSED' : `❌ ${failures} TEST(S) FAILED`}\n`);
process.exit(failures > 0 ? 1 : 0);
