#!/usr/bin/env node
// purge-implausible-scores.mjs
//
// One-time admin migration for issue #229 (PR C): remove leaderboard entries and user
// best times that sit BELOW the plausibility floor (MIN_VALID_SCORE_TIME in
// src/score-limits.ts). The shipped engine cannot produce a sub-floor time (measured by
// tests/verification/plausibility_floor_harness.js), so any such record is forged. Client
// deletes are forbidden by firestore.rules (`allow delete: if false`), so this must run
// with elevated Admin SDK credentials.
//
// The floor is parsed from src/score-limits.ts (the single source of truth) — never
// hard-coded here — so this script always purges to whatever the shipped floor is.
//
// SAFETY: dry-run by default. It only mutates Firestore when invoked with --apply.
//
// Deploy ordering (see PR C plan): deploy the new firestore.rules FIRST (so no client can
// re-write a sub-floor value mid-purge), THEN run this with --apply, THEN ship the client
// with the raised constant.
//
// Usage:
//   # Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON, or run in a
//   # Google environment with application-default credentials. Optionally set
//   # FIREBASE_PROJECT_ID / GCLOUD_PROJECT to pin the project.
//   npm i firebase-admin           # if not already available
//   node scripts/purge-implausible-scores.mjs            # dry run: lists what would change
//   node scripts/purge-implausible-scores.mjs --apply    # performs the deletes + repairs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

// --- Read the floor from the single source of truth (no hard-coded literal). ----------
function readFloor() {
  const src = readFileSync(join(__dirname, '..', 'src', 'score-limits.ts'), 'utf8');
  const m = src.match(/MIN_VALID_SCORE_TIME\s*=\s*([\d.]+)/);
  if (!m) throw new Error('Could not parse MIN_VALID_SCORE_TIME from src/score-limits.ts');
  return Number(m[1]);
}

async function main() {
  const FLOOR = readFloor();
  console.log(`Plausibility floor (MIN_VALID_SCORE_TIME) = ${FLOOR} s`);
  console.log(APPLY ? 'MODE: --apply (live; will mutate Firestore)\n' : 'MODE: dry-run (no writes; pass --apply to perform changes)\n');

  let admin;
  try {
    admin = (await import('firebase-admin')).default;
  } catch {
    console.error('firebase-admin is not installed. Run `npm i firebase-admin` first (it is intentionally not an app dependency).');
    process.exit(2);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || undefined;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(projectId ? { projectId } : {})
  });
  const db = admin.firestore();

  // --- 1. Purge sub-floor leaderboard entries, collecting affected users. --------------
  const affectedUsers = new Set();
  let deleted = 0;
  const lbSnap = await db.collection('leaderboard').get();
  console.log(`Scanning ${lbSnap.size} leaderboard entries...`);
  for (const docSnap of lbSnap.docs) {
    const time = docSnap.get('time');
    if (typeof time === 'number' && time < FLOOR) {
      console.log(`  [leaderboard/${docSnap.id}] time=${time} < ${FLOOR} -> DELETE`);
      affectedUsers.add(docSnap.id);
      deleted++;
      if (APPLY) await docSnap.ref.delete();
    }
  }

  // --- 2. Repair user best times that are themselves sub-floor (the bogus best). --------
  // The leaderboard doc id is the uid, so the affected users are exactly those we purged;
  // also sweep every users/{uid} whose stored bestTime is sub-floor, in case a user doc
  // holds a forged best with no matching leaderboard row.
  let repaired = 0;
  const userSnap = await db.collection('users').get();
  console.log(`\nScanning ${userSnap.size} user docs for sub-floor best times...`);
  for (const docSnap of userSnap.docs) {
    const bestTime = docSnap.get('bestTime');
    if (typeof bestTime === 'number' && bestTime < FLOOR) {
      console.log(`  [users/${docSnap.id}] bestTime=${bestTime} < ${FLOOR} -> CLEAR bestTime`);
      affectedUsers.add(docSnap.id);
      repaired++;
      if (APPLY) {
        await docSnap.ref.update({
          bestTime: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
  }

  console.log(`\nSummary: ${deleted} leaderboard entr${deleted === 1 ? 'y' : 'ies'} ${APPLY ? 'deleted' : 'would be deleted'}, ` +
    `${repaired} user best time${repaired === 1 ? '' : 's'} ${APPLY ? 'cleared' : 'would be cleared'}; ` +
    `${affectedUsers.size} user(s) affected.`);
  if (!APPLY) console.log('Dry run only — re-run with --apply to perform these changes.');
  process.exit(0);
}

main().catch((e) => { console.error('purge failed:', e); process.exit(1); });
