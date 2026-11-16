/**
 * The three ways the page can count a closed night, which the reader picks
 * in the Methodology menu. Every chart, map and table follows the choice.
 */
export type Model = 'low' | 'middle' | 'high';

export const MODELS: { value: Model; label: string; summary: string }[] = [
  {
    value: 'low',
    label: 'Low estimate',
    summary:
      'Counts a night as booked only if we saw it open earlier and then saw it close. Misses bookings made before we started watching, so it reads low.',
  },
  {
    value: 'middle',
    label: 'Middle estimate',
    summary:
      'Also counts nights that were already closed when we first looked, unless they are part of a long closed stretch, which looks like the owner blocking dates rather than guests booking.',
  },
  {
    value: 'high',
    label: 'High estimate',
    summary:
      'Counts every closed night as booked, including dates the owner blocked for themselves. Reads high.',
  },
];

export const modelLabel = (m: Model) => MODELS.find((x) => x.value === m)?.label ?? m;

/** The est_listing_months revenue column for a model. */
export const revenueCol = (m: Model) => (m === 'low' ? 'revenue_low' : m === 'high' ? 'revenue_high' : 'revenue');

/** An `est_nights` condition for a night the model counts as booked, over alias `n`. */
export const bookedNightSql = (m: Model) =>
  m === 'low' ? `n.state = 'booked_observed'` : m === 'high' ? `n.state <> 'available'` : `n.state LIKE 'booked%'`;
