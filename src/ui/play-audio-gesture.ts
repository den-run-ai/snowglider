// A document navigation cannot transfer browser user activation. After resuming a
// run on a new tier, retry sound once on the next actual gameplay gesture. Listen
// only on the slope (UI panels are siblings), without capturing or consuming input.
export function resumeAudioOnPlayGesture(surface: HTMLElement, options: {
  signal: AbortSignal;
  isPlaying: () => boolean;
  resume: () => void;
}): void {
  function resume(): void {
    if (options.signal.aborted || !options.isPlaying()) return;
    surface.removeEventListener('pointerup', resume);
    surface.removeEventListener('keydown', resume);
    options.resume();
  }
  surface.addEventListener('pointerup', resume, { signal: options.signal, passive: true });
  surface.addEventListener('keydown', resume, { signal: options.signal });
}
