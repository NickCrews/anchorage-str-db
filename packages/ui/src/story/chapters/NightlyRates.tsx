import type { FC } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, money, monthLabel, monthName } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { axisProps, Caveat, ChartBox, COLOR, N, Segmented, Select, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfHistogram } from '../xf/XfHistogram';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type Top = 'distribution' | 'month' | 'bedrooms' | 'area' | 'kind';

/** The SQL key and sort for each grouping of `est_quotes` joined to `est_listings`. */
const GROUP_SQL: Record<Exclude<Top, 'distribution'>, { key: string; sort: string }> = {
  month: { key: "strftime(q.month, '%Y-%m-%d')", sort: 'min(q.month)' },
  bedrooms: {
    key: "CASE WHEN l.bedrooms ILIKE 'studio%' THEN 'Studio' WHEN l.bedroom_count IS NULL THEN 'Not listed' WHEN l.bedroom_count >= 5 THEN '5+' ELSE l.bedroom_count::VARCHAR END",
    sort: "min(CASE WHEN l.bedrooms ILIKE 'studio%' THEN 0 ELSE coalesce(least(l.bedroom_count, 5), 99) END)",
  },
  area: { key: 'l.area', sort: 'l.area' },
  kind: { key: 'l.listing_kind', sort: 'l.listing_kind' },
};

interface VisualState {
  top: Top;
  month: string;
}

export const NightlyRates: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{ p20: number; p50: number; p80: number; mean: number }>(
    `SELECT quantile_cont(quoted_nightly, 0.2) AS p20, quantile_cont(quoted_nightly, 0.5) AS p50,
       quantile_cont(quoted_nightly, 0.8) AS p80, avg(quoted_nightly) AS mean
     FROM est_quotes q WHERE q.month = DATE '${focus}'`,
    { enabled: !!focus },
  );
  const { row: beds } = useRow<{ studio: number; two: number; four: number }>(
    `SELECT
       median(quoted_nightly) FILTER (WHERE l.bedrooms ILIKE 'studio%' OR l.bedroom_count = 1) AS studio,
       median(quoted_nightly) FILTER (WHERE l.bedroom_count = 2) AS two,
       median(quoted_nightly) FILTER (WHERE l.bedroom_count >= 4) AS four
     FROM est_quotes q JOIN est_listings l USING (listing_id)
     WHERE q.month = DATE '${focus}' AND l.listing_kind = 'Entire home'`,
    { enabled: !!focus },
  );
  const { row: areas } = useRow<{ girdwood: number; bowl: number; eagle: number }>(
    `SELECT
       median(quoted_nightly) FILTER (WHERE l.area = 'Girdwood') AS girdwood,
       median(quoted_nightly) FILTER (WHERE l.area = 'Anchorage Bowl') AS bowl,
       median(quoted_nightly) FILTER (WHERE l.area = 'Eagle River–Chugiak') AS eagle
     FROM est_quotes q JOIN est_listings l USING (listing_id)
     WHERE q.month = DATE '${focus}'`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';

  return (
    <Chapter
      id="q3"
      title="What does a night cost?"
      lede={
        <>
          Airbnb doesn't publish a simple nightly price, so every day we ask it to price each listing's next open
          night, the way a guest would. Each listing counts once per month, at its typical asking price for stays
          starting that month.
        </>
      }
      steps={[
        <>
          For stays starting in <N>{month}</N>, the typical listing asked <N>{money(s?.p50)}</N> a night. Most asked
          between <N>{money(s?.p20)}</N> and <N>{money(s?.p80)}</N>. The average, <N>{money(s?.mean)}</N>, is higher
          than the typical price because a few listings are very expensive. Drag across the top of the range to
          see where they are.
        </>,
        <>
          Prices by the month a stay starts. Most prices we collect are for the next few nights, so months further
          ahead rest on fewer listings, shown by the grey bars. Read them as a hint of seasonal pricing.
          <Caveat>
            Asking prices include last-minute discounts on open nights, so guests who booked earlier likely paid a
            little more.
          </Caveat>
        </>,
        <>
          Bigger places cost more. An entire studio or one-bedroom asked about <N>{money(beds?.studio)}</N> a night,
          two bedrooms <N>{money(beds?.two)}</N>, and four or more <N>{money(beds?.four)}</N>.
        </>,
        <>
          So does location. The typical price was <N>{money(areas?.girdwood)}</N> in Girdwood,{' '}
          <N>{money(areas?.bowl)}</N> in the Anchorage Bowl and <N>{money(areas?.eagle)}</N> in Eagle River and
          Chugiak.
          <Caveat>
            For listings that don't show a Muni registration, the area comes from Airbnb's description, so a few
            near the edges may be placed in the wrong one.
          </Caveat>
        </>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={focus} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const months = useStartedMonths();
  const { state, update, exploring, reset } = useStepState<VisualState>(step, [
    { top: 'distribution', month: focusMonth },
    { top: 'month', month: focusMonth },
    { top: 'bedrooms', month: focusMonth },
    { top: 'area', month: focusMonth },
  ]);
  return (
    <XfProvider chapterId="q3" month={state.month}>
      <ChapterGrid
      exploring={exploring}
      onReset={reset}
      controls={
        <>
          <Segmented
            label="Show"
            value={state.top}
            options={[
              { value: 'distribution', label: 'All listings' },
              { value: 'month', label: 'By month' },
              { value: 'bedrooms', label: 'By bedrooms' },
              { value: 'area', label: 'By area' },
              { value: 'kind', label: 'Entire home or room' },
            ]}
            onChange={(top) => update({ top })}
          />
          <Select
            label="Month"
            value={state.month}
            options={months.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(month) => update({ month })}
          />
        </>
      }
      chart={
        state.top === 'distribution' ? (
          <XfHistogram column="_price_capped" label="Asking price per night ($; $1,000 or more shown at 1,000)" />
        ) : (
          <Percentiles top={state.top} month={state.month} />
        )
      }
      caption={state.top === 'distribution' ? 'Number of listings by asking price. The dashed line is the middle listing.' : 'The shaded band covers the middle 60% of listings, the line is the typical price and the dashes the average.'}
      side={<XfSide mapColor={{ field: 'nightly price', type: 'quantile', scheme: 'YlGnBu', title: 'Price per night ($)' }} columns={TABLE_COLUMNS.rate} />}
    />
  </XfProvider>
  );
};

const Percentiles: FC<{ top: Exclude<Top, 'distribution'>; month: string }> = ({ top, month }) => {
  const xf = useXf();
  const g = GROUP_SQL[top];
  const monthFilter = top === 'month' ? 'true' : `q.month = DATE '${month}'`;
  const { rows, isLoading, error } = useRows<{ key: string; listings: number; p20: number; p50: number; p80: number; mean: number }>(
    `SELECT ${g.key} AS key, count(*)::INT AS listings,
       quantile_cont(quoted_nightly, 0.2) AS p20, quantile_cont(quoted_nightly, 0.5) AS p50,
       quantile_cont(quoted_nightly, 0.8) AS p80, avg(quoted_nightly) AS mean
     FROM est_quotes q JOIN est_listings l USING (listing_id)
     WHERE ${monthFilter} AND ${selectedListingsSql(xf, 'l')}
     GROUP BY key ORDER BY ${g.sort}`,
  );
  const data = rows.map((r) => ({
    ...r,
    label: top === 'month' ? monthLabel(Date.parse(r.key)) : r.key,
    band: [r.p20, r.p80] as [number, number],
  }));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis yAxisId="rate" {...axisProps} width={44} tickFormatter={(n: number) => money(n)} />
          <YAxis yAxisId="n" orientation="right" {...axisProps} width={36} />
          <Tooltip
            {...tooltipProps}
            content={({ payload }) => {
              const r = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!r) return null;
              return (
                <div className="bg-popover rounded-md border p-2 text-xs shadow">
                  <div className="font-medium">{r.label}</div>
                  <div>
                    Typical {money(r.p50)} · average {money(r.mean)}
                  </div>
                  <div>
                    Middle 60%: {money(r.p20)} – {money(r.p80)}
                  </div>
                  <div>{int(r.listings)} listings</div>
                </div>
              );
            }}
          />
          <Bar yAxisId="n" dataKey="listings" fill={COLOR.muted} fillOpacity={0.5} isAnimationActive={false} />
          <Area yAxisId="rate" dataKey="band" stroke="none" fill={COLOR.band} isAnimationActive={false} />
          <Line yAxisId="rate" dataKey="p50" stroke={COLOR.primary} strokeWidth={2} dot isAnimationActive={false} />
          <Line yAxisId="rate" dataKey="mean" stroke={COLOR.accent} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
