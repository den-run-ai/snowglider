/** Error transport deliberately excludes free-form text: messages and stacks can
 * contain account details, credential URLs, and player input. The local diagnostic
 * download retains bounded text for a player to inspect and share deliberately. */
const ERROR_TYPES = new Set([
  'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'NotAllowedError', 'SecurityError',
  'QuotaExceededError', 'NetworkError', 'FirebaseError',
]);
const ERROR_SOURCES = new Set([
  'animation_loop', 'course_result', 'result_firebase_status', 'window_error',
  'unhandled_rejection',
]);
const ERROR_CODES = new Set([
  'unavailable', 'permission-denied', 'unauthenticated', 'resource-exhausted',
  'deadline-exceeded', 'failed-precondition', 'not-found', 'cancelled',
  'auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request',
  'auth/network-request-failed', 'auth/operation-not-allowed',
  'auth/account-exists-with-different-credential', 'auth/credential-already-in-use',
  'auth/email-already-in-use', 'auth/too-many-requests', 'auth/internal-error',
]);

/** Read SDK/cross-realm error fields without invoking object coercion or allowing
 * malformed getters to turn the error handler into another uncaught exception. */
function textField(value: unknown, field: string): string {
  try {
    if (value !== null && typeof value === 'object') {
      const text = (value as Record<string, unknown>)[field];
      if (typeof text === 'string') return text;
    }
  } catch { /* getters and proxies are untrusted */ }
  return '';
}

function sourcePosition(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 10_000_000) : 0;
}

/** Keep only static, same-origin source locations; discard credentials, search,
 * fragments, external script URLs and arbitrary document/storage paths. */
export function errorLocation(stack: string, filename: string, line: unknown,
  column: unknown, origin: string): { script: string; line: number; column: number } {
  const candidates: Array<{ url: string; line: unknown; column: unknown }> = [
    { url: filename, line, column },
  ];
  for (const frame of stack.slice(0, 4000).split('\n').slice(0, 12)) {
    const match = frame.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
    if (match) candidates.push({ url: match[1]!, line: Number(match[2]), column: Number(match[3]) });
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.url, origin);
      if (url.origin !== origin || url.username || url.password) continue;
      if (!/^\/(?:assets\/[A-Za-z][A-Za-z0-9._-]{0,75}\.js|src\/(?:[a-z-]+\/){0,3}[a-z-]+\.(?:js|ts))$/.test(url.pathname)) continue;
      return { script: url.pathname.slice(0, 100),
        line: sourcePosition(candidate.line), column: sourcePosition(candidate.column) };
    } catch { /* absent/malformed source metadata is optional */ }
  }
  return { script: 'unknown', line: sourcePosition(line), column: sourcePosition(column) };
}

/** Build separate public aggregate fields and local-only debugging context. */
export function buildErrorReport(error: unknown, source: string, fallbackMessage = '',
  line: unknown = 0, column: unknown = 0, filename = '') {
  const name = textField(error, 'name');
  const code = textField(error, 'code');
  const stack = textField(error, 'stack').slice(0, 4000);
  const origin = typeof window !== 'undefined' ? window.location?.origin || '' : '';
  const location = errorLocation(stack, filename, line, column, origin);
  const message = textField(error, 'message') ||
    (typeof error === 'string' ? error : fallbackMessage) || 'error';
  return {
    params: {
      error_type: ERROR_TYPES.has(name) ? name : 'Error',
      error_code: ERROR_CODES.has(code) ? code : 'unknown',
      // `source` is a GA campaign parameter; keep diagnostics in its own namespace.
      error_source: ERROR_SOURCES.has(source) ? source : 'caught_error',
      ...location,
    },
    local: { message: message.slice(0, 1000), stack },
  };
}

/** Bound unique error uploads across run restarts; a broken loop must not send an
 * event every frame. The set's size is bounded by the same page-lifetime budget. */
export class ErrorReportBudget {
  private readonly seen = new Set<string>();
  private readonly limit: number;
  constructor(limit = 20) { this.limit = limit; }

  accept(event: string, params: ReturnType<typeof buildErrorReport>['params']): boolean {
    const key = JSON.stringify([event, params]);
    if (this.seen.has(key) || this.seen.size >= this.limit) return false;
    this.seen.add(key);
    return true;
  }

  clear(): void { this.seen.clear(); }
}
