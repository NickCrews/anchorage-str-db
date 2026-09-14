/**
 * Run one job per item, at most `limit` at a time, returning results in input
 * order.
 *
 * If a job throws, no further items start and the first error is rethrown.
 * Jobs should catch and return any per-item failure that shouldn't abort the
 * pass.
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
        // Recorded rather than thrown so other workers stop cleanly.
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
