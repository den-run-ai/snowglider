import { buildDailyChallengeUrl, createDailyChallenge, parseDailyChallenge, utcDayString } from '../daily-challenge.js';
import { readDailyBest, type DailyBestResult } from '../daily-records.js';
import { getDifficultyConfig, type Difficulty } from '../difficulty.js';
import { getDailySelection } from '../daily-session.js';

/** Leave every invitation/seed override behind when returning to regular play. */
export function regularMountainUrl(href: string, tier: Difficulty): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('play', tier);
  return url.href;
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  return a;
}

/** Selecting a daily always loads its exact world before the next Start gesture. */
export function renderDailyMountainMenu(tier: Difficulty): void {
  const container = document.getElementById('dailyMountain');
  if (!container) return;
  const parsed = parseDailyChallenge(window.location.search);
  const today = utcDayString(new Date());
  const active = parsed.kind === 'daily' ? parsed.challenge : null;
  const date = active?.date ?? today;
  const challenge = createDailyChallenge(date, tier);
  const startMenu = document.getElementById('startMenu');
  document.getElementById('dailyMountainLink')?.remove();
  startMenu?.classList.toggle('has-daily-entry', parsed.kind === 'none');
  container.hidden = parsed.kind === 'none';
  if (parsed.kind === 'none') {
    // Ordinary welcome must keep Play, difficulty, sound and Help reachable on
    // short phones. Use its existing action row; the invitation has the details.
    const dailyLink = link('Daily mountain', buildDailyChallengeUrl(challenge, window.location.href));
    dailyLink.id = 'dailyMountainLink';
    dailyLink.setAttribute('aria-label', `Daily mountain: ${challenge.name}`);
    dailyLink.title = `Ride today’s mountain: ${challenge.name}`;
    dailyLink.addEventListener('click', () => {
      dailyLink.href = buildDailyChallengeUrl(createDailyChallenge(utcDayString(new Date()), tier), window.location.href);
    });
    startMenu?.append(dailyLink);
    container.replaceChildren();
    return;
  }
  const title = document.createElement('h2');
  title.textContent = active ? `🏔 ${challenge.name}` : '🏔 Daily mountain';
  const description = document.createElement('p');
  const actions = document.createElement('div');
  actions.className = 'daily-mountain-actions';
  if (parsed.kind === 'invalid' || parsed.kind === 'unsupported') {
    title.textContent = 'This challenge is unavailable';
    description.textContent = parsed.reason;
    actions.append(link('Ride today’s mountain', buildDailyChallengeUrl(createDailyChallenge(today, tier), window.location.href)));
  } else if (active) {
    description.textContent = `${date} · ${getDifficultyConfig(tier).label} · Same mountain every try.`;
    if (parsed.kind === 'daily' && parsed.targetMs !== null && tier === active.difficulty) {
      description.textContent += ` Friend’s shared target: ${(parsed.targetMs / 1000).toFixed(2)}s.`;
    }
    const best = readDailyBest(challenge);
    if (best !== null) description.textContent += ` Device best: ${(best / 1000).toFixed(2)}s.`;
    if (date !== today) actions.append(link('Today’s mountain', buildDailyChallengeUrl(createDailyChallenge(today, tier), window.location.href)));
  }
  actions.append(link('Regular mountain', regularMountainUrl(window.location.href, tier)));
  const note = document.createElement('small');
  note.textContent = 'Free to play · Daily bests stay on this device · New mountain at 00:00 UTC';
  container.replaceChildren(title, description, actions, note);
}

/** The target is a friendly invitation, never a verified leaderboard record. */
export function buildDailyResultSummary(time: number, result: DailyBestResult | null, finished: boolean): HTMLElement | null {
  const selection = getDailySelection();
  if (selection.kind !== 'daily') return null;
  const root = document.createElement('section');
  root.id = 'dailyRunResult';
  root.className = 'daily-mountain-result';
  const heading = document.createElement('h3');
  heading.textContent = `🏔 ${selection.challenge.name} · ${selection.challenge.date}`;
  const target = document.createElement('p');
  if (finished && result?.status !== 'ineligible' && selection.targetMs !== null) {
    const delta = Math.round(time * 1000) - selection.targetMs;
    target.textContent = delta < 0
      ? `${(-delta / 1000).toFixed(2)}s faster than your friend’s shared target!`
      : delta === 0 ? 'You matched your friend’s shared target!'
        : `${(delta / 1000).toFixed(2)}s to catch your friend’s shared target. Try another line!`;
  } else if (finished && result?.status === 'ineligible') {
    target.textContent = 'This attempt couldn’t be compared fairly. Restart for another try.';
  } else {
    target.textContent = 'Same mountain, same hazards. Find your line and go again.';
  }
  root.append(heading, target);
  return root;
}
