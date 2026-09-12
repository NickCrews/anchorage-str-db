/**
 * Logging, to stderr, with a level. Everything a run says goes through here.
 *
 * stderr rather than stdout because a run's only stdout product should be
 * whatever a caller might want to pipe; the narration is diagnostics.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;

export function setLevel(level: Level): void {
  threshold = RANK[level];
}

function emit(level: Level, message: string): void {
  if (RANK[level] < threshold) return;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
  process.stderr.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}\n`);
}

export const log = {
  debug: (message: string) => emit('debug', message),
  info: (message: string) => emit('info', message),
  warn: (message: string) => emit('warn', message),
  error: (message: string) => emit('error', message),
};

/** `"HttpError: HTTP 429 for …"` — the shape the run log records. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * The innermost `cause`. A per-listing failure is recorded as the reason
 * Airbnb actually gave, not as the retry wrapper that gave up on it — "HTTP
 * 503" is diagnosable and "failed after 3 attempts" is not.
 */
export function rootCause(err: unknown): unknown {
  let current = err;
  while (current instanceof Error && current.cause !== undefined) current = current.cause;
  return current;
}
