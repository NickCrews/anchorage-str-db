import type { FC } from 'react';
import { int, money, monthName, pct1 } from '../../format';
import { useRow } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { listingMonthsSql } from '../sql';
import { Caveat, N, Select } from '../ui';
import { TABLE_COLUMNS } from '../xf/table';
import { XfHistogram } from '../xf/XfHistogram';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

export const ListingRevenue: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';

  const { row: s } = useRow<{
    listings: number;
    p20: number;
    p50: number;
    p80: number;
    zero: number;
    topShare: number;
    p50Low: number;
    p50High: number;
  }>(
    `WITH m AS (${listingMonthsSql(focus)}),
     ranked AS (SELECT *, ntile(10) OVER (ORDER BY revenue DESC) AS decile FROM m WHERE revenue IS NOT NULL)
     SELECT
       count(*)::INT AS listings,
       quantile_cont(revenue, 0.2) AS p20,
       quantile_cont(revenue, 0.5) AS p50,
       quantile_cont(revenue, 0.8) AS p80,
       count(*) FILTER (WHERE nights_booked = 0)::INT AS zero,
       sum(revenue) FILTER (WHERE decile = 1) / sum(revenue) AS "topShare",
       quantile_cont(revenue_low, 0.5) AS "p50Low",
       quantile_cont(revenue_high, 0.5) AS "p50High"
     FROM ranked`,
    { enabled: !!focus },
  );

  const month = meta ? monthName(meta.focusMonth) : '…';

  return (
    <Chapter
      id="q1"
      title="How much does a short-term rental earn?"
      lede={
        <>
          Rent and mortgages are paid by the month, so we look at what each Airbnb listing earned in a month:
          the nights guests booked, times the price the listing was asking.
        </>
      }
      steps={[
        <>
          In <N>{month}</N>, the typical Anchorage listing earned about <N>{money(s?.p50)}</N>. Most earned
          between <N>{money(s?.p20)}</N> and <N>{money(s?.p80)}</N>, out of {int(s?.listings)} listings.
          <Caveat>{int(s?.zero)} listings had no guests at all that month.</Caveat>
        </>,
        <>
          A few listings earn most of the money. The top tenth took in <N>{pct1(s?.topShare)}</N> of all the
          earnings. Drag across the right end of the chart to see where those listings are and who runs them.
        </>,
        <>
          These are estimates. Depending on how we count nights the calendar shows as closed, the typical listing
          earned anywhere from <N>{money(s?.p50Low)}</N> to <N>{money(s?.p50High)}</N>. The{' '}
          <strong>Methodology</strong> menu at the top left explains why and lets you switch.
        </>,
        <>
          Click any dot on the map or row in the table to see one listing month by month: how many nights were
          booked, what it charged, who runs it and who owns the property.
        </>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={focus} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const months = useStartedMonths();
  const { state, update, exploring, reset } = useStepState<{ month: string }>(step, [{ month: focusMonth }]);
  return (
    <XfProvider chapterId="q1" month={state.month}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <Select
            label="Month"
            value={state.month}
            options={months.map((m) => ({ value: m.value, label: m.label }))}
            onChange={(month) => update({ month })}
          />
        }
        chart={<XfHistogram column="_revenue_capped" label="Earnings for the month ($; $8,000 or more shown at 8,000)" />}
        caption="Number of listings by what they earned. The dashed line is the middle listing. Earnings are what guests paid, before Airbnb's fees, room tax and cleaning fees."
        side={<XfSide mapColor={{ field: 'revenue', type: 'quantile', scheme: 'YlOrRd', title: 'Earnings ($)' }} columns={TABLE_COLUMNS.revenue} />}
      />
    </XfProvider>
  );
};
