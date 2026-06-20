// audio-asset-tests.js
// Deterministic, dependency-free guard that the background-music asset wired into
// src/audio.ts actually ships and is a decodable audio file. This is the headless
// half of "is decoding/playing OK?": Node can't open an audio device or run the
// browser media pipeline, but it CAN prove (a) the file AUDIO_PATH points at
// exists, (b) it is real bytes (not an empty file or a ~130-byte Git-LFS pointer
// stub), and (c) it carries a valid MP3 header — the same magic bytes a browser
// decoder keys off. Actual audio output stays a manual/browser check
// (tests/audio-tests.js exercises the AudioModule API surface in a real browser).
// Run via the `test:audio-asset` npm script (`node tests/audio-asset-tests.js`).

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'PASS ✅' : 'FAIL ❌'}: ${name}`);
  if (condition) pass++; else fail++;
}

const repoRoot = path.resolve(__dirname, '..');

// AUDIO_PATH is the single source of truth in src/audio.ts; parse it straight from
// source so this test breaks the moment the wired path and the shipped asset diverge.
const audioSrc = fs.readFileSync(path.join(repoRoot, 'src/audio.ts'), 'utf8');
const match = audioSrc.match(/const AUDIO_PATH\s*=\s*['"]([^'"]+)['"]/);
check('src/audio.ts declares an AUDIO_PATH constant', !!match);

if (match) {
  const audioPath = match[1];
  console.log(`  AUDIO_PATH = ${audioPath}`);
  const abs = path.join(repoRoot, audioPath);

  const exists = fs.existsSync(abs);
  check(`referenced asset exists on disk (${audioPath})`, exists);

  if (exists) {
    const buf = fs.readFileSync(abs);

    // A real track is megabytes; an empty file or a ~130-byte Git-LFS pointer is not.
    check('asset is non-trivially sized (> 64 KB of real audio)', buf.length > 64 * 1024);

    // Git-LFS pointer files are small UTF-8 text starting with this header line.
    const head = buf.slice(0, 64).toString('utf8');
    check('asset is real bytes, not a Git-LFS pointer stub',
      !head.startsWith('version https://git-lfs'));

    // Decoder-recognisable MP3: either an ID3v2 tag ("ID3") or a raw MPEG audio
    // frame sync (11 set bits: 0xFF then the top 3 bits of the next byte).
    const isID3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // "ID3"
    const isFrameSync = buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
    check('asset carries a valid MP3 header (ID3 tag or MPEG frame sync)', isID3 || isFrameSync);

    // The extension must match the bytes so the browser selects the right decoder;
    // new Audio(AUDIO_PATH) relies on the server MIME / file extension.
    check('asset uses the .mp3 extension expected by the audio/mpeg decoder',
      path.extname(audioPath).toLowerCase() === '.mp3');
  }
}

console.log(`\nAUDIO ASSET TOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
