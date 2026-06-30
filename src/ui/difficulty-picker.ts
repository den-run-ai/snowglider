// difficulty-picker.ts — the shared difficulty-tier radiogroup widget.
//
// Both the start screen (src/ui/start-menu.ts) and the finish/game-over overlay
// (src/snowglider.ts) need the same ●Bunny / ■Blue / ◆Black picker: same DOM, same
// ARIA radiogroup semantics, same roving-tabindex keyboard handling, same per-tier
// colors. This factory is the single source for that widget so the two call sites can
// never drift. It reads the tier list/labels/blurbs from difficulty.ts (the config
// spine) and is THREE-free + dependency-light, so it loads headless under the tests.
//
// The factory only builds the DOM and reports selection changes; persistence
// (localStorage) and side effects (leaderboard refresh, game state) belong to the
// caller's `onChange`, since the two screens persist/react differently.
import { DIFFICULTIES, type Difficulty } from '../difficulty.js';

export interface DifficultyPickerHandle {
  /** The currently-selected tier. */
  getSelected(): Difficulty;
  /** Programmatically reflect a tier (highlight + ARIA + roving tabindex) WITHOUT
   *  firing onChange — onChange is reserved for user gestures (click / arrow keys). */
  setSelected(id: Difficulty): void;
}

export interface DifficultyPickerOptions {
  /** The tier to pre-select when the picker is (re)built. */
  initial: Difficulty;
  /** Fired on a user selection (click or arrow-key move), never on build/setSelected. */
  onChange?: (id: Difficulty) => void;
  /** Heading text above the options (e.g. "Difficulty" or "Play again on"). */
  heading?: string;
}

/**
 * Build (or rebuild) the difficulty picker inside `container`, replacing any prior
 * contents. `container` should carry `role="radiogroup"`; each tier becomes a
 * `role="radio"` button. Returns a handle to read/set the selection.
 *
 * Keyboard: ArrowDown/ArrowRight select the next tier, ArrowUp/ArrowLeft the previous
 * (wrapping), then focus it — standard radiogroup behaviour with a roving tabindex so
 * only the selected option is in the tab order.
 */
export function buildDifficultyPicker(
  container: HTMLElement,
  options: DifficultyPickerOptions
): DifficultyPickerHandle {
  const { onChange, heading = 'Difficulty' } = options;
  const ids = DIFFICULTIES.map((c) => c.id);
  let selected: Difficulty = isKnown(options.initial) ? options.initial : (ids[0] as Difficulty);

  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'difficulty-heading';
  head.textContent = heading;
  container.appendChild(head);

  // Reflect `selected` onto the option buttons (highlight + ARIA + roving tabindex).
  function apply() {
    container.querySelectorAll('.difficulty-option').forEach((el) => {
      const isSel = el.getAttribute('data-difficulty') === selected;
      el.classList.toggle('selected', isSel);
      el.setAttribute('aria-checked', isSel ? 'true' : 'false');
      el.setAttribute('tabindex', isSel ? '0' : '-1');
    });
  }

  function isKnown(value: unknown): value is Difficulty {
    return typeof value === 'string' && ids.indexOf(value as Difficulty) !== -1;
  }

  function select(id: Difficulty, focus: boolean) {
    if (!isKnown(id)) return;
    selected = id;
    apply();
    if (onChange) onChange(selected);
    if (focus) {
      const el = container.querySelector('[data-difficulty="' + selected + '"]');
      if (el && typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
    }
  }

  function move(delta: number) {
    const cur = ids.indexOf(selected);
    const nextId = ids[(cur + delta + ids.length) % ids.length];
    if (nextId) select(nextId, true);
  }

  DIFFICULTIES.forEach((cfg) => {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'difficulty-option';
    opt.setAttribute('role', 'radio');
    opt.setAttribute('data-difficulty', cfg.id);

    const name = document.createElement('span');
    name.className = 'difficulty-name';
    name.textContent = cfg.label;
    const blurb = document.createElement('span');
    blurb.className = 'difficulty-blurb';
    blurb.textContent = cfg.blurb;
    opt.appendChild(name);
    opt.appendChild(blurb);

    opt.addEventListener('click', function () {
      select(cfg.id, false);
    });
    opt.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        move(-1);
      }
    });
    container.appendChild(opt);
  });

  apply();

  return {
    getSelected: () => selected,
    setSelected: (id: Difficulty) => {
      if (!isKnown(id)) return;
      selected = id;
      apply();
    },
  };
}
