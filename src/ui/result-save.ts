// A finished run survives sign-in without being attributed to another player.
// Only the explicit sign-in-and-save action claims an unsigned/guest run.
import { getDifficultyConfig, type Difficulty } from '../difficulty.js';
import { isOnline } from '../offline/offline-state.js';
import { readLocalBest } from '../offline/offline-store.js';
import type { ScoreSaveResult } from '../scores.js';
import { openScoreSignIn } from './leaderboard-panel.js';

export interface ResultSaveControls {
  element: HTMLElement;
  dispose(): void;
}

export function createResultSaveControls(options: {
  time: number;
  tier: Difficulty;
  initialSave: Promise<ScoreSaveResult> | void;
  onSaved?: () => void;
}): ResultSaveControls {
  const root = document.createElement('section');
  root.id = 'saveScoreActions';
  root.setAttribute('aria-label', 'Save this run');
  const button = document.createElement('button');
  button.id = 'saveScoreButton';
  button.type = 'button';
  const status = document.createElement('p');
  status.id = 'saveScoreStatus';
  status.setAttribute('role', 'status');
  button.setAttribute('aria-describedby', status.id);
  root.append(button, status);

  let disposed = false;
  let request = 0;
  let saving = false;
  let requestedSignIn = false;
  let result: ScoreSaveResult | null = null;
  let owner = activeUid();
  const label = getDifficultyConfig(options.tier).label;

  function activeUid(): string | null {
    try {
      const user = window.AuthModule?.getCurrentUser?.() ?? window.AuthModule?.getAuthState?.().user;
      return user && !user.isAnonymous ? user.uid : null;
    } catch { return null; }
  }

  function render(): void {
    if (disposed) return;
    const uid = activeUid();
    const local = result?.localSaved ?? (readLocalBest(options.tier) !== null);
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (owner && uid && owner !== uid) {
      button.textContent = 'Use the original account';
      button.disabled = true;
      status.textContent = 'This run belongs to the player who started saving it. Sign back in to that account to retry.';
    } else if (saving) {
      button.textContent = 'Saving…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      status.textContent = local ? 'Device best saved. Waiting for the leaderboard to confirm.' : 'Waiting for the leaderboard to confirm. You can still play again.';
    } else if (result?.status === 'saved' && uid === result.userId) {
      button.textContent = 'Saved to leaderboard ✓';
      button.disabled = true;
      status.textContent = `Your best ${label} time is saved to your account.`;
    } else if (!uid) {
      button.textContent = 'Sign in & save this run';
      if (!isOnline()) {
        button.disabled = true;
        status.textContent = local ? 'Device best saved. Connect to sign in and save this run to your account.' : 'Connect to sign in. Keep this result open to save it.';
      } else {
        status.textContent = local ? 'Device best saved. Google or GitHub signs you in or creates your account.' : 'Google or GitHub signs you in or creates your account. Keep this result open to save it.';
      }
    } else if (!isOnline() || result?.status === 'queued') {
      button.textContent = isOnline() ? 'Retry save' : 'Waiting for connection';
      button.disabled = !isOnline();
      status.textContent = result?.status === 'queued' ? 'Queued for this account. Your best time will sync when connected.' : 'You’re offline. Connect to save to the leaderboard.';
    } else {
      button.textContent = result?.status === 'unavailable' ? 'Retry save' : 'Save to leaderboard';
      status.textContent = result?.status === 'unavailable'
        ? 'Couldn’t confirm the save. Try again; Play again still works.'
        : local ? `Device best saved. Add this ${label} finish to your account.` : 'This finish is ready to save. Browser storage is unavailable.';
    }
  }

  function observeSave(promise: Promise<ScoreSaveResult>): void {
    const seq = ++request;
    saving = true;
    render();
    void promise.then(value => {
      if (disposed || seq !== request) return;
      result = value;
      saving = false;
      render();
      if (value.status === 'saved' && value.userId === activeUid()) options.onSaved?.();
      if (requestedSignIn && activeUid() && (!owner || owner === activeUid())) save();
    }).catch(() => {
      if (disposed || seq !== request) return;
      saving = false;
      result = { status: 'unavailable', localSaved: readLocalBest(options.tier) !== null };
      render();
    });
  }

  function save(): void {
    if (disposed || saving) return;
    const uid = activeUid();
    if (!uid) {
      requestedSignIn = true;
      openScoreSignIn();
      return;
    }
    if (owner && owner !== uid) { render(); return; }
    const scores = window.ScoresModule;
    if (!scores?.saveScore) {
      result = { status: 'unavailable', localSaved: readLocalBest(options.tier) !== null };
      render();
      return;
    }
    owner = uid;
    requestedSignIn = false;
    // Capture the owner before scheduling SDK work. Never retry via recordScore:
    // that would count the same completed run again in analytics.
    observeSave(Promise.resolve().then(() => {
      if (disposed || activeUid() !== owner) return { status: 'unavailable', localSaved: false };
      return scores.saveScore!(options.time, options.tier);
    }));
  }

  function authChanged(): void {
    if (disposed) return;
    // An old account's async completion cannot label another account's run saved.
    if (owner && activeUid() !== owner) { request++; saving = false; }
    render();
    if (requestedSignIn && activeUid() && (!owner || owner === activeUid())) save();
  }
  const connectivityChanged = () => render();
  const scoreSynced = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: unknown; tier?: unknown; time?: unknown }>).detail;
    if (disposed || !owner || detail?.userId !== owner || activeUid() !== owner
      || detail.tier !== options.tier || typeof detail.time !== 'number' || !Number.isFinite(detail.time)
      || detail.time > options.time) return;
    request++;
    saving = false;
    result = { status: 'saved', localSaved: readLocalBest(options.tier) !== null, userId: owner };
    render();
    options.onSaved?.();
  };
  button.addEventListener('click', save);
  window.addEventListener('snowglider:auth-changed', authChanged);
  window.addEventListener('online', connectivityChanged);
  window.addEventListener('offline', connectivityChanged);
  window.addEventListener('snowglider:score-synced', scoreSynced);
  if (options.initialSave) observeSave(options.initialSave);
  else render();

  return {
    element: root,
    dispose() {
      disposed = true;
      request++;
      button.removeEventListener('click', save);
      window.removeEventListener('snowglider:auth-changed', authChanged);
      window.removeEventListener('online', connectivityChanged);
      window.removeEventListener('offline', connectivityChanged);
      window.removeEventListener('snowglider:score-synced', scoreSynced);
    },
  };
}
