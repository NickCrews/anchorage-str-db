import type { FC } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, isoDate, longDate, money, monthName, pct1, shortDate } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { ROOM_TAX_RATE } from '../../model/estimates';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { listingMonthsSql } from '../sql';
import { axisProps, CATEGORY, ChartBox, N, Segmented, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type View = 'table' | 'trend';

interface BaselineRow extends Record<string, unknown> {
  activeListings: number;
  entireShare: number;
  registeredShare: number;
  hosts: number;
  multiHostShare: number;
  medianRate: number;
  medianOccupancy: number;
  medianOccupancyLow: number;
  medianOccupancyHigh: number;
  revenue: number;
  revenueLow: number;
  revenueHigh: number;
  top20Share: number;
  outsideMuniShare: number;
  companyShare: number;
  ownerOccupiedShare: number;
}

/** The baseline over the listings `where` keeps, an `est_listings l` condition. */
const useBaseline = (where: string) => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  return useRow<BaselineRow>(
    `WITH a AS (SELECT * FROM est_listings l WHERE is_active AND ${where}),
     m AS (${listingMonthsSql(focus, where)}),
     r AS (SELECT revenue, ntile(5) OVER (ORDER BY coalesce(revenue, 0) DESC) AS q FROM m),
     h AS (SELECT host_id, count(*) AS n FROM a WHERE host_id IS NOT NULL GROUP BY host_id),
     o AS (SELECT * FROM a WHERE owner_kind <> 'Unknown')
     SELECT
       (SELECT count(*) FROM a)::INT AS "activeListings",
       (SELECT count(*) FILTER (WHERE listing_kind = 'Entire home') / count(*) FROM a) AS "entireShare",
       (SELECT count(*) FILTER (WHERE registration_is_active) / count(*) FROM a) AS "registeredShare",
       (SELECT count(*) FROM h)::INT AS hosts,
       (SELECT sum(n) FILTER (WHERE n >= 2) / sum(n) FROM h) AS "multiHostShare",
       (SELECT median(q.quoted_nightly) FROM est_quotes q JOIN a USING (listing_id) WHERE q.month = DATE '${focus}') AS "medianRate",
       (SELECT median(occupancy) FROM m) AS "medianOccupancy",
       (SELECT median(occupancy_low) FROM m) AS "medianOccupancyLow",
       (SELECT median(occupancy_high) FROM m) AS "medianOccupancyHigh",
       (SELECT sum(revenue) FROM m) AS revenue,
       (SELECT sum(revenue_low) FROM m) AS "revenueLow",
       (SELECT sum(revenue_high) FROM m) AS "revenueHigh",
       (SELECT sum(revenue) FILTER (WHERE q = 1) / sum(revenue) FROM r) AS "top20Share",
       (SELECT count(*) FILTER (WHERE owner_mailing <> 'In the Muni') / count(*) FROM o) AS "outsideMuniShare",
       (SELECT count(*) FILTER (WHERE owner_kind = 'Company') / count(*) FROM o) AS "companyShare",
       (SELECT count(*) FILTER (WHERE owner_occupied_exemption) / count(*) FROM o) AS "ownerOccupiedShare"`,
    { enabled: !!focus },
  );
};

/** The baseline as label/value/definition rows, for the table and the CSV. */
function baselineLines(b: BaselineRow | undefined, month: string): [string, string, string][] {
  return [
    ['Listings on Airbnb', int(b?.activeListings), 'Seen on Airbnb in the last five days'],
    ['Entire homes', pct1(b?.entireShare), 'Share of listings that rent out an entire home rather than a room'],
    ['Showing a current Muni registration', pct1(b?.registeredShare), 'Share of listings'],
    ['Hosts', int(b?.hosts), 'Airbnb accounts running at least one of these listings'],
    ['Run by hosts with two or more listings', pct1(b?.multiHostShare), 'Share of listings'],
    [`Typical price per night, ${month}`, money(b?.medianRate), 'Middle asking price for stays starting that month'],
    [
      `Typical share of nights booked, ${month}`,
      `${pct1(b?.medianOccupancy)} (${pct1(b?.medianOccupancyLow)}–${pct1(b?.medianOccupancyHigh)})`,
      'Of the nights a listing was offered; range is the low to high estimate',
    ],
    [
      `Total earnings, ${month}`,
      `${money(b?.revenue, true)} (${money(b?.revenueLow, true)}–${money(b?.revenueHigh, true)})`,
      'Booked nights times asking price, added up over listings',
    ],
    [`Room tax, ${month}`, money(b ? ROOM_TAX_RATE * b.revenue : null, true), `${pct1(ROOM_TAX_RATE)} of earnings`],
    [`Earnings going to the busiest fifth of listings, ${month}`, pct1(b?.top20Share), 'Listings ranked by earnings'],
    ['Owner gets tax bill outside the Muni', pct1(b?.outsideMuniShare), 'Of listings whose owner we found'],
    ['Owned by a company', pct1(b?.companyShare), 'Of listings whose owner we found'],
    ['Owner lives on the property', pct1(b?.ownerOccupiedShare), 'Of listings whose owner we found'],
  ];
}

export const Baseline: FC = () => {
  const { meta } = useStory();
  return (
    <Chapter
      id="q11"
      title="Where do things stand today?"
      lede={
        <>
          To know whether a new rule works, you need to know what things looked like before it took effect. We
          record the same measures every day in the same way, so any change can be compared with what came
          before.
        </>
      }
      steps={[
        <>
          Where things stood as of <N>{meta ? longDate(meta.latestRunDate) : '…'}</N>. Narrow the table to a part
          of town or a kind of listing and these numbers follow. Download a copy to keep.
        </>,
        <>
          The same measures day by day. A rule that starts on a known date would show up as a jump in these lines.
          Seasons will show up too, so the fair comparison is with the same month a year earlier.
        </>,
        <>
          The Muni's registration requirement started on July 31, 2026, before we began recording in September, so
          we have no "before" for it. For the next change, we will.
        </>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={meta?.focusMonthSql ?? ''} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const { state, update, exploring, reset } = useStepState<{ view: View }>(step, [{ view: 'table' }, { view: 'trend' }, { view: 'trend' }]);
  return (
    <XfProvider chapterId="q11" month={focusMonth}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <Segmented
            value={state.view}
            options={[
              { value: 'table', label: 'Today' },
              { value: 'trend', label: 'Day by day' },
            ]}
            onChange={(view) => update({ view })}
          />
        }
        chart={state.view === 'table' ? <Table /> : <Trend />}
        caption={
          state.view === 'trend'
            ? 'Days we missed are skipped.'
            : undefined
        }
        side={<XfSide mapColor={{ field: 'registration', type: 'categorical', scheme: 'Set1', title: 'Registration' }} columns={TABLE_COLUMNS.baseline} />}
      />
    </XfProvider>
  );
};

/** The selected listings as an `est_listings l` condition; every listing when nothing is selected. */
const useWhere = () => {
  const xf = useXf();
  return xf.predicate === 'true' ? 'true' : selectedListingsSql(xf, 'l');
};

const Table: FC = () => {
  const { meta } = useStory();
  const xf = useXf();
  const { row, isLoading, error } = useBaseline(useWhere());
  const month = meta ? monthName(meta.focusMonth) : '';
  const lines = baselineLines(row, month);
  const download = () => {
    const csv = [['measure', 'value', 'definition'], ...lines]
      .map((cols) => cols.map((c) => `"${c.replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const header = `# Anchorage short-term rentals, as of ${meta ? isoDate(meta.latestRunDate) : ''}, ${xf.predicate === 'true' ? 'all listings' : `listings where ${xf.predicate}`}\n`;
    const url = URL.createObjectURL(new Blob([header + csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `anchorage-str-baseline-${meta ? isoDate(meta.latestRunDate) : ''}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <button onClick={download} className="hover:bg-muted bg-background absolute top-0 right-0 z-10 rounded-md border px-2 py-0.5 text-xs">
        Download CSV
      </button>
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <tbody>
            {lines.map(([label, value, def]) => (
              <tr key={label} className="border-t first:border-t-0">
                <td className="py-1.5 pr-3">
                  <div>{label}</div>
                  <div className="text-muted-foreground text-[11px]">{def}</div>
                </td>
                <td className="py-1.5 text-right text-sm font-medium whitespace-nowrap tabular-nums">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartBox>
  );
};

const Trend: FC = () => {
  const where = useWhere();
  const { rows, isLoading, error } = useRows<{ day: number; listings: number; entireShare: number; idShare: number }>(
    `SELECT o.scrape_date AS day, count(*)::INT AS listings,
       count(*) FILTER (WHERE v.listing_type = 'Entire home/apt') / count(*) AS "entireShare",
       count(*) FILTER (WHERE v.registration_id IS NOT NULL) / count(*) AS "idShare"
     FROM airbnb_listing_observations o
     JOIN listings v ON v.listing_id = o.listing_id AND o.scrape_date >= v.valid_from AND (v.valid_to IS NULL OR o.scrape_date < v.valid_to)
     JOIN est_listings l ON l.listing_id = o.listing_id
     WHERE ${where}
     GROUP BY ALL ORDER BY day`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="day" {...axisProps} tickFormatter={(v: number) => shortDate(v)} minTickGap={32} />
          <YAxis yAxisId="n" {...axisProps} width={44} />
          <YAxis yAxisId="s" orientation="right" domain={[0, 1]} {...axisProps} width={40} tickFormatter={(n: number) => pct1(n)} />
          <Tooltip
            {...tooltipProps}
            labelFormatter={(v) => shortDate(v as number)}
            formatter={(v, name) => (name === 'Listings on Airbnb' ? int(v as number) : pct1(v as number))}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Line yAxisId="n" dataKey="listings" name="Listings on Airbnb" stroke={CATEGORY[0]} dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line yAxisId="s" dataKey="entireShare" name="Entire homes" stroke={CATEGORY[1]} dot={false} isAnimationActive={false} />
          <Line yAxisId="s" dataKey="idShare" name="Showing a registration" stroke={CATEGORY[2]} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
