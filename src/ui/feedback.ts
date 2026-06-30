// ui/feedback.ts - In-game feature-request / bug-report entry point (issue #258).
//
// Lets a player file feedback without leaving the game. Two integrations, both
// keyless and safe to ship inside a static GitHub-Pages client:
//
//   1. GitHub - we never hold a write token in the browser (embedding one would
//      leak it to every visitor). Instead "Submit" opens GitHub's *prefilled*
//      new-issue form (title / body / labels filled from the player's input plus
//      optional runtime context). The player previews it and submits on
//      github.com under their OWN account. No server, no Cloud Function, no
//      secret in the bundle.
//   2. Firebase Analytics - we fire a `feedback_submitted` event through the
//      existing `window.firebaseModules.logEvent` seam (wired in auth.ts, the
//      same path `share_result` / `complete_run` use) so we get aggregate
//      feedback-engagement metrics. It carries only the category string - never
//      the message text or any PII - and no-ops when Analytics is unavailable
//      (local / offline / tests).
//
// The pure helpers (buildFeedbackIssueUrl / buildIssueBody / collectContext /
// truncate / isFeedbackCategory / logFeedbackEvent) hold no DOM or Firebase
// state, so tests/feedback-tests.js imports the real `.ts` and exercises them
// headlessly. The DOM builder is modelled on ui/share-menu.ts.

const REPO_SLUG = 'den-run-ai/snowglider';

/** Shared label so all in-game feedback is findable on the Issues tab. */
export const FEEDBACK_LABEL = 'game-feedback';

export type FeedbackCategory = 'feature' | 'bug' | 'general';

interface CategoryMeta {
  /** Human label shown in the modal's category picker. */
  label: string;
  /** Prefix prepended to the issue title. */
  titlePrefix: string;
  /** Labels applied to the prefilled GitHub issue. */
  issueLabels: string[];
}

// Order here drives the radio order in the modal; `feature` is the default.
export const FEEDBACK_CATEGORIES: Record<FeedbackCategory, CategoryMeta> = {
  feature: { label: '✨ Feature request', titlePrefix: '[Feature] ', issueLabels: ['enhancement', FEEDBACK_LABEL] },
  bug:     { label: '🐞 Bug report',      titlePrefix: '[Bug] ',     issueLabels: ['bug', FEEDBACK_LABEL] },
  general: { label: '💬 General feedback', titlePrefix: '[Feedback] ', issueLabels: [FEEDBACK_LABEL] },
};

const DEFAULT_CATEGORY: FeedbackCategory = 'feature';

// Keep the prefilled URL comfortably under real-world browser/address-bar caps
// (~8 k for the whole URL). The diagnostics dump is the only thing that can grow
// large, so the body is bounded too.
const MAX_MESSAGE = 4000;
const MAX_BODY = 6000;

/** Narrowing guard for an untrusted category string (e.g. a radio value). */
export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return value === 'feature' || value === 'bug' || value === 'general';
}

/** Hard length cap with an ellipsis marker, so a long message can't blow the URL. */
export function truncate(text: string, max = MAX_MESSAGE): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

/** First non-empty line of the message, used for the issue title. */
function firstLine(message: string): string {
  const line = message.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  return truncate(line, 80);
}

/** Optional runtime context appended to the issue body. Every field is best-effort. */
export interface FeedbackContext {
  build?: string;
  url?: string;
  userAgent?: string;
  viewport?: string;
  diagnostics?: string;
}

/**
 * Gather best-effort runtime context for the issue body, ONLY when
 * `includeDiagnostics` is true (the modal's opt-in checkbox). It then collects
 * build id, URL, viewport, user-agent, and — if available — the
 * `window.__snowgliderDiag.snapshot()` physics trace. With the box unchecked it
 * returns an empty object so an ordinary submission carries only the player's
 * message. Every access is guarded so this is inert under SSR / Node / tests.
 */
export function collectContext(includeDiagnostics: boolean): FeedbackContext {
  const ctx: FeedbackContext = {};
  // ALL of the following is device/page context gated behind the opt-in checkbox
  // ("Include diagnostics (build, device, physics trace)"). With the box unchecked
  // we attach nothing, so an ordinary submission never leaks the URL (which can
  // carry query-string state), the viewport, or the user-agent — only the player's
  // own message goes into the issue.
  if (!includeDiagnostics) return ctx;
  if (typeof document !== 'undefined' && document.querySelector) {
    const meta = document.querySelector('meta[name="build-id"]');
    const content = meta && 'content' in meta ? (meta as HTMLMetaElement).content : '';
    if (content) ctx.build = content;
  }
  if (typeof window !== 'undefined') {
    try {
      if (window.location && window.location.href) ctx.url = window.location.href;
      if (typeof window.innerWidth === 'number' && typeof window.innerHeight === 'number') {
        ctx.viewport = `${window.innerWidth}x${window.innerHeight}`;
      }
    } catch { /* defensive: jsdom/odd hosts */ }
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    ctx.userAgent = navigator.userAgent;
  }
  // Use snapshot(), NOT dump(): both return the same trace, but dump() also
  // downloads a snowglider-diag-*.json file as a side effect — we only want the
  // data to embed in the issue body, not a surprise download on every submit.
  if (typeof window !== 'undefined' && window.__snowgliderDiag &&
      typeof window.__snowgliderDiag.snapshot === 'function') {
    try {
      const snap = window.__snowgliderDiag.snapshot();
      ctx.diagnostics = truncate(JSON.stringify(snap), 3000);
    } catch { /* diagnostics are opt-in and best-effort */ }
  }
  return ctx;
}

/** Render the context map as a fenced details block (omitted entirely if empty). */
function renderContext(ctx: FeedbackContext): string {
  const rows: string[] = [];
  if (ctx.build) rows.push(`- Build: \`${ctx.build}\``);
  if (ctx.url) rows.push(`- URL: ${ctx.url}`);
  if (ctx.viewport) rows.push(`- Viewport: ${ctx.viewport}`);
  if (ctx.userAgent) rows.push(`- User agent: \`${ctx.userAgent}\``);
  let block = rows.length ? rows.join('\n') : '';
  if (ctx.diagnostics) {
    block += `\n\n<details><summary>Diagnostics trace</summary>\n\n\`\`\`json\n${ctx.diagnostics}\n\`\`\`\n\n</details>`;
  }
  return block;
}

export interface BuildIssueOptions {
  category: FeedbackCategory;
  message: string;
  context?: FeedbackContext;
}

/** Compose the Markdown issue body from the player's message + optional context. */
export function buildIssueBody(opts: BuildIssueOptions): string {
  const message = truncate((opts.message || '').trim());
  const ctx = opts.context ? renderContext(opts.context) : '';
  const parts = [
    message || '_(no description provided)_',
  ];
  if (ctx) {
    parts.push('\n---\n\n### Context\n' + ctx);
  }
  parts.push('\n\n> Submitted from the in-game feedback form.');
  return truncate(parts.join('\n'), MAX_BODY);
}

/**
 * Build the GitHub prefilled new-issue URL. The player opens this, reviews the
 * filled form on github.com, and submits under their own account - no token
 * ever touches the client.
 */
export function buildFeedbackIssueUrl(opts: BuildIssueOptions): string {
  const cat = isFeedbackCategory(opts.category) ? opts.category : DEFAULT_CATEGORY;
  const meta = FEEDBACK_CATEGORIES[cat];
  const title = meta.titlePrefix + (firstLine(opts.message || '') || 'feedback');
  // NB: deliberately NO `labels=` param. GitHub's /issues/new `labels` query
  // parameter requires permission to add labels and returns a 404 (instead of the
  // prefilled form) for users who lack it. This form is for ordinary players
  // submitting under their own accounts, so labels are applied repo-side instead:
  // the `[Feature]`/`[Bug]`/`[Feedback]` title prefix is the categorisation signal,
  // and the .github/ISSUE_TEMPLATE/* templates carry the labels for the Issues-tab
  // path. (meta.issueLabels documents that intended labelling.)
  const params = new URLSearchParams({
    title,
    body: buildIssueBody({ ...opts, category: cat }),
  });
  return `https://github.com/${REPO_SLUG}/issues/new?${params.toString()}`;
}

/**
 * Fire the Firebase Analytics `feedback_submitted` event through the shared
 * window seam. Carries only the category (no message text / PII) and never
 * throws into the caller.
 */
export function logFeedbackEvent(category: FeedbackCategory): void {
  try {
    // window.firebaseModules is typed `any` (the shared seam), so narrow it to the
    // one method we call before touching it — keeps this access type-safe instead
    // of leaking `any` through the no-unsafe-* lint rules.
    const fm = typeof window !== 'undefined'
      ? (window.firebaseModules as { logEvent?: (name: string, params?: Record<string, unknown>) => void } | undefined)
      : undefined;
    if (fm && typeof fm.logEvent === 'function') {
      fm.logEvent('feedback_submitted', { category });
    }
  } catch { /* analytics is best-effort */ }
}

// ---------------------------------------------------------------------------
// DOM: the start-screen feedback button + modal. Built lazily, self-contained
// inline styles like ui/share-menu.ts (no shared CSS class dependency beyond the
// reused .menu-button for the start-screen trigger).
// ---------------------------------------------------------------------------

let modalEl: HTMLDivElement | null = null;

function styleOverlay(el: HTMLElement): void {
  Object.assign(el.style, {
    position: 'fixed', inset: '0', display: 'none', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(0,0,0,0.55)', zIndex: '10000',
    fontFamily: 'Arial, sans-serif',
  });
}

function buildModal(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = 'feedbackOverlay';
  styleOverlay(overlay);

  const panel = document.createElement('div');
  panel.id = 'feedbackPanel';
  Object.assign(panel.style, {
    background: '#1c2230', color: '#fff', width: 'min(440px, 92vw)',
    maxHeight: '90vh', overflowY: 'auto', borderRadius: '14px', padding: '20px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  });

  const heading = document.createElement('h3');
  heading.textContent = '💬 Send Feedback';
  Object.assign(heading.style, { margin: '0 0 6px', fontSize: '20px' });

  const blurb = document.createElement('p');
  blurb.textContent = 'Tell us what to build or fix. Submit opens a prefilled GitHub issue you confirm under your own account.';
  Object.assign(blurb.style, { margin: '0 0 14px', fontSize: '13px', color: 'rgba(255,255,255,0.7)', lineHeight: '1.4' });

  // Category radios.
  const catWrap = document.createElement('div');
  Object.assign(catWrap.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' });
  (Object.keys(FEEDBACK_CATEGORIES) as FeedbackCategory[]).forEach((key, i) => {
    const row = document.createElement('label');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', cursor: 'pointer' });
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'feedbackCategory';
    radio.value = key;
    radio.checked = i === 0;
    row.appendChild(radio);
    row.appendChild(document.createTextNode(FEEDBACK_CATEGORIES[key].label));
    catWrap.appendChild(row);
  });

  const textarea = document.createElement('textarea');
  textarea.id = 'feedbackMessage';
  textarea.placeholder = 'Describe your idea or the bug you hit…';
  textarea.maxLength = MAX_MESSAGE;
  Object.assign(textarea.style, {
    width: '100%', minHeight: '110px', resize: 'vertical', boxSizing: 'border-box',
    padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)',
    background: '#11151f', color: '#fff', fontSize: '14px', fontFamily: 'inherit',
  });

  const diagRow = document.createElement('label');
  Object.assign(diagRow.style, { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', margin: '12px 0', cursor: 'pointer', color: 'rgba(255,255,255,0.8)' });
  const diagCheck = document.createElement('input');
  diagCheck.type = 'checkbox';
  diagCheck.id = 'feedbackIncludeDiagnostics';
  diagRow.appendChild(diagCheck);
  diagRow.appendChild(document.createTextNode('Include diagnostics (build, device, physics trace)'));

  const error = document.createElement('p');
  error.id = 'feedbackError';
  Object.assign(error.style, { display: 'none', margin: '0 0 8px', fontSize: '13px', color: '#ff7675' });

  // Buttons.
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '10px', marginTop: '6px' });

  const submit = document.createElement('button');
  submit.id = 'feedbackSubmit';
  submit.type = 'button';
  submit.textContent = 'Submit on GitHub →';
  Object.assign(submit.style, {
    flex: '1', padding: '10px', borderRadius: '10px', border: 'none', cursor: 'pointer',
    fontWeight: '700', fontSize: '14px', color: '#fff',
    background: 'linear-gradient(90deg,#0984e3,#74b9ff)',
  });

  const cancel = document.createElement('button');
  cancel.id = 'feedbackCancel';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, {
    padding: '10px 16px', borderRadius: '10px', border: 'none', cursor: 'pointer',
    fontWeight: '700', fontSize: '14px', color: '#fff', background: 'rgba(255,255,255,0.14)',
  });

  btnRow.appendChild(submit);
  btnRow.appendChild(cancel);

  panel.appendChild(heading);
  panel.appendChild(blurb);
  panel.appendChild(catWrap);
  panel.appendChild(textarea);
  panel.appendChild(diagRow);
  panel.appendChild(error);
  panel.appendChild(btnRow);
  overlay.appendChild(panel);

  // --- Behaviour ---
  const close = (): void => { overlay.style.display = 'none'; error.style.display = 'none'; };
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Keep modal keystrokes from reaching start-menu.ts's document-level keydown
  // handler. That handler starts the run on Enter/Space whenever #startGameContainer
  // is visible (it is — this modal only overlays it), so without this a Space or
  // Enter typed in the textarea would launch the game and hide the start screen
  // mid-report. The modal's focusable controls are all descendants of `overlay`, so
  // stopping propagation here intercepts every in-modal keystroke before it bubbles
  // to `document`; we don't preventDefault, so typing (space/newline) still works.
  // Escape closes the modal.
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });

  submit.addEventListener('click', () => {
    const message = textarea.value.trim();
    if (!message) {
      error.textContent = 'Please describe your feedback first.';
      error.style.display = 'block';
      textarea.focus();
      return;
    }
    const selected = panel.querySelector('input[name="feedbackCategory"]:checked');
    const rawCat = selected instanceof HTMLInputElement ? selected.value : DEFAULT_CATEGORY;
    const category: FeedbackCategory = isFeedbackCategory(rawCat) ? rawCat : DEFAULT_CATEGORY;
    const context = collectContext(diagCheck.checked);
    const url = buildFeedbackIssueUrl({ category, message, context });
    logFeedbackEvent(category);
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    close();
    textarea.value = '';
  });

  return overlay;
}

/** Open the feedback modal, building it on first use. */
export function openFeedback(): void {
  if (typeof document === 'undefined') return;
  if (!modalEl) {
    modalEl = buildModal();
    document.body.appendChild(modalEl);
  }
  modalEl.style.display = 'flex';
  const ta = modalEl.querySelector('#feedbackMessage');
  if (ta instanceof HTMLTextAreaElement) ta.focus();
}

/** Wire the start-screen feedback button. Safe to call repeatedly. */
export function initFeedback(): void {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('feedbackButton');
  if (btn && btn.dataset.feedbackWired !== '1') {
    btn.dataset.feedbackWired = '1';
    btn.addEventListener('click', openFeedback);
    // Keep Enter/Space on this button from bubbling to start-menu.ts's document
    // keydown handler, which starts the run for any target outside #difficultyPicker
    // while #startGameContainer is visible (the button sits inside it). Without this,
    // keyboard-activating the button would launch the game instead of just opening
    // the modal. We don't preventDefault, so the button's native click still fires.
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.stopPropagation();
      }
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFeedback);
  } else {
    initFeedback();
  }
}
