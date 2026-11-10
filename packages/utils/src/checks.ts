/**
 * Data-quality check results, shared by every run's checks. Any failed
 * error-severity check makes the run exit non-zero, which blocks publishing.
 */

import { log } from './log.ts';

export type Severity = 'error' | 'warn';

export interface CheckResult {
  name: string;
  severity: Severity;
  passed: boolean;
  detail: string;
}

/** `0.25` as `25%`, for check details. */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Log every check; return true iff no error-severity check failed. */
export function report(results: readonly CheckResult[]): boolean {
  let ok = true;
  for (const result of results) {
    const status = result.passed ? 'PASS' : `FAIL (${result.severity})`;
    const line = `[${status}] ${result.name}: ${result.detail}`;
    if (result.passed) log.info(line);
    else log.warn(line);
    if (!result.passed && result.severity === 'error') ok = false;
  }
  return ok;
}
