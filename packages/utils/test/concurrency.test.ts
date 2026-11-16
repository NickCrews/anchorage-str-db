import { describe, expect, it } from 'vitest';

import { mapWithinBudget } from '../src/concurrency.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithinBudget', () => {
  it('runs every item when the budget is unlimited', async () => {
    const results = await mapWithinBudget([1, 2, 3], 2, Infinity, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30]);
  });

  it('starts no item once the budget is spent', async () => {
    const started: number[] = [];
    const results = await mapWithinBudget([1, 2, 3], 1, 0, async (n) => {
      started.push(n);
      return n;
    });
    expect(results).toEqual([]);
    expect(started).toEqual([]);
  });

  it('returns the started items, in input order, when the budget runs out mid-pass', async () => {
    // One at a time: item 1 starts at once, then 2 and 3 start after the 30 ms budget.
    const results = await mapWithinBudget([1, 2, 3], 1, 30, async (n) => {
      await sleep(60);
      return n;
    });
    expect(results).toEqual([1]);
  });
});
