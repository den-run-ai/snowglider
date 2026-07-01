#!/usr/bin/env node
// deploy-firestore-rules.mjs
//
// Publish the repo's firestore.rules to the live Firebase project via the Firebase
// Rules REST API, authenticating with a service-account key.
//
// Why not `firebase-tools deploy --only firestore:rules`? firebase-tools' ADC /
// GOOGLE_APPLICATION_CREDENTIALS auth is unreliable on GitHub-hosted runners: it fails
// with a generic "Failed to authenticate, have you run firebase login?" even when the
// service-account credentials are valid (firebase-tools issue #10726). The exact same
// key + version authenticates fine locally, so the failure is CI-environment specific
// and not something we can fix from our side. This script sidesteps firebase-tools
// entirely: it mints a Google access token by signing a JWT with the SA private key
// (RS256) and exchanging it at oauth2.googleapis.com, then drives the Rules REST API
// directly. Pure Node built-ins (crypto / fetch) — zero dependencies, so the deploy job
// needs no `npm ci` or npx download.
//
// The service account needs only firebaserules.rulesets.create +
// firebaserules.releases.update (+ .get) — i.e. the "Firebase Rules Admin" role, the
// least-privilege role the CI deploy expects (do NOT reuse the broad Admin SDK key).
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT  (required) raw JSON of the service-account key
//   FIREBASE_RULES_FILE       (optional) path to the rules file (default: firestore.rules)
//   FIREBASE_PROJECT          (optional) project id (default: the SA key's project_id)
//   AUTH_CHECK_ONLY=1         (optional) mint token + read the live release, then exit
//                             without any write (non-destructive credential smoke test)
//   DRY_RUN=1                 (optional) create the ruleset but do NOT move the release
//                             (prod keeps serving the old ruleset)
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="$(cat sa.json)" node scripts/deploy-firestore-rules.mjs
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const RULES_FILE = process.env.FIREBASE_RULES_FILE || 'firestore.rules';
const RELEASE_NAME = 'cloud.firestore'; // the fixed release id Firestore reads its rules from
const DRY_RUN = process.env.DRY_RUN === '1';
const AUTH_CHECK_ONLY = process.env.AUTH_CHECK_ONLY === '1';

function die(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!saRaw) die('FIREBASE_SERVICE_ACCOUNT not set');
let sa;
try {
  sa = JSON.parse(saRaw);
} catch (e) {
  die(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${e.message}`);
}
if (sa.type !== 'service_account') die(`FIREBASE_SERVICE_ACCOUNT is not a service_account key (type=${sa.type})`);
for (const k of ['client_email', 'private_key', 'project_id']) {
  if (!sa[k]) die(`service-account key missing required field: ${k}`);
}
const project = process.env.FIREBASE_PROJECT || sa.project_id;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`token exchange failed (HTTP ${res.status}): ${body.error || ''} ${body.error_description || JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function api(token, method, path, payload) {
  const res = await fetch(`https://firebaserules.googleapis.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, json };
}

const token = await getAccessToken();
console.log(`Authenticated as ${sa.client_email} (project ${project})`);

// Read the currently-released ruleset first: it tells us whether to PATCH or create the
// release, and prints a before/after so the deploy is auditable in the CI log.
const before = await api(token, 'GET', `projects/${project}/releases/${RELEASE_NAME}`);
if (before.ok) {
  console.log(`Current release -> ${before.json.rulesetName}`);
} else if (before.status === 404) {
  console.log(`No existing '${RELEASE_NAME}' release yet (will create it).`);
} else {
  die(`GET release failed (HTTP ${before.status}): ${JSON.stringify(before.json)}`);
}

if (AUTH_CHECK_ONLY) {
  console.log('AUTH_CHECK_ONLY: token + read verified; exiting without any write.');
  process.exit(0);
}

// 1. Create an immutable ruleset from the local rules file.
const source = readFileSync(RULES_FILE, 'utf8');
const created = await api(token, 'POST', `projects/${project}/rulesets`, {
  source: { files: [{ name: RULES_FILE.split('/').pop(), content: source }] },
});
if (!created.ok) die(`create ruleset failed (HTTP ${created.status}): ${JSON.stringify(created.json)}`);
const rulesetName = created.json.name;
console.log(`Created ruleset ${rulesetName}`);

if (DRY_RUN) {
  console.log('DRY_RUN: created ruleset but did NOT move the release. Nothing is live yet.');
  process.exit(0);
}

// 2. Point the release at the new ruleset — this is the step that makes the rules live.
const relPath = `projects/${project}/releases/${RELEASE_NAME}`;
let rel;
if (before.status === 404) {
  rel = await api(token, 'POST', `projects/${project}/releases`, { name: relPath, rulesetName });
} else {
  rel = await api(token, 'PATCH', relPath, { release: { name: relPath, rulesetName } });
}
if (!rel.ok) die(`update release failed (HTTP ${rel.status}): ${JSON.stringify(rel.json)}`);
console.log(`Released ${rulesetName} to '${RELEASE_NAME}'. Firestore rules are now live.`);
