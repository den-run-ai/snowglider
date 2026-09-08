// @ts-check
// Firestore cannot import the client's versioned names. Check every shipped
// schema, including historical versioned fields that survive on users/{uid}.
// Replacing V3 with V4 would otherwise reject profile updates on existing users.
// Run: node --import ./tests/loaders/register-ts-resolve.mjs tests/remote-version-sync-tests.js
const fs = require('fs');
const path = require('path');
const { SHIPPED_REMOTE_VERSIONS, REMOTE_SCORE_SCHEMAS, schemaForVersion } = require('./lib/remote-score-schemas.js');

let pass = 0, fail = 0;
function check(name, ok) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (ok) pass++; else fail++;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scope assertions to their function / match block, rather than counting names
// anywhere (comments or one allowlist could otherwise mask the other).
function blockAfter(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return '';
  const open = source.indexOf('{', start + header.length);
  if (open < 0) return '';
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return '';
}

function inspectRules(source, schemas) {
  const rules = source.replace(/\/\/[^\n]*/g, '');
  const createKeys = blockAfter(rules, 'function validUserKeys(data)');
  const updateKeys = blockAfter(rules, 'function validChangedUserFields()');
  const createDoc = blockAfter(rules, 'function validUserDoc(data)');
  const updateBest = blockAfter(rules, 'function validBestTimeUpdate()');
  const results = [];
  const record = (name, ok) => results.push({ name, ok });
  for (const schema of schemas) {
    const validator = esc(schema.scoreValidator);
    const bounds = blockAfter(rules, `function ${schema.scoreValidator}(time)`);
    record(`${schema.label}: preserves score floor/cap ${schema.minTime}/${schema.maxTime}`,
      new RegExp(`time\\s+is\\s+number\\s*&&\\s*time\\s*>=\\s*${schema.minTime}\\s*&&\\s*time\\s*<=\\s*${schema.maxTime}\\s*;`).test(bounds));
    for (const { field, board, ranked } of schema.tiers) {
      const quoted = `'${field}'`;
      const escaped = esc(field);
      record(`${field}: create allowlist`, createKeys.includes(quoted));
      record(`${field}: update allowlist`, updateKeys.includes(quoted));
      record(`${field}: create plausibility`, new RegExp(`${validator}\\(data\\.${escaped}\\)`).test(createDoc));
      record(`${field}: update plausibility`, new RegExp(`${validator}\\(request\\.resource\\.data\\.${escaped}\\)`).test(updateBest));
      record(`${field}: monotonic within its own schema`,
        new RegExp(`request\\.resource\\.data\\.${escaped}\\s*<=\\s*resource\\.data\\.${escaped}`).test(updateBest));
      const boardBlock = blockAfter(rules, `match /${board}/{userId}`);
      record(`${board}: authenticated reads`, /allow\s+get,\s*list:\s*if\s+isSignedIn\(\)/.test(boardBlock));
      if (ranked) {
        record(`${board}: validated create`, /allow\s+create:[^;]*validLeaderboardDoc/.test(boardBlock));
        record(`${board}: validated update`, /allow\s+update:[^;]*validLeaderboardUpdate/.test(boardBlock));
      } else {
        record(`${board}: unranked writes denied`, /allow\s+write:\s*if\s+false/.test(boardBlock));
      }
    }
  }
  return results;
}

(async () => {
  const D = await import('../src/difficulty.ts');
  const { PHYSICS_VERSION } = await import('../src/run-context.ts');
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const rulesTests = fs.readFileSync(path.join(__dirname, 'firestore-rules-tests.js'), 'utf8');

  console.log('--- append-only remote schema history ---');
  // [3] -> [4] must fail even when the active client, rules and emulator all agree
  // on V4. Keep every version, including ones deployed only briefly.
  for (let version = 3; version <= PHYSICS_VERSION; version++) {
    check(`shipped v${version} stays in emulator and compatibility coverage`, SHIPPED_REMOTE_VERSIONS.includes(version));
  }
  check('remote schema history contains the active version', SHIPPED_REMOTE_VERSIONS.includes(PHYSICS_VERSION));
  check('remote schema history is unique and ordered',
    SHIPPED_REMOTE_VERSIONS.every((v, i, all) => Number.isInteger(v) && v >= 3 && (i === 0 || v > all[i - 1])));
  const active = REMOTE_SCORE_SCHEMAS.find(schema => schema.version === PHYSICS_VERSION);
  if (active) {
    for (const { tier, field, board } of active.tiers) {
      check(`${tier}: client field matches registered active schema`, D.userBestTimeField(tier) === field);
      check(`${tier}: client board matches registered active schema`, D.leaderboardCollectionName(tier) === board);
    }
  }
  const legacy = REMOTE_SCORE_SCHEMAS.find(schema => schema.version === null);
  check('the unversioned schema remains in compatibility coverage', !!legacy);
  if (legacy) {
    for (const { tier, field, board } of legacy.tiers) {
      check(`${tier}: legacy client field stays stable`, D.legacyUserBestTimeField(tier) === field);
      check(`${tier}: legacy client board stays stable`, D.legacyLeaderboardCollectionName(tier) === board);
    }
  }
  check('emulator uses the same complete schema history',
    /require\('\.\/lib\/remote-score-schemas\.js'\)/.test(rulesTests)
    && /for\s*\(const schema of REMOTE_SCORE_SCHEMAS\)/.test(rulesTests));

  console.log('\n--- rules preserve every shipped schema ---');
  for (const { name, ok } of inspectRules(rules, REMOTE_SCORE_SCHEMAS)) check(name, ok);

  console.log('\n--- regression: a future active-only V4 replacement is rejected ---');
  const replacement = rules.replace(/V3\b/g, 'V4').replace(/_v3\b/g, '_v4').replace(/_v3_/g, '_v4_');
  const nextSchema = schemaForVersion(4);
  check('mutation supplies a complete, valid V4 schema', inspectRules(replacement, [nextSchema]).every(result => result.ok));
  check('mutation cannot drop historical V3 fields or boards',
    inspectRules(replacement, REMOTE_SCORE_SCHEMAS).some(result => !result.ok));
  const missingCreateKey = rules.replace("        'bestTimeV3',", '');
  check('missing V3 create allowlist entry fails despite update references',
    inspectRules(missingCreateKey, REMOTE_SCORE_SCHEMAS).some(result => result.name === 'bestTimeV3: create allowlist' && !result.ok));
  const missingUpdateKey = rules.replace("          'bestTimeV3',", '');
  check('missing V3 update allowlist entry fails despite create references',
    inspectRules(missingUpdateKey, REMOTE_SCORE_SCHEMAS).some(result => result.name === 'bestTimeV3: update allowlist' && !result.ok));

  console.log(`\nREMOTE-VERSION SYNC TEST TOTAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
