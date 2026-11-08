// One leaderboard view for the start menu and run results. Switching the viewed
// level never changes the level selected for the next run.
import { DIFFICULTIES, getDifficultyConfig, type Difficulty } from '../difficulty.js';
import { readLocalBest } from '../offline/offline-store.js';
import { isOnline } from '../offline/offline-state.js';
import type { LeaderboardScore } from '../scores.js';

export interface LeaderboardPanel {
  setTier(tier: Difficulty): void;
  refresh(): void;
  dispose(): void;
}

const panels = new WeakMap<HTMLElement, LeaderboardPanel>();

/** Reveal the existing account controls; the provider button owns its popup gesture. */
export function openScoreSignIn(): void {
  if (window.AuthModule?.openSignIn) {
    window.AuthModule.openSignIn();
    return;
  }
  const controls = document.getElementById('authUI');
  if (controls) controls.style.display = 'flex';
  const button = document.querySelector<HTMLButtonElement>('#loginBtn:not(:disabled), #githubLoginBtn:not(:disabled)');
  button?.scrollIntoView?.({ block: 'nearest' });
  button?.focus({ preventScroll: true });
}

/** Idempotently mount an independently selectable, stale-request-safe board. */
export function mountLeaderboardPanel(container: HTMLElement, initialTier: Difficulty): LeaderboardPanel {
  const existing = panels.get(container);
  if (existing && container.querySelector('.leaderboard-levels')) {
    existing.setTier(initialTier);
    return existing;
  }
  existing?.dispose();
  const doc = container.ownerDocument;
  let tier = initialTier;
  let epoch = 0;
  let disposed = false;
  const heading = doc.createElement('h3');
  heading.textContent = '🏆 Leaderboards';
  const help = doc.createElement('p');
  help.className = 'leaderboard-help';
  help.textContent = 'Fastest finishes. A separate top 10 for every level.';
  const tabs = doc.createElement('div');
  tabs.className = 'leaderboard-levels';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Leaderboard level');
  const best = doc.createElement('p');
  best.className = 'leaderboard-best';
  const body = doc.createElement('div');
  body.className = 'leaderboard-body';
  body.setAttribute('aria-live', 'polite');
  body.setAttribute('aria-atomic', 'true');
  const buttons = new Map<Difficulty, HTMLButtonElement>();
  for (const cfg of DIFFICULTIES) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.leaderboardTier = cfg.id;
    button.textContent = cfg.label;
    button.addEventListener('click', () => handle.setTier(cfg.id));
    tabs.appendChild(button);
    buttons.set(cfg.id, button);
  }
  container.classList.add('leaderboard-panel');
  container.replaceChildren(heading, help, tabs, best, body);
  container.style.display = 'block';

  function currentUid(): string | null {
    try {
      const user = window.AuthModule?.getCurrentUser?.() ?? window.AuthModule?.getAuthState?.().user;
      return user && !user.isAnonymous ? user.uid : null;
    } catch { return null; }
  }

  function message(text: string, action?: { label: string; run: () => void }): void {
    const paragraph = doc.createElement('p');
    paragraph.className = 'lb-empty';
    paragraph.textContent = text;
    body.replaceChildren(paragraph);
    if (action) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'leaderboard-action';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      body.appendChild(button);
    }
  }

  function renderRows(rows: LeaderboardScore[], uid: string): void {
    if (!rows.length) {
      message(`No ${getDifficultyConfig(tier).label} times yet. Set the first one!`);
      return;
    }
    const table = doc.createElement('table');
    const caption = doc.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = `${getDifficultyConfig(tier).label} fastest finishes`;
    table.appendChild(caption);
    const head = table.createTHead().insertRow();
    for (const label of ['#', 'Player', 'Time']) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      if (label === '#') th.setAttribute('aria-label', 'Rank');
      head.appendChild(th);
    }
    const tbody = table.createTBody();
    let myName: string | null = null;
    try {
      const user = window.AuthModule?.getCurrentUser?.() ?? window.AuthModule?.getAuthState?.().user;
      if (user?.uid === uid) myName = user.displayName;
    } catch { /* The denormalized public name remains available. */ }
    rows.slice(0, 10).forEach((entry, index) => {
      const row = tbody.insertRow();
      const isMe = entry.userId === uid;
      if (isMe) row.className = 'current-user-score';
      row.insertCell().textContent = String(index + 1);
      row.insertCell().textContent = isMe ? `${myName || entry.displayName || 'You'} (you)` : entry.displayName || 'Skier';
      row.insertCell().textContent = `${entry.time.toFixed(2)}s`;
    });
    body.replaceChildren(table);
  }

  function refresh(): void {
    if (disposed) return;
    const request = ++epoch;
    const requestedTier = tier;
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === tier));
    const local = readLocalBest(tier);
    best.textContent = local === null ? 'Device best: no finish yet' : `Device best: ${local.toFixed(2)}s`;
    const uid = currentUid();
    const accountBest = uid ? window.ScoresModule?.getLocalBestForUser?.(tier, uid) : null;
    if (typeof accountBest === 'number' && Number.isFinite(accountBest)) {
      best.textContent = `Account best: ${accountBest.toFixed(2)}s · ${best.textContent}`;
    }
    body.removeAttribute('aria-busy');
    if (!isOnline()) {
      message('You’re offline. Your device best is above. Connect to see the leaderboard.');
      return;
    }
    if (!uid) {
      message('Sign in to see the times and race for a place.', { label: 'Sign in or register', run: openScoreSignIn });
      return;
    }
    const scores = window.ScoresModule;
    if (!scores?.getLeaderboardResult && !scores?.getLeaderboard) {
      message('The leaderboard is unavailable right now.', { label: 'Retry', run: refresh });
      return;
    }
    message('Loading times…');
    body.setAttribute('aria-busy', 'true');
    // Resolve through a microtask so synchronous SDK errors take the same path.
    void Promise.resolve().then(async () => {
      if (scores.getLeaderboardResult) return scores.getLeaderboardResult(requestedTier);
      const rows = await scores.getLeaderboard!(requestedTier);
      return { status: 'ready' as const, scores: rows };
    }).then(result => {
      if (disposed || request !== epoch || !container.isConnected || currentUid() !== uid) return;
      body.removeAttribute('aria-busy');
      if (result.status === 'ready') renderRows(result.scores, uid);
      else if (result.status === 'offline') message('You’re offline. Connect to see the leaderboard.');
      else if (result.status === 'signed-out') message('Sign in to see the leaderboard.', { label: 'Sign in or register', run: openScoreSignIn });
      else message('Couldn’t load these times. Your finish is still available.', { label: 'Retry', run: refresh });
    }).catch(() => {
      if (disposed || request !== epoch || !container.isConnected || currentUid() !== uid) return;
      body.removeAttribute('aria-busy');
      message('Couldn’t load these times. Try again.', { label: 'Retry', run: refresh });
    });
  }

  const handle: LeaderboardPanel = {
    setTier(next) { tier = next; refresh(); },
    refresh,
    dispose() {
      disposed = true;
      epoch++;
      if (panels.get(container) === handle) panels.delete(container);
    },
  };
  panels.set(container, handle);
  refresh();
  return handle;
}
