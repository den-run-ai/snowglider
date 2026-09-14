// Assembles the README demo video from a deterministic capture (tools/record-
// deterministic.mjs). Picks the longest contiguous clean segment (loop alive +
// non-blank + non-frozen), encodes it at the capture fps with no interpolation,
// and muxes the game's music track. Run: node tools/build-demo-video.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const IN = process.env.IN || '/tmp/demo-final';
const OUT = process.env.OUT || '/tmp/snowglider_demo.mp4';
const FPS = Number(process.env.FPS || 30);
const MUSIC = process.env.MUSIC || path.resolve('assets/skullbeatz_bad_cat.mp3');
const MIN_BYTES = 30000; // below this a frame is a blank sky/solid color

// Static ffmpeg from the Python imageio-ffmpeg wheel (no system ffmpeg here).
const ff = process.env.FFMPEG ||
  execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();

function md5(file) {
  return execFileSync('md5sum', [file]).toString().split(' ')[0];
}

const ran = JSON.parse(fs.readFileSync(path.join(IN, 'ran.json'), 'utf8'));
const N = ran.length;
const sizes = [];
for (let i = 0; i < N; i++) {
  const f = path.join(IN, `f${String(i).padStart(5, '0')}.jpg`);
  sizes[i] = fs.statSync(f).size;
}

// Longest contiguous segment where the loop was alive (ran>0) and the frame is
// non-blank. (Restart boundaries have ran===0, so they split segments cleanly.)
let best = { s: 0, e: -1 };
let s = -1;
for (let i = 0; i <= N; i++) {
  const ok = i < N && ran[i] > 0 && sizes[i] >= MIN_BYTES;
  if (ok && s < 0) s = i;
  if (!ok && s >= 0) {
    if (i - s > best.e - best.s + 1) best = { s, e: i - 1 };
    s = -1;
  }
}
if (best.e < best.s) { console.error('No usable segment found'); process.exit(1); }

// Trim any frozen tail (frames identical to the last one) inside the segment.
let { s: S, e: E } = best;
const lastHash = md5(path.join(IN, `f${String(E).padStart(5, '0')}.jpg`));
let cut = E;
for (let i = E; i > S; i--) {
  if (md5(path.join(IN, `f${String(i).padStart(5, '0')}.jpg`)) !== lastHash) { cut = i; break; }
}
E = Math.min(E, cut + 1);
const count = E - S + 1;
console.log(`Longest clean segment: frames ${S}..${E} (${count} frames = ${(count / FPS).toFixed(1)}s)`);

// Stage the segment as a zero-based sequence so ffmpeg can read it with %05d.
const STAGE = path.join(IN, 'seg');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE);
for (let i = S, j = 0; i <= E; i++, j++) {
  fs.copyFileSync(path.join(IN, `f${String(i).padStart(5, '0')}.jpg`), path.join(STAGE, `s${String(j).padStart(5, '0')}.jpg`));
}

const dur = count / FPS;
const args = [
  '-y',
  '-framerate', String(FPS), '-i', path.join(STAGE, 's%05d.jpg'),
  '-stream_loop', '-1', '-i', MUSIC,
  '-map', '0:v', '-map', '1:a',
  '-t', String(dur),
  '-vf', 'format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '160k',
  '-af', `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, dur - 1).toFixed(2)}:d=1`,
  OUT,
];
execFileSync(ff, args, { stdio: 'inherit' });
const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
console.log(`Wrote ${OUT} (${dur.toFixed(1)}s, ${mb} MB)`);
