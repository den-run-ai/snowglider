// @ts-check
// Pure daily identity: untrusted invitations cannot silently become ranked runs.
const assert = require('node:assert/strict');

(async () => {
  const realRandom = Math.random;
  const globalDescriptors = new Map();
  let globalDraws = 0;
  const globals = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'];
  for (const name of globals) {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { throw new Error(`Daily core accessed ${name}`); },
    });
  }
  Math.random = () => { globalDraws++; throw new Error('Daily core consumed global RNG'); };
  try {
    const {
      DAILY_CHALLENGE_VERSION, createDailyChallenge, utcDayString,
      parseDailyChallenge, buildDailyChallengeUrl, isDailyChallenge,
      isValidDailyTargetMs, isDailyRunEligible,
    } = await import('../src/daily-challenge.ts');
    const { PHYSICS_VERSION, getRunStamp } = await import('../src/run-context.ts');
    const originalStamp = getRunStamp();
    const now = new Date('2026-11-08T12:00:00.000Z');
    const base = '?daily=2026-11-08&level=blue&cv=1&pv=4';
    const expected = {
      id: 'd1-v4-20765-blue', date: '2026-11-08', day: 20765,
      difficulty: 'blue', physicsVersion: 4, challengeVersion: 1,
      seed: 1218096549, nonce: 0, name: 'Frost Peak',
    };
    const blue = createDailyChallenge('2026-11-08', 'blue');
    assert.equal(DAILY_CHALLENGE_VERSION, 1, 'change daily protocol fixtures deliberately');
    assert.equal(PHYSICS_VERSION, 4, 'challenge physics changes need new link fixtures');
    assert.deepEqual(blue, expected);
    assert.ok(Object.isFrozen(blue));
    assert.equal(isDailyChallenge(blue), true);
    assert.equal(isDailyChallenge(JSON.parse(JSON.stringify(blue))), true);
    assert.deepEqual(parseDailyChallenge(base, now), { kind: 'daily', challenge: blue, targetMs: null });
    assert.deepEqual(parseDailyChallenge(base.slice(1), now), { kind: 'daily', challenge: blue, targetMs: null });

    // UTC identity is independent of local timezone, and does not round to the
    // next day. Explicit offsets cover both sides of the international date line.
    assert.equal(utcDayString(now), '2026-11-08');
    assert.equal(utcDayString(now.getTime()), '2026-11-08');
    assert.equal(utcDayString(new Date('2026-11-08T00:30:00+14:00')), '2026-11-07');
    assert.equal(utcDayString(new Date('2026-11-08T23:30:00-11:00')), '2026-11-09');
    assert.equal(utcDayString(new Date('2026-11-08T23:59:59.999Z')), '2026-11-08');
    assert.equal(utcDayString(new Date('2026-11-09T00:00:00.000Z')), '2026-11-09');
    assert.equal(createDailyChallenge('1970-01-01', 'bunny').day, 0);
    assert.equal(createDailyChallenge('1970-01-01', 'bunny').seed, 1013904223);
    assert.equal(createDailyChallenge('2000-02-29', 'blue').day + 1, createDailyChallenge('2000-03-01', 'blue').day);
    assert.equal(createDailyChallenge('2024-02-29', 'blue').day + 1, createDailyChallenge('2024-03-01', 'blue').day);
    assert.equal(createDailyChallenge('9999-12-31', 'expert').day, 2932896);
    assert.equal(utcDayString(new Date('9999-12-31T23:59:59.999Z')), '9999-12-31');
    for (const invalid of [NaN, Infinity, -Infinity, -1, 8640000000000001, new Date(NaN)]) {
      assert.throws(() => utcDayString(invalid), RangeError);
    }
    for (const date of [
      '', '2026-11-8', '2026-1-08', '2026/11/08', '2026-11-08 ',
      ' 2026-11-08', '2026-11-08T00:00:00Z', '2026-02-29', '1900-02-29',
      '2100-02-29', '2026-02-30', '2026-04-31', '2026-00-01', '2026-13-01',
      '2026-01-00', '2026-01-32', '1969-12-31', '0000-01-01', '10000-01-01',
      'NaN', '<script>', '２０２６-１１-０８',
    ]) {
      assert.throws(() => createDailyChallenge(date, 'blue'), RangeError, date);
      assert.equal(parseDailyChallenge(`${base.replace('2026-11-08', encodeURIComponent(date))}`, now).kind, 'invalid', date);
    }
    for (const difficulty of ['', 'Blue', 'blue ', 'green', '__proto__', 'constructor']) {
      assert.throws(() => createDailyChallenge('2026-11-08',
        /** @type {import('../src/difficulty.ts').Difficulty} */ (difficulty)), TypeError);
      assert.equal(parseDailyChallenge(base.replace('level=blue', `level=${encodeURIComponent(difficulty)}`), now).kind, 'invalid');
    }

    // No daily marker leaves ordinary links alone. Partial daily identity is
    // rejected instead of being interpreted as an ordinary canonical run.
    for (const ordinary of ['', '?seed=123', '?play=black', '?level=expert', '?utm_source=friend', '?seed=123&play=blue']) {
      assert.deepEqual(parseDailyChallenge(ordinary, now), { kind: 'none' }, ordinary);
    }
    for (const partial of ['?daily=', '?cv=1', '?pv=4', '?beat=35000', '?Daily=2026-11-08', '?CV=1', '?PV=4', '?BEAT=35000']) {
      assert.equal(parseDailyChallenge(partial, now).kind, 'invalid', partial);
    }
    for (const key of ['daily', 'level', 'cv', 'pv']) {
      const params = new URLSearchParams(base);
      params.delete(key);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid', `missing ${key}`);
    }
    for (const key of ['daily', 'level', 'cv', 'pv', 'beat', 'seed', 'play']) {
      const params = new URLSearchParams(base);
      const value = params.get(key) ?? (key === 'play' ? 'blue' : '35000');
      params.set(key, value);
      params.append(key, value);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid', `duplicate ${key}`);
      params.set(key, value);
      params.append(key, 'different');
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid', `conflicting ${key}`);
    }
    assert.equal(parseDailyChallenge(`${base}&%64aily=2026-11-08`, now).kind, 'invalid', 'decoded duplicate');
    assert.equal(parseDailyChallenge(`${base}&seed=${blue.seed}`, now).kind, 'invalid', 'even matching raw seed is ambiguous');
    assert.equal(parseDailyChallenge(`${base}&seed=`, now).kind, 'invalid');
    assert.equal(parseDailyChallenge(`${base}&Level=black`, now).kind, 'invalid');
    assert.equal(parseDailyChallenge(`${base}&play=black`, now).kind, 'invalid');
    assert.equal(parseDailyChallenge(`${base}&play=bogus`, now).kind, 'invalid');
    assert.equal(parseDailyChallenge(`${base}&play=blue`, now).kind, 'daily');
    assert.equal(parseDailyChallenge(`${base}&utm_source=friend&quality=low`, now).kind, 'daily');
    assert.equal(parseDailyChallenge(`${base}&unused=${'a'.repeat(8192)}`, now).kind, 'invalid');
    assert.equal(parseDailyChallenge(base, new Date(NaN)).kind, 'invalid');

    for (const version of ['', '0', '01', '-1', '+1', '1.0', '1e0', '1 ', ' 1', 'Infinity', '1000000000', '１']) {
      const params = new URLSearchParams(base);
      params.set('cv', version);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid', version);
      params.set('cv', '1');
      params.set('pv', version);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid', version);
    }
    for (const query of [base.replace('cv=1', 'cv=2'), base.replace('pv=4', 'pv=3'), base.replace('pv=4', 'pv=5')]) {
      assert.equal(parseDailyChallenge(query, now).kind, 'unsupported');
    }
    assert.equal(parseDailyChallenge(base, new Date('2026-11-07T23:59:59.999Z')).kind, 'invalid');
    assert.equal(parseDailyChallenge(base, new Date('2026-11-08T00:00:00.000Z')).kind, 'daily');
    assert.equal(parseDailyChallenge(base, new Date('2026-11-09T00:00:00.000Z')).kind, 'daily', 'old friend links stay playable');
    assert.equal(parseDailyChallenge(base.replace('2026-11-08', '2026-11-09'), now).kind, 'invalid');

    /** @type {import('../src/difficulty.ts').Difficulty[]} */
    const tiers = ['bunny', 'blue', 'black', 'expert'];
    const tierSeeds = new Set();
    const ids = new Set();
    for (const tier of tiers) {
      const challenge = createDailyChallenge('2026-11-08', tier);
      const minMs = tier === 'bunny' || tier === 'blue' ? 15000 : 10000;
      assert.ok(Number.isInteger(challenge.seed) && challenge.seed >= 0 && challenge.seed < 4294967296);
      tierSeeds.add(challenge.seed);
      assert.match(challenge.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
      assert.equal(isValidDailyTargetMs(minMs, tier), true);
      assert.equal(isValidDailyTargetMs(600000, tier), true);
      for (const target of [minMs - 1, 600001, 1.5, NaN, Infinity, -Infinity, '35000', null, undefined]) {
        assert.equal(isValidDailyTargetMs(target, tier), false);
      }
      const clean = buildDailyChallengeUrl(challenge);
      assert.deepEqual([...new URL(clean).searchParams.keys()], ['daily', 'level', 'cv', 'pv']);
      for (const target of [minMs, 35000, 600000]) {
        const url = buildDailyChallengeUrl(challenge, 'https://user:secret@example.test:8443/game/index.html?seed=99&debug=1&beat=1#private', target);
        const parsedUrl = new URL(url);
        assert.equal(parsedUrl.origin, 'https://example.test:8443');
        assert.equal(parsedUrl.pathname, '/game/index.html');
        assert.equal(parsedUrl.username, '');
        assert.equal(parsedUrl.password, '');
        assert.equal(parsedUrl.hash, '');
        assert.deepEqual([...parsedUrl.searchParams.keys()], ['daily', 'level', 'cv', 'pv', 'beat']);
        const parsed = parseDailyChallenge(parsedUrl.search, now);
        assert.deepEqual(parsed, { kind: 'daily', challenge, targetMs: target });
        assert.deepEqual(challenge, createDailyChallenge(challenge.date, tier), 'target never modifies challenge');
      }
      for (const badTarget of [String(minMs - 1), '600001', '', '0', '-35000', '+35000', '035000', '35000.0', '3.5e4', ' 35000', '35000 ', 'Infinity', 'NaN', '0x88b8', '35_000', '💥']) {
        assert.equal(parseDailyChallenge(`${new URL(clean).search}&beat=${encodeURIComponent(badTarget)}`, now).kind, 'invalid', badTarget);
      }
      assert.throws(() => buildDailyChallengeUrl(challenge, undefined, minMs - 1), RangeError);
      assert.throws(() => buildDailyChallengeUrl(challenge, undefined, Infinity), RangeError);
      assert.throws(() => buildDailyChallengeUrl(challenge, undefined, 35000.5), RangeError);

      const stamp = { seed: challenge.seed, practice: true, nonce: 0, physicsVersion: PHYSICS_VERSION };
      assert.equal(isDailyRunEligible(challenge, stamp, tier, minMs / 1000), true);
      assert.equal(isDailyRunEligible(challenge, stamp, tier, 35.123456), true);
      assert.equal(isDailyRunEligible(challenge, stamp, tier, 600), true);
      for (const time of [minMs / 1000 - 0.001, 600.001, NaN, Infinity, -1]) {
        assert.equal(isDailyRunEligible(challenge, stamp, tier, time), false);
      }
      assert.equal(isDailyRunEligible(challenge, stamp, tier, 35, true), false);
      for (const broken of [
        { ...stamp, seed: null }, { ...stamp, seed: challenge.seed + 1 },
        { ...stamp, practice: false }, { ...stamp, nonce: 1 },
        { ...stamp, physicsVersion: PHYSICS_VERSION + 1 },
      ]) assert.equal(isDailyRunEligible(challenge, broken, tier, 35), false);
      const otherTier = tier === 'blue' ? 'black' : 'blue';
      assert.equal(isDailyRunEligible(challenge, stamp, otherTier, 35), false);

      // Sample a full year: each day and tier has independent immutable identity.
      for (let day = 0; day < 366; day++) {
        const daily = createDailyChallenge(utcDayString(now.getTime() - day * 86400000), tier);
        assert.equal(ids.has(daily.id), false);
        ids.add(daily.id);
        assert.deepEqual(createDailyChallenge(daily.date, tier), daily);
      }
    }
    assert.equal(tierSeeds.size, 4);
    assert.equal(ids.size, 1464);
    assert.equal(buildDailyChallengeUrl(blue, '/snowglider/index.html?debug=1#old'), `https://snowglider.ai/snowglider/index.html${base}`);
    assert.equal(buildDailyChallengeUrl(blue, 'http://localhost:8080/'), `http://localhost:8080/${base}`);
    for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/game.html', 'ftp://example.test/']) {
      assert.throws(() => buildDailyChallengeUrl(blue, href), TypeError);
    }

    // A stale or tampered storage/share object cannot have its identity silently
    // repaired by the builder, or become eligible by matching the live stamp.
    const alterations = {
      id: 'd1-v3-20765-blue', date: '2026-11-07', day: 20764,
      difficulty: 'black', physicsVersion: 3, challengeVersion: 2,
      seed: blue.seed + 1, nonce: 1, name: '<script>alert(1)</script>',
    };
    for (const [key, value] of Object.entries(alterations)) {
      const altered = { ...blue, [key]: value };
      assert.equal(isDailyChallenge(altered), false, key);
      assert.throws(() => buildDailyChallengeUrl(altered), TypeError, key);
      assert.equal(isDailyRunEligible(altered, {
        seed: altered.seed, practice: true, nonce: 0, physicsVersion: PHYSICS_VERSION,
      }, 'blue', 35), false, key);
    }
    for (const invalid of [null, undefined, [], {}, 1, 'blue', { date: '2026-02-30', difficulty: 'blue' }]) {
      assert.equal(isDailyChallenge(invalid), false);
    }

    // Deterministic bad-input fuzzing exercises URL decoding without depending on
    // the game's RNG. Neither malformed values nor Unicode normalize into a run.
    const alphabet = 'abcXYZ <>/%&=+-_.\u0000\uFFFD';
    let fuzzState = 0x531060d5;
    for (let i = 0; i < 300; i++) {
      let bad = '';
      for (let j = 0; j < i % 19 + 1; j++) {
        fuzzState = (fuzzState * 1664525 + 1013904223) >>> 0;
        bad += alphabet[fuzzState % alphabet.length];
      }
      const params = new URLSearchParams(base);
      params.set('daily', bad);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid');
      params.set('daily', blue.date);
      params.set('beat', bad);
      assert.equal(parseDailyChallenge(params.toString(), now).kind, 'invalid');
    }
    assert.deepEqual(getRunStamp(), originalStamp, 'core never mutates the live run singleton');
    assert.equal(globalDraws, 0, 'including import, create, parse, share and eligibility');
  } finally {
    Math.random = realRandom;
    for (const name of globals) {
      const descriptor = globalDescriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  console.log('Daily challenge: pinned seed, UTC identity, 4 tiers, strict/fuzzed links, version isolation, target bounds, clean URLs, eligibility and RNG/DOM/storage neutrality passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
