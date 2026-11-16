import type { FC } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, monthName, pct1 } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { axisProps, Caveat, CATEGORY, ChartBox, N, Segmented, Select, tooltipProps } from '../ui';
import { predicateWithout, selectedValue, toggleEqualsClause } from '../xf/clause';
import { selectedListingsSql, useXf } from '../xf/context';
import { LIVES_THERE_SQL, TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

/** Whether anyone is likely to live in an entire-home listing's dwelling, from its parcel. */
/** The council chart's identity as a clause source in the chapter selection. */
const COUNCIL_SOURCE = { name: 'council-bars' };

const RESIDENCE = LIVES_THERE_SQL;

/**
 * Entire homes with no residence exemption whose calendar was open or
 * booked for at least half the month: run as rentals, with no sign of a
 * resident owner.
 */
const noResidentSql = (month: string, where = 'true') => `
  SELECT l.*, m.nights_available + m.nights_booked AS nights_offered, m.nights
  FROM est_listing_months m JOIN est_listings l USING (listing_id)
  WHERE m.month = DATE '${month}' AND l.listing_kind = 'Entire home'
    AND ${where}
    AND l.owner_name IS NOT NULL AND NOT l.owner_occupied_exemption
    AND (m.nights_available + m.nights_booked) >= m.nights / 2
`;

type View = 'councils' | 'noResident';
interface VisualState {
  view: View;
  month: string;
}

export const Locals: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{
    entire: number;
    matched: number;
    exempt: number;
    noResident: number;
    topCouncil: string;
    topCouncilHomes: number;
  }>(
    `WITH e AS (SELECT * FROM est_listings l WHERE is_active AND listing_kind = 'Entire home'),
     nr AS (${noResidentSql(focus)}),
     c AS (SELECT community_council, count(*) AS n FROM e WHERE community_council IS NOT NULL GROUP BY ALL)
     SELECT (SELECT count(*) FROM e)::INT AS entire,
       (SELECT count(*) FROM e WHERE owner_name IS NOT NULL)::INT AS matched,
       (SELECT count(*) FROM e WHERE owner_occupied_exemption)::INT AS exempt,
       (SELECT count(*) FROM nr)::INT AS "noResident",
       (SELECT arg_max(community_council, n) FROM c) AS "topCouncil",
       (SELECT max(n) FROM c)::INT AS "topCouncilHomes"`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';
  return (
    <Chapter
      id="q8"
      title="What do they take from neighborhoods?"
      lede={
        <>
          A whole home rented to visitors is a home no neighbor lives in, at least on those nights. Where many
          cluster, a street can have dark windows in the off-season and fewer year-round neighbors. A room rented
          inside a lived-in home doesn't take a home away.
        </>
      }
      steps={[
        <>
          There are <N>{int(s?.entire)}</N> whole homes listed on Airbnb. By community council, the most are in{' '}
          <N>{s?.topCouncil}</N>, with <N>{int(s?.topCouncilHomes)}</N>. Click a bar to see that neighborhood's
          listings.
          <Caveat>
            We place a listing in a community council using the address on its Muni registration, so listings
            without one aren't counted here.
          </Caveat>
        </>,
        <>
          Of the <N>{int(s?.matched)}</N> whole homes we can match to an owner, <N>{int(s?.exempt)}</N> are on
          property the owner claims as their own home. The rest have no owner living there on record.
        </>,
        <>
          A stricter count: in <N>{month}</N>, <N>{int(s?.noResident)}</N> whole homes had no owner living there and
          were open to guests or booked for at least half the month. These are the homes most likely lost to
          people who would live in them year-round.
          <Caveat>
            A long-term tenant could live in a property whose owner lives elsewhere, so this doesn't prove a home
            sits empty. It shows where to look.
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
    { view: 'councils', month: focusMonth },
    { view: 'councils', month: focusMonth },
    { view: 'noResident', month: focusMonth },
  ]);
  return (
    <XfProvider chapterId="q8" month={state.month}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <>
            <Segmented
              value={state.view}
              options={[
                { value: 'councils', label: 'By community council' },
                { value: 'noResident', label: 'Nobody home?' },
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
        chart={state.view === 'councils' ? <Councils /> : <NoResident month={state.month} />}
        caption={
          state.view === 'councils'
            ? 'Whole homes on Airbnb by community council, split by whether the owner lives there. Click a bar to filter.'
            : 'Whole homes whose owner lives elsewhere and that were open to guests or booked at least half the month.'
        }
        side={<XfSide mapColor={{ field: 'owner lives there?', type: 'categorical', scheme: 'Set2', title: 'Owner lives there?' }} columns={TABLE_COLUMNS.locals} />}
      />
    </XfProvider>
  );
};

const Councils: FC = () => {
  const xf = useXf();
  const picked = selectedValue(xf.selection, COUNCIL_SOURCE);
  const { rows, isLoading, error } = useRows<{ council: string; exempt: number; notExempt: number; noParcel: number }>(
    `SELECT l.community_council AS council,
       count(*) FILTER (WHERE ${RESIDENCE} = 'Owner lives there')::INT AS exempt,
       count(*) FILTER (WHERE ${RESIDENCE} = 'Owner lives elsewhere')::INT AS "notExempt",
       count(*) FILTER (WHERE ${RESIDENCE} = 'Owner not known')::INT AS "noParcel"
     FROM est_listings l
     WHERE l.listing_kind = 'Entire home' AND l.community_council IS NOT NULL
       AND l.listing_id IN (SELECT listing_id::BIGINT FROM ${xf.table} WHERE ${predicateWithout(xf, COUNCIL_SOURCE)})
     GROUP BY ALL ORDER BY count(*) DESC LIMIT 25`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey="council" {...axisProps} width={130} interval={0} />
          <Tooltip {...tooltipProps} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="notExempt"
            name="Owner lives elsewhere"
            stackId="a"
            fill={CATEGORY[1]}
            cursor="pointer"
            onClick={(d: { council?: string }) => toggleEqualsClause(xf.selection, COUNCIL_SOURCE, 'community council', d.council ?? null)}
            isAnimationActive={false}
          >
            {rows.map((r) => (
              <Cell key={r.council} fillOpacity={picked && picked !== r.council ? 0.3 : 1} />
            ))}
          </Bar>
          <Bar dataKey="exempt" name="Owner lives there" stackId="a" fill={CATEGORY[2]} isAnimationActive={false} />
          <Bar dataKey="noParcel" name="Owner not known" stackId="a" fill={CATEGORY[5]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const NoResident: FC<{ month: string }> = ({ month }) => {
  const xf = useXf();
  const { rows, isLoading, error } = useRows<{ council: string; homes: number; share: number }>(
    `WITH nr AS (${noResidentSql(month, selectedListingsSql(xf, 'l'))}),
     e AS (SELECT community_council, count(*) AS n FROM est_listings l WHERE is_active AND listing_kind = 'Entire home' GROUP BY ALL)
     SELECT coalesce(nr.community_council, 'Unknown') AS council, count(*)::INT AS homes, count(*) / any_value(e.n) AS share
     FROM nr LEFT JOIN e USING (community_council)
     GROUP BY ALL ORDER BY homes DESC LIMIT 25`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey="council" {...axisProps} width={130} interval={0} />
          <Tooltip {...tooltipProps} formatter={(v, name) => (name === 'share' ? pct1(v as number) : v)} />
          <Bar dataKey="homes" name="Whole homes" fill={CATEGORY[1]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
