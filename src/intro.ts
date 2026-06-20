// intro.ts - Cinematic "fly over the mountain" introduction (issue #51).
//
// On the first game start the camera sweeps over the peak and up the course before
// settling into the gameplay chase pose, turning the previously blank "Loading…"
// pause into a short establishing shot of the mountain. It is purely a camera move:
// it runs no physics, the snowman stays at the start, and the run timer does not
// begin until the fly-over hands off to the game loop.
//
// Design constraints that shape this module:
//   - **Skippable.** A "Skip ▶" button plus a pointer/Escape/Enter listener jumps
//     straight to the gameplay pose, so returning players never wait.
//   - **Automation- and motion-safe.** The caller passes `skip: true` for the
//     `?test=` browser suites, automated runs (`navigator.webdriver`), and
//     `prefers-reduced-motion`, in which case the camera is placed at the final
//     pose synchronously and `onComplete` fires immediately — keeping every
//     existing test's timing byte-identical (see snowglider.ts).
//   - **Testable without a browser.** The path math is plain-number Catmull-Rom
//     (no three.js, no DOM), the camera is the minimal `IntroCamera` surface, and
//     the clock / animation-frame scheduler are injectable seams, so the whole
//     fly-over can be driven to completion deterministically in a Node unit test.
//
// Like effects.ts this module pokes a camera object handed to it rather than
// importing three.js, so it carries no `import * as THREE`. It is pulled into the
// bundle graph by src/main.ts and imported directly by snowglider.ts.

/** Plain 3-component vector. Accepts a real `THREE.Vector3` or a literal. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Minimal camera surface the fly-over drives. Satisfied by a real
 * `THREE.PerspectiveCamera` (the live game) and by the plain stub a headless test
 * hands in.
 */
export interface IntroCamera {
  position: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
}

/** One waypoint of the cinematic: where the camera is and what it frames. */
export interface IntroKeyframe {
  pos: Vec3Like;
  target: Vec3Like;
}

export interface IntroPlayOptions {
  /** Camera to drive (positioned + aimed each frame). */
  camera: IntroCamera;
  /** Final gameplay camera position; the fly-over eases into it. */
  endPosition: Vec3Like;
  /** Final gameplay look-at (≈ the snowman at the start gate). */
  endTarget: Vec3Like;
  /** Called exactly once when the fly-over finishes (or is skipped). */
  onComplete: () => void;
  /** Renders the scene for one fly-over frame (e.g. `renderer.render(scene, camera)`). */
  render?: () => void;
  /** Terrain sampler used to keep the camera a safe height above the slope. */
  getTerrainHeight?: (x: number, z: number) => number;
  /** Fly-over length in seconds (default {@link INTRO_DURATION}). */
  duration?: number;
  /** Override the cinematic path (tests); defaults to {@link buildDefaultKeyframes}. */
  keyframes?: IntroKeyframe[];
  /** Place the camera at the final pose and complete synchronously (no animation). */
  skip?: boolean;
  /** Clock seam — milliseconds. Default `performance.now`. */
  now?: () => number;
  /** Animation-frame scheduler seam. Default `requestAnimationFrame`. */
  raf?: (cb: (t: number) => void) => number;
  /** Animation-frame canceller seam. Default `cancelAnimationFrame`. */
  caf?: (id: number) => void;
  /** Show the in-DOM Skip button + skip listeners. Default: true when a DOM exists. */
  showSkipButton?: boolean;
  /** Minimum camera height above terrain during the sweep. Default 6. */
  minCameraClearance?: number;
}

/** Handle returned by {@link IntroModule.play}. */
export interface IntroHandle {
  /** Cut the fly-over short and jump to the gameplay pose. */
  skip(): void;
  /** True once the fly-over has finished (and `onComplete` has fired). */
  readonly done: boolean;
}

/** Default fly-over length, in seconds. */
export const INTRO_DURATION = 4.0;

const SKIP_BUTTON_ID = 'introSkipBtn';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smootherstep (Ken Perlin): ease-in/out with zero first AND second derivative at the ends. */
function smootherstep(p: number): number {
  const t = clamp01(p);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Uniform Catmull-Rom on a single axis. */
function catmullRom1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (p2 - p0) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (3 * p1 - 3 * p2 + p3 - p0) * t3
  );
}

/**
 * Sample a Catmull-Rom spline through every point in `points`, with `u` ∈ [0,1]
 * spanning the whole polyline. Endpoints are clamped (the first/last point is
 * reused as its own tangent neighbour) so the curve actually passes through them.
 */
export function sampleSpline(points: Vec3Like[], u: number): Vec3Like {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0, z: 0 };
  if (n === 1) return { x: points[0].x, y: points[0].y, z: points[0].z };

  const segs = n - 1;
  const scaled = clamp01(u) * segs;
  let i = Math.floor(scaled);
  if (i >= segs) i = segs - 1; // keep the last segment for u === 1
  const localT = scaled - i;

  const p0 = points[Math.max(i - 1, 0)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(i + 2, n - 1)];

  return {
    x: catmullRom1d(p0.x, p1.x, p2.x, p3.x, localT),
    y: catmullRom1d(p0.y, p1.y, p2.y, p3.y, localT),
    z: catmullRom1d(p0.z, p1.z, p2.z, p3.z, localT),
  };
}

/**
 * The default cinematic: a wide establishing shot of the peak from down-course,
 * tracking up the fall line and swinging back to centre to settle into the
 * gameplay chase pose (`endPosition`/`endTarget`). All but the final keyframe are
 * authored against the fixed course geometry (peak at the origin ~y=40, the run
 * descending along -z); the final keyframe is the live gameplay pose so the
 * hand-off to the game loop is seamless.
 */
export function buildDefaultKeyframes(endPosition: Vec3Like, endTarget: Vec3Like): IntroKeyframe[] {
  return [
    // Wide establishing shot: high and well down-course, the whole mountain in frame.
    { pos: { x: 0, y: 130, z: -130 }, target: { x: 0, y: 45, z: -20 } },
    // Crane down and swing out to the side for parallax over the upper slope.
    { pos: { x: 55, y: 95, z: -95 }, target: { x: 0, y: 35, z: -30 } },
    // Close in, swinging back toward centre and the start gate.
    { pos: { x: 38, y: 68, z: -68 }, target: { x: 0, y: 30, z: -25 } },
    // Settle into the live gameplay pose behind the snowman.
    { pos: { x: endPosition.x, y: endPosition.y, z: endPosition.z },
      target: { x: endTarget.x, y: endTarget.y, z: endTarget.z } },
  ];
}

/** Whether the current environment asks for reduced motion (browser-only; false elsewhere). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const IntroModule = (function () {
  function play(opts: IntroPlayOptions): IntroHandle {
    const {
      camera,
      endPosition,
      endTarget,
      onComplete,
      render,
      getTerrainHeight,
      duration = INTRO_DURATION,
      keyframes = buildDefaultKeyframes(endPosition, endTarget),
      now = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()),
      raf = (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : undefined),
      caf = (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : undefined),
      showSkipButton = typeof document !== 'undefined',
      minCameraClearance = 6,
    } = opts;

    const positions = keyframes.map((k) => k.pos);
    const targets = keyframes.map((k) => k.target);

    let finished = false;
    let rafId: number | null = null;
    let skipButton: HTMLButtonElement | null = null;
    let skipListener: ((e: Event) => void) | null = null;

    function aim(pos: Vec3Like, target: Vec3Like): void {
      let y = pos.y;
      if (getTerrainHeight) {
        const floor = getTerrainHeight(pos.x, pos.z) + minCameraClearance;
        if (y < floor) y = floor;
      }
      camera.position.set(pos.x, y, pos.z);
      camera.lookAt(target.x, target.y, target.z);
    }

    function teardownSkipUI(): void {
      if (skipButton && skipButton.parentNode) skipButton.parentNode.removeChild(skipButton);
      skipButton = null;
      if (skipListener && typeof document !== 'undefined') {
        document.removeEventListener('pointerdown', skipListener);
        document.removeEventListener('keydown', skipListener);
      }
      skipListener = null;
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      if (rafId !== null && caf) caf(rafId);
      rafId = null;
      teardownSkipUI();
      // Snap to the exact gameplay pose so the loop's first frame has nothing to correct.
      aim(endPosition, endTarget);
      onComplete();
    }

    function frame(): void {
      if (finished) return;
      const elapsed = (now() - startMs) / 1000;
      const p = clamp01(elapsed / duration);
      const e = smootherstep(p);
      aim(sampleSpline(positions, e), sampleSpline(targets, e));
      if (render) render();
      if (p >= 1) {
        finish();
      } else if (raf) {
        rafId = raf(frame);
      } else {
        // No scheduler available and not yet done: fail safe rather than hang.
        finish();
      }
    }

    const handle: IntroHandle = {
      skip: finish,
      get done() { return finished; },
    };

    // Instant path: tests, automation, reduced motion, or a degenerate duration.
    if (opts.skip || duration <= 0 || keyframes.length === 0) {
      finish();
      return handle;
    }

    // Skip affordance (button + global pointer/Escape/Enter), DOM permitting.
    if (showSkipButton && typeof document !== 'undefined') {
      skipButton = document.createElement('button');
      skipButton.id = SKIP_BUTTON_ID;
      skipButton.type = 'button';
      skipButton.textContent = 'Skip ▶';
      skipButton.style.position = 'fixed';
      skipButton.style.bottom = '24px';
      skipButton.style.right = '24px';
      skipButton.style.zIndex = '1200';
      skipButton.style.padding = '10px 18px';
      skipButton.style.border = 'none';
      skipButton.style.borderRadius = '8px';
      skipButton.style.backgroundColor = 'rgba(0, 0, 0, 0.55)';
      skipButton.style.color = 'white';
      skipButton.style.fontFamily = 'Arial, sans-serif';
      skipButton.style.fontSize = '16px';
      skipButton.style.cursor = 'pointer';
      skipButton.style.setProperty('-webkit-tap-highlight-color', 'rgba(255, 255, 255, 0.5)');
      skipButton.style.touchAction = 'manipulation';
      skipButton.style.userSelect = 'none';
      document.body.appendChild(skipButton);

      skipListener = function (e: Event) {
        // Only Escape/Enter on the keyboard skip — movement keys (arrows/WASD/Space/V)
        // must reach the controls layer untouched, never the intro.
        if (e.type === 'keydown') {
          const key = (e as KeyboardEvent).key;
          if (key !== 'Escape' && key !== 'Enter') return;
        }
        handle.skip();
      };
      document.addEventListener('pointerdown', skipListener);
      document.addEventListener('keydown', skipListener);
    }

    const startMs = now();
    if (raf) {
      rafId = raf(frame);
    } else {
      // No animation-frame scheduler (e.g. a non-injected Node path): place the
      // camera at the end and complete rather than spin.
      finish();
    }
    return handle;
  }

  return { play };
})();
