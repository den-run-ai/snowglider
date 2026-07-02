// sfx.ts — procedural Web Audio sound effects for SnowGlider (issue #158).
//
// Separate from audio.ts (which owns the single background-music track on a native
// HTML5 <audio> element). This module synthesises every effect at runtime from
// oscillators + filtered noise, so it ships ZERO binary assets and stays tiny:
//   - skiing dynamics .... a speed-scaled wind/whoosh bed + an edge swish on turns
//   - snowman actions .... jump whoosh, landing thump
//   - avalanche .......... a low rumble that crescendos as the slide closes in
//   - snowing / wind / nature  the always-on ambient wind bed (loud = fast or gusty, soft
//                              = idle on a calm slope; coupled to the shared Wind field),
//                              plus a resonant gust "howl" that whistles when the wind
//                              blows hard and sweeps its pitch with the gusts
//   - crashes / finish ... a wipeout whoomph and a success chime
//
// Why procedural (and not THREE.Audio / Howler / recorded clips)? The project's
// audio history (docs/CHANGELOG.md "Audio") is a graveyard of mobile failures with
// THREE.Audio and Howler on old engines. Effects need low-latency, overlapping,
// one-shot playback — exactly what raw Web Audio does well and HTML5 <audio> does
// badly. The modern AudioContext is well-behaved on current mobile *as long as it
// is created/resumed inside a user gesture*, which is why the public entry point is
// `unlock()`, called from the start-button handler (see snowglider.ts). iOS still
// routes Web Audio through the hardware silent switch — that caveat is documented
// in CLAUDE.md and shared with the background music.
//
// Design constraints, mirroring intro.ts / debris:
//   - **Automation-safe.** `unlock()` no-ops under ?test= browser suites
//     (window.isTestMode) and webdriver runs (Playwright/Puppeteer) unless the
//     dedicated test opts in via window.testHooks.sfxEnabled — so every existing
//     test keeps its current (music-only) audio path and stays byte-identical.
//   - **Headless-testable.** The gain-mapping math lives in exported pure functions
//     (windGainForSpeed, windGainForField, carveGainForTechnique, avalancheGainForDistance,
//     landGainForForce, howlGainForWind, howlFreqForGust) that need no AudioContext, so
//     they unit-test in Node.
//   - **Defensive.** Without a Web Audio implementation (jsdom/Node) every method is
//     an inert no-op; node creation is wrapped so a hostile environment can't throw
//     into the game loop.
//
// To disable entirely: set SFX_ENABLED = false (all methods early-exit).

const SFX_ENABLED = true;

// --- Tunable mapping constants -------------------------------------------------
// Speeds here are the planar speed the physics kernel reports (currentSpeed); ~18
// is "fast" (matches SPEED_REF in snowman-flex.ts), low double digits are cruising.
const SPEED_REF = 20;            // speed at which the wind term saturates
const WIND_BASE = 0.05;          // ambient wind floor while barely moving (nature bed)
const WIND_SPEED_GAIN = 0.40;    // extra wind at full speed
const WIND_FIELD_GAIN = 0.16;    // extra ambient bed at full Wind-field strength (#253 PR5)
const CARVE_SPEED_REF = 12;      // edge swish fades out below this speed
const AVAL_NEAR = 8;             // distance (world units) at which rumble is full
const AVAL_FAR = 80;             // distance beyond which the slide is inaudible
const AVAL_MAX_GAIN = 0.6;       // loudest the avalanche bed gets
const MASTER_GAIN = 0.85;        // overall SFX headroom (leaves room for the music)
const RAMP_TAU = 0.08;           // s; smoothing time-constant for continuous beds

// Wind "howl" (#253): a resonant whistle layered on the ambient bed that emerges only when
// the shared Wind field blows hard, and sweeps its pitch with each gust. Distinct from the
// broadband wind bed above — this is the tonal, high-Q resonance you hear in a strong wind.
// Keyed on Wind.strength() with a knee, so a light breeze / dead-calm field stays silent
// (the pre-#253 sound).
const HOWL_KNEE = 0.5;           // Wind.strength() at/below this = no whistle (a breeze doesn't howl)
const HOWL_MAX_GAIN = 0.11;      // loudest the whistle gets (sits under the wind bed + music)
const HOWL_Q = 8;                // bandpass resonance: narrow = tonal, whistling
const HOWL_FREQ_LO = 600;        // whistle pitch in a lull (Hz)
const HOWL_FREQ_HI = 1200;       // whistle pitch at a full gust (Hz)

/** Per-technique base loudness of the ski-edge swish (before the speed taper).
 *  A skidded parallel turn scrubs hardest; a committed carve hisses quieter; gliding
 *  straight is silent. (#191: the low-charge skidded turn now reports 'parallel', and
 *  the committed turn reports 'carve' — 'skid' is no longer emitted but kept as an
 *  alias for the scrub so any caller passing it still sounds right.) */
function techniqueEdge(technique: string): number {
  switch (technique) {
    case 'parallel': return 0.30; // skidded parallel scrubs hardest
    case 'skid': return 0.30;     // legacy alias for the scrub (no longer emitted)
    case 'snowplow': return 0.26;
    case 'carve': return 0.18;    // a committed carve hisses, quieter than a scrub
    default: return 0; // glide / tuck / air / hop — no sustained edge noise
  }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Motion-whoosh wind gain from the skier's own speed (0..~0.45): the air rushing past.
 *  This is the calm-field baseline — {@link windGainForField} reduces to exactly this when
 *  the wind is dead. Always at least WIND_BASE while a run is active so the slope never
 *  sounds dead; rises toward the top speed. */
export function windGainForSpeed(speed: number): number {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  return WIND_BASE + clamp01(s / SPEED_REF) * WIND_SPEED_GAIN;
}

/** Full wind-bed gain (0..~0.61): the motion whoosh PLUS the ambient environmental wind
 *  from the shared Wind field (issue #253, PR5). `windStrength` is Wind.strength() (0..1,
 *  the normalized field magnitude, which already swings with gusts). A windy slope lifts
 *  the bed's floor so it hisses even at a standstill and swells as gusts pass through.
 *  Deliberately keyed on strength and NOT the raw gust factor: gust keeps oscillating in a
 *  dead-calm field (baseStrength = gustRange = 0) whereas strength collapses to 0, so this
 *  reduces EXACTLY to windGainForSpeed(speed) when there is no wind (the pre-#253 sound). */
export function windGainForField(speed: number, windStrength: number): number {
  const st = clamp01(Number.isFinite(windStrength) ? windStrength : 0);
  return windGainForSpeed(speed) + st * WIND_FIELD_GAIN;
}

/** Ski-edge swish gain (0..~0.3). Gated by technique and tapered to silence as the
 *  snowman slows, so a parked snowman makes no scraping noise. */
export function carveGainForTechnique(technique: string, speed: number): number {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  return techniqueEdge(technique) * clamp01(s / CARVE_SPEED_REF);
}

/** Avalanche rumble gain (0..AVAL_MAX_GAIN). Silent when inactive; otherwise grows
 *  as the closest boulder closes the distance behind the player. */
export function avalancheGainForDistance(active: boolean, distance: number): number {
  if (!active) return 0;
  const d = Number.isFinite(distance) ? distance : AVAL_FAR;
  const t = clamp01((AVAL_FAR - d) / (AVAL_FAR - AVAL_NEAR));
  return t * AVAL_MAX_GAIN;
}

/** Landing-thump peak gain (0..~0.7) from airTime (seconds aloft). Returns 0 for
 *  trivial touchdowns so micro-bumps stay silent. */
export function landGainForForce(force: number): number {
  const f = Number.isFinite(force) ? force : 0;
  if (f < 0.12) return 0;
  return 0.18 + clamp01(f / 1.2) * 0.52;
}

/** Wind-howl whistle gain (0..HOWL_MAX_GAIN) from the shared field's normalized strength
 *  (Wind.strength(), 0..1). Silent at/below HOWL_KNEE so a light breeze doesn't whistle,
 *  then ramps up as the wind builds. Because strength already pulses with the gust cycle,
 *  the howl naturally swells and eases with the gusts. Keyed on strength (NOT the raw gust,
 *  which keeps oscillating in a dead-calm field) so strength 0 → exactly 0: an unwindy run
 *  has no whistle, matching the pre-#253 sound. NaN/negative-safe (treated as calm). */
export function howlGainForWind(windStrength: number): number {
  const st = clamp01(Number.isFinite(windStrength) ? windStrength : 0);
  if (st <= HOWL_KNEE) return 0;
  return ((st - HOWL_KNEE) / (1 - HOWL_KNEE)) * HOWL_MAX_GAIN;
}

/** Whistle centre-frequency (Hz) from the instantaneous gust factor (Wind.gust(), 0..1):
 *  the pitch rises on a gust and falls back in the lull, which is what makes it read as a
 *  wavering "howl" rather than a static tone. NaN/negative-safe (treated as a lull). */
export function howlFreqForGust(gust: number): number {
  const g = clamp01(Number.isFinite(gust) ? gust : 0);
  return HOWL_FREQ_LO + g * (HOWL_FREQ_HI - HOWL_FREQ_LO);
}

// --- Web Audio engine ----------------------------------------------------------
// Everything below is the live engine; it is entirely inert without an AudioContext.

interface NoiseBed {
  filter: BiquadFilterNode;
  gain: GainNode;
}

type WebAudioCtor = typeof AudioContext;

export const Sfx = (function() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let wind: NoiseBed | null = null;
  let carve: NoiseBed | null = null;
  let avalanche: NoiseBed | null = null;
  let howl: NoiseBed | null = null;
  let running = false;     // true between startRun/unlock and endRun (continuous bed live)
  let muted = false;
  let prefsLoaded = false;

  function getAudioCtor(): WebAudioCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: WebAudioCtor; webkitAudioContext?: WebAudioCtor };
    return w.AudioContext || w.webkitAudioContext || null;
  }

  function loadPreferences() {
    if (prefsLoaded) return;
    prefsLoaded = true;
    try {
      // Share the single mute preference with the background music (audio.ts).
      const stored = localStorage.getItem('snowgliderMuted');
      if (stored !== null) muted = stored === 'true';
    } catch { /* localStorage unavailable — keep default */ }
  }

  function automated(): boolean {
    if (typeof window === 'undefined') return true;
    return !!window.isTestMode ||
      (typeof navigator !== 'undefined' && !!navigator.webdriver);
  }

  function allowed(): boolean {
    if (!SFX_ENABLED) return false;
    if (typeof window === 'undefined') return false; // no DOM (Node) — stay inert
    // Mirror the debris / intro gate: off under automation unless explicitly opted in.
    if (automated() && !(window.testHooks && window.testHooks.sfxEnabled)) return false;
    return true;
  }

  function makeNoiseBuffer(context: AudioContext, seconds = 2): AudioBuffer {
    const len = Math.floor(context.sampleRate * seconds);
    const buf = context.createBuffer(1, len, context.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // A looping filtered-noise bed whose gain we modulate per frame. Started once at
  // unlock and left running (gain at 0 = silent), so there is no start/stop latency.
  function makeBed(context: AudioContext, buf: AudioBuffer, dest: AudioNode,
                   type: BiquadFilterType, freq: number, q: number): NoiseBed {
    const src = context.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start();
    return { filter, gain };
  }

  function buildGraph(context: AudioContext) {
    master = context.createGain();
    master.gain.value = muted ? 0 : MASTER_GAIN;
    master.connect(context.destination);

    noiseBuffer = makeNoiseBuffer(context);
    wind = makeBed(context, noiseBuffer, master, 'lowpass', 500, 0.7);
    carve = makeBed(context, noiseBuffer, master, 'bandpass', 2500, 0.8);
    avalanche = makeBed(context, noiseBuffer, master, 'lowpass', 110, 0.6);
    // The howl: a narrow, high-Q bandpass on the same noise → a tonal whistle whose gain
    // and pitch are driven per frame from the shared Wind field (see updateWindHowl).
    howl = makeBed(context, noiseBuffer, master, 'bandpass', HOWL_FREQ_LO, HOWL_Q);
  }

  function rampTo(param: AudioParam, value: number) {
    if (!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, RAMP_TAU);
  }

  // --- one-shot helpers --------------------------------------------------------
  function envelopedGain(peak: number, attack: number, decay: number): GainNode {
    const g = ctx!.createGain();
    const t = ctx!.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  function noiseBurst(type: BiquadFilterType, f0: number, f1: number,
                      peak: number, attack: number, decay: number, q: number) {
    if (!ctx || !master || !noiseBuffer) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t);
    filter.frequency.linearRampToValueAtTime(f1, t + attack + decay);
    const g = envelopedGain(peak, attack, decay);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);
  }

  function tone(type: OscillatorType, f0: number, f1: number,
                peak: number, attack: number, decay: number, when = 0) {
    if (!ctx || !master) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  return {
    isEnabled: () => SFX_ENABLED,

    // Create + resume the AudioContext and start the ambient bed. MUST be called from
    // a user-gesture handler (start/restart button) so mobile autoplay policy lets the
    // context run. Idempotent: builds the node graph once, then just resumes + ramps up.
    unlock: function() {
      if (!allowed()) return;
      loadPreferences();
      try {
        if (!ctx) {
          const Ctor = getAudioCtor();
          if (!Ctor) return;            // no Web Audio (Node/jsdom) — stay inert
          ctx = new Ctor();
          buildGraph(ctx);
        }
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        running = true;
        // Bring the ambient wind bed up to its idle floor.
        if (wind) rampTo(wind.gain.gain, windGainForSpeed(0));
      } catch (e) {
        console.warn('[Sfx] unlock failed:', (e as Error).message);
        ctx = null;
      }
    },

    // Per-frame continuous skiing bed: wind scales with the skier's speed AND the shared
    // Wind field (#253 PR5) so a gusty slope hisses even at a standstill; edge swish with
    // the active technique. No-op until unlocked. `isInAir` silences the ground edge.
    // `windStrength` is Wind.strength() (0..1); it defaults to 0 so direct callers and the
    // ?test= suites stay on the exact pre-#253 calm-field path.
    updateSkiing: function(speed: number, technique: string, isInAir: boolean, windStrength = 0) {
      if (!running || !ctx || muted) return;
      if (wind) {
        rampTo(wind.gain.gain, windGainForField(speed, windStrength));
        // A faster glide — or a stronger wind — brightens the wind (rising whoosh / whistle).
        rampTo(wind.filter.frequency, 300 + clamp01(speed / SPEED_REF) * 700 + clamp01(windStrength) * 180);
      }
      if (carve) {
        const g = isInAir ? 0 : carveGainForTechnique(technique, speed);
        rampTo(carve.gain.gain, g);
      }
    },

    // Per-frame avalanche rumble. Pass the same (active, closestDistance) the effects
    // banner uses. No-op until unlocked.
    setAvalanche: function(active: boolean, distance: number) {
      if (!running || !ctx || muted) return;
      if (avalanche) rampTo(avalanche.gain.gain, avalancheGainForDistance(active, distance));
    },

    // Per-frame wind "howl": a resonant whistle layered on the ambient bed, driven by the
    // shared Wind field (#253). `strength` (Wind.strength(), 0..1) sets how loud it howls —
    // silent on a calm slope, rising as the wind builds and swelling with each gust; `gust`
    // (Wind.gust(), 0..1) sweeps the whistle's pitch so it wavers like real wind. Reads the
    // field only (never pos/velocity) so it is invariant-safe; no-op until unlocked. Driven
    // from the render loop after Wind.update(), independent of the physics-step skiing bed.
    updateWindHowl: function(strength: number, gust: number) {
      if (!running || !ctx || muted || !howl) return;
      rampTo(howl.gain.gain, howlGainForWind(strength));
      rampTo(howl.filter.frequency, howlFreqForGust(gust));
    },

    // One-shot: snowman leaves the ground. A short upward-sweeping whoosh.
    jump: function() {
      if (!running || !ctx || muted) return;
      noiseBurst('bandpass', 600, 1900, 0.35, 0.02, 0.22, 1.2);
    },

    // One-shot: snowman touches down. A low thump + snow-compression puff scaled by
    // how long it was airborne (force). Trivial touchdowns are silent.
    // `quality` (JP-5, optional — absent/null keeps the legacy thump byte-identical,
    // which is what auto-jump/hop landings pass): a graded manual-jump landing layers
    // a grade cue on top — CLEAN gets a crisp rising stomp ping, SKETCHY a longer
    // skidding wash. 'wipeout' plays nothing extra here (endRun('crash') owns it).
    land: function(force: number, quality?: 'clean' | 'ok' | 'sketchy' | 'wipeout' | null) {
      if (!running || !ctx || muted) return;
      const peak = landGainForForce(force);
      if (peak <= 0) return;
      tone('sine', 120, 55, peak, 0.005, 0.18);
      noiseBurst('lowpass', 900, 400, peak * 0.6, 0.005, 0.14, 0.7);
      if (quality === 'clean') {
        tone('triangle', 880, 1318, peak * 0.22, 0.005, 0.12);
      } else if (quality === 'sketchy') {
        noiseBurst('bandpass', 520, 240, peak * 0.5, 0.01, 0.32, 0.9);
      }
    },

    // End of a run: silence the continuous beds and play the outcome cue. 'finish' is
    // a rising 3-note chime; 'crash' is a heavier wipeout whoomph (trees/rocks/fall/
    // avalanche burial all share it — the avalanche rumble already set the scene).
    endRun: function(outcome: 'finish' | 'crash') {
      if (!ctx) { running = false; return; }
      running = false;
      if (wind) rampTo(wind.gain.gain, 0);
      if (carve) rampTo(carve.gain.gain, 0);
      if (avalanche) rampTo(avalanche.gain.gain, 0);
      if (howl) rampTo(howl.gain.gain, 0);
      if (muted) return;
      if (outcome === 'finish') {
        // C5 – E5 – G5 arpeggio.
        tone('triangle', 523.25, 523.25, 0.3, 0.01, 0.30, 0.00);
        tone('triangle', 659.25, 659.25, 0.3, 0.01, 0.30, 0.12);
        tone('triangle', 783.99, 783.99, 0.3, 0.01, 0.40, 0.24);
      } else {
        tone('sine', 90, 40, 0.5, 0.005, 0.45);
        noiseBurst('lowpass', 1200, 200, 0.5, 0.005, 0.40, 0.5);
      }
    },

    // Mute/unmute (driven by the shared mute button via audio.ts). Silences the whole
    // SFX bus; continuous beds keep running underneath so unmute is instant.
    setMuted: function(value: boolean) {
      muted = value;
      if (master && ctx) master.gain.setTargetAtTime(value ? 0 : MASTER_GAIN, ctx.currentTime, 0.02);
    },

    isMuted: () => muted,

    // Stop every bed and CLOSE the AudioContext (dispose-audit teardown / dev-HMR). The
    // context + node graph are module-level and the wind/edge beds loop forever, so
    // without this they keep playing after disposeGame. close() releases the hardware
    // context; dropping the node handles lets a later unlock() rebuild the graph on a
    // fresh context. Idempotent and inert if never unlocked.
    teardown: function() {
      running = false;
      if (ctx) {
        // close() returns a Promise; swallow async rejection and any sync throw.
        try { ctx.close().catch(() => {}); } catch { /* already closed / unsupported */ }
        ctx = null;
      }
      master = null;
      wind = carve = avalanche = howl = null;
    },

    // For tests / diagnostics. `active` reflects whether the context is live.
    getStatus: function() {
      return {
        enabled: SFX_ENABLED,
        active: !!ctx,
        running,
        muted,
        contextState: ctx ? ctx.state : 'none'
      };
    }
  };
})();
