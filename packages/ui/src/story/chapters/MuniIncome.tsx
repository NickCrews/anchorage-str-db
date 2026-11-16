import { useMemo, type FC } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { int, money, monthLabel, monthName, pct1 } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { ROOM_TAX_RATE } from '../../model/estimates';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { listingMonthsSql } from '../sql';
import { revenueCol } from '../model';
import { axisProps, Caveat, ChartBox, COLOR, N, Segmented, Select, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type View = 'lorenz' | 'deciles' | 'months';
interface VisualState {
  view: View;
  month: string;
}

export const MuniIncome: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{ listings: number; tax: number; taxLow: number; taxHigh: number; top20: number; bottom50: number; zero: number }>(
    `WITH m AS (${listingMonthsSql(focus)}),
     r AS (SELECT *, ntile(100) OVER (ORDER BY coalesce(revenue, 0) DESC) AS pctile FROM m)
     SELECT count(*)::INT AS listings,
       ${ROOM_TAX_RATE} * sum(revenue) AS tax, ${ROOM_TAX_RATE} * sum(revenue_low) AS "taxLow", ${ROOM_TAX_RATE} * sum(revenue_high) AS "taxHigh",
       sum(revenue) FILTER (WHERE pctile <= 20) / sum(revenue) AS top20,
       sum(revenue) FILTER (WHERE pctile > 50) / sum(revenue) AS bottom50,
       count(*) FILTER (WHERE nights_booked = 0)::INT AS zero
     FROM r`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';
  return (
    <Chapter
      id="q9"
      title="What do they pay the Muni in room tax?"
      lede={
        <>
          Guests pay the Muni a {pct1(ROOM_TAX_RATE)} room tax on stays under 30 days, and Airbnb collects it for
          the Muni. Since the tax follows earnings, a few busy listings may pay most of it while many others
          occupy homes and pay little.
        </>
      }
      steps={[
        <>
          In <N>{month}</N>, the busiest fifth of listings earned <N>{pct1(s?.top20)}</N> of all the money, so they
          paid that share of the room tax. The quieter half earned just <N>{pct1(s?.bottom50)}</N>.
        </>,
        <>
          <N>{int(s?.zero)}</N> of {int(s?.listings)} listings had no guests that month and paid no room tax. Each
          row of the table above holds a tenth of the listings, from the busiest to the quietest.
        </>,
        <>
          Our estimate of the room tax Airbnb guests paid in {month}: about <N>{money(s?.tax)}</N>, somewhere between{' '}
          <N>{money(s?.taxLow)}</N> and <N>{money(s?.taxHigh)}</N>.
          <Caveat>
            The tax is also due on cleaning fees, which we don't see, so this likely runs a little low. The Muni's
            own records of what Airbnb paid would check it.
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
    { view: 'lorenz', month: focusMonth },
    { view: 'deciles', month: focusMonth },
    { view: 'months', month: focusMonth },
  ]);
  return (
    <XfProvider chapterId="q9" month={state.month}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <>
            <Segmented
              value={state.view}
              options={[
                { value: 'lorenz', label: 'Who pays most' },
                { value: 'deciles', label: 'By tenths' },
                { value: 'months', label: 'Tax by month' },
              ]}
              onChange={(view) => update({ view })}
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
          state.view === 'lorenz' ? <Lorenz state={state} /> : state.view === 'deciles' ? <Deciles state={state} /> : <TaxByMonth />
        }
        caption={
          state.view === 'lorenz'
            ? 'Listings lined up from highest to lowest earner. If every listing earned the same, the curve would follow the dashed line.'
            : state.view === 'months'
              ? 'Lines show the range from the low to the high estimate. * Bookings so far. The first month is only partly recorded.'
              : `Room tax is ${pct1(ROOM_TAX_RATE)} of estimated revenue.`
        }
        side={<XfSide mapColor={{ field: 'revenue', type: 'quantile', scheme: 'YlOrRd', title: 'Est. revenue ($)' }} columns={TABLE_COLUMNS.tax} />}
      />
    </XfProvider>
  );
};

interface PanelProps {
  state: VisualState;
}

const Lorenz: FC<PanelProps> = ({ state }) => {
  const xf = useXf();
  const { model } = useStory();
  const col = revenueCol(model);
  const { rows, isLoading, error } = useRows<{ v: number }>(
    `SELECT coalesce(${col}, 0) AS v FROM (${listingMonthsSql(state.month, selectedListingsSql(xf, 'l'))}) ORDER BY v DESC`,
  );
  const data = useMemo(() => {
    const total = rows.reduce((a, r) => a + r.v, 0) || 1;
    const out = [{ listings: 0, revenue: 0, even: 0 }];
    let cum = 0;
    const step = Math.max(1, Math.floor(rows.length / 200));
    rows.forEach((r, i) => {
      cum += r.v;
      if ((i + 1) % step === 0 || i === rows.length - 1) {
        const x = (i + 1) / rows.length;
        out.push({ listings: x, revenue: cum / total, even: x });
      }
    });
    return out;
  }, [rows]);
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" />
          <XAxis
            dataKey="listings"
            type="number"
            domain={[0, 1]}
            {...axisProps}
            tickFormatter={(n: number) => pct1(n)}
            label={{ value: 'Top share of listings', position: 'insideBottom', offset: -8, fontSize: 11 }}
          />
          <YAxis domain={[0, 1]} {...axisProps} width={40} tickFormatter={(n: number) => pct1(n)} />
          <Tooltip
            {...tooltipProps}
            labelFormatter={(v) => `Top ${pct1(v as number)} of listings`}
            formatter={(v, name) => [pct1(v as number), name === 'revenue' ? 'of earnings and room tax' : 'if everyone earned the same']}
          />
          <Area dataKey="revenue" fill={COLOR.band} stroke={COLOR.primary} strokeWidth={2} isAnimationActive={false} />
          <Line dataKey="even" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const Deciles: FC<PanelProps> = ({ state }) => {
  const xf = useXf();
  const { model } = useStory();
  const col = revenueCol(model);
  const { rows, isLoading, error } = useRows<{ decile: number; listings: number; revenue: number; share: number; tax: number; nights: number }>(
    `WITH r AS (
       SELECT coalesce(${col}, 0) AS v, nights_booked, ntile(10) OVER (ORDER BY coalesce(${col}, 0) DESC) AS decile
       FROM (${listingMonthsSql(state.month, selectedListingsSql(xf, 'l'))})
     )
     SELECT decile, count(*)::INT AS listings, sum(v) AS revenue, sum(v) / sum(sum(v)) OVER () AS share,
       ${ROOM_TAX_RATE} * sum(v) AS tax, avg(nights_booked) AS nights
     FROM r GROUP BY decile ORDER BY decile`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-card text-muted-foreground sticky top-0 text-left">
            <tr>
              <th className="py-1 pr-2 font-normal">Listings ranked by earnings</th>
              <th className="py-1 pr-2 text-right font-normal">Listings</th>
              <th className="py-1 pr-2 text-right font-normal">Nights booked, average</th>
              <th className="py-1 pr-2 text-right font-normal">Earned</th>
              <th className="py-1 pr-2 text-right font-normal">Room tax</th>
              <th className="py-1 font-normal">Share of tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.decile} className="border-t">
                <td className="py-1.5 pr-2">{r.decile === 1 ? 'Top tenth' : r.decile === 10 ? 'Bottom tenth' : `${r.decile}`}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{int(r.listings)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{r.nights.toFixed(1)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.revenue, true)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.tax, true)}</td>
                <td className="w-1/3 py-1.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 rounded-sm" style={{ width: `${Math.max(1, 100 * r.share)}%`, background: COLOR.primary }} />
                    <span className="tabular-nums">{pct1(r.share)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartBox>
  );
};

const TaxByMonth: FC = () => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ month: number; tax: number; low: number; high: number; isPast: boolean }>(
    `SELECT m.month, ${ROOM_TAX_RATE} * sum(${revenueCol(model)}) AS tax, ${ROOM_TAX_RATE} * sum(revenue_low) AS low,
       ${ROOM_TAX_RATE} * sum(revenue_high) AS high, bool_and(m.is_past) AS "isPast"
     FROM est_listing_months m JOIN est_listings l USING (listing_id)
     WHERE ${selectedListingsSql(xf, 'm')} AND m.month < (SELECT latest_run_date + INTERVAL 180 DAY FROM est_run_dates)
     GROUP BY m.month ORDER BY m.month`,
  );
  const data = rows.map((r) => ({ ...r, label: monthLabel(r.month) + (r.isPast ? '' : '*'), err: [r.tax - r.low, r.high - r.tax] }));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={52} tickFormatter={(n: number) => money(n, true)} />
          <Tooltip {...tooltipProps} formatter={(v) => (Array.isArray(v) ? '' : money(v as number))} />
          <Bar dataKey="tax" name="Room tax" fill={COLOR.primary} isAnimationActive={false}>
            <ErrorBar dataKey="err" width={6} stroke="hsl(var(--foreground))" strokeOpacity={0.6} />
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
