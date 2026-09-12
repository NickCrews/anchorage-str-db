/**
 * Run one job per item, at most `limit` in flight.
 *
 * The jobs are all I/O behind `await`, so a fixed set of workers pulling from
 * a shared cursor is the whole implementation.
 *
 * `limit` is only a cap on how many sockets may be open at once — the pace
 * is set by the run-wide budget in `pace.ts`, which every job waits on
 * before sending. Raising it does not make a run faster past the point
 * where the rate is achievable.
 *
 * Results come back in input order. A job that throws aborts the pass: the
 * remaining items are never started, and the first error propagates. That
 * is what a `RateLimitedError` needs — there is nothing to salvage by
 * continuing, since the block is IP-wide and every remaining item would
 * fail anyway, slowly, while still knocking. Per-item failures that *are*
 * survivable are the job's business to catch and report in its result.
 */

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  job: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: { err: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await job(items[index]!, index);
      } catch (err) {
        // Recorded rather than thrown, so the other workers wind down on
        // their own and no rejection goes unhandled while they do.
        firstError ??= { err };
        return;
      }
    }
  };

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (firstError) throw firstError.err;
  return results;
}
