import type { FC } from 'react';
import { Bar, BarChart, Cell, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, pct1, shortDate } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { axisProps, Caveat, CATEGORY, ChartBox, COLOR, N, Segmented, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { predicateWithout, selectedValue, toggleEqualsClause } from '../xf/clause';
import { REGISTRATION_VALUES, TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type Top = 'trend' | 'registration' | 'mix';

export const Supply: FC = () => {
  const { row: s } = useRow<{ active: number; entire: number; registered: number; noId: number; registrations: number; regsNotOnAirbnb: number }>(
    `SELECT
       count(*)::INT AS active,
       count(*) FILTER (WHERE listing_kind = 'Entire home')::INT AS entire,
       count(*) FILTER (WHERE registration_is_active)::INT AS registered,
       count(*) FILTER (WHERE registration_id IS NULL)::INT AS "noId",
       (SELECT count(*) FROM registrations_active)::INT AS registrations,
       (SELECT count(*) FROM registrations_active WHERE airbnb_listings_active = 0)::INT AS "regsNotOnAirbnb"
     FROM est_listings l WHERE is_active`,
  );
  const { meta } = useStory();
  return (
    <Chapter
      id="q5"
      title="How many are there, and are they registered?"
      lede={
        <>
          Everything here starts with a count of Airbnb listings. A listing is one page on Airbnb, which isn't
          quite the same as one home: a house can be listed whole and room by room, and a duplex can be listed as
          one big rental.
        </>
      }
      steps={[
        <>
          As of our latest look, <N>{int(s?.active)}</N> listings were on Airbnb in the Municipality,{' '}
          <N>{int(s?.entire)}</N> of them whole homes rather than rooms.
          <Caveat>
            When the count dips by about a hundred for a single day and bounces back, that is most likely our
            data collection missing some listings that day, not listings leaving.
          </Caveat>
        </>,
        <>
          Since July 31, 2026, the Muni has required every short-term rental listing to show its registration
          number. <N>{pct1(s && s.registered / s.active)}</N> show a current registration, and <N>{int(s?.noId)}</N>{' '}
          show none at all. Click a bar to see those listings on the map, or see every listing with a{' '}
          <a className="underline" href={`${import.meta.env.BASE_URL}registration-problems`}>
            registration problem
          </a>
          .
        </>,
        <>
          The Muni has <N>{int(s?.registrations)}</N> current registrations. <N>{int(s?.regsNotOnAirbnb)}</N> of them
          don't appear on any Airbnb listing: they may be rented on Vrbo or directly, listed without the number,
          or not rented at all.
        </>,
        <>Whole homes make up most listings in every part of town. They are the listings that can take a home away from people who live here year-round.</>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={meta?.focusMonthSql ?? ''} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const { state, update, exploring, reset } = useStepState<{ top: Top }>(step, [
    { top: 'trend' },
    { top: 'registration' },
    { top: 'registration' },
    { top: 'mix' },
  ]);
  return (
    <XfProvider chapterId="q5" month={focusMonth}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <Segmented
            value={state.top}
            options={[
              { value: 'trend', label: 'Over time' },
              { value: 'registration', label: 'Muni registration' },
              { value: 'mix', label: 'By area' },
            ]}
            onChange={(top) => update({ top })}
          />
        }
        chart={state.top === 'trend' ? <Trend /> : state.top === 'registration' ? <Registration /> : <Mix />}
        caption={
          state.top === 'registration'
            ? "Click a bar to filter. 'Number not on file' can be a typo, or a registration newer than our last check of the Muni's records."
            : 'Listings on Airbnb each day, as filtered below.'
        }
        side={<XfSide mapColor={{ field: 'registration', type: 'categorical', scheme: 'Set1', title: 'Registration' }} columns={TABLE_COLUMNS.supply} />}
      />
    </XfProvider>
  );
};

const Trend: FC = () => {
  const xf = useXf();
  const { rows, isLoading, error } = useRows<{ day: number; listings: number; entire: number }>(
    `SELECT o.scrape_date AS day, count(*)::INT AS listings,
       count(*) FILTER (WHERE l.listing_kind = 'Entire home')::INT AS entire
     FROM airbnb_listing_observations o JOIN est_listings l USING (listing_id)
     WHERE ${selectedListingsSql(xf, 'l')}
     GROUP BY ALL ORDER BY day`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="day" {...axisProps} tickFormatter={(v: number) => shortDate(v)} minTickGap={32} />
          <YAxis {...axisProps} width={44} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => shortDate(v as number)} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
          <Line dataKey="listings" name="Listings on Airbnb" stroke={COLOR.primary} dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line dataKey="entire" name="Whole homes" stroke={COLOR.booked} dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const REGISTRATION_STATUSES = REGISTRATION_VALUES;

/** The registration chart's identity as a clause source in the chapter selection. */
const REGISTRATION_SOURCE = { name: 'registration-bars' };

/** Listings by registration status; clicking a bar filters the chapter to it. */
const Registration: FC = () => {
  const xf = useXf();
  const { rows, isLoading, error } = useRows<{ status: string; n: number }>(
    // Its own clause is left out, as Mosaic does for its clients, so every bar stays clickable.
    `SELECT registration AS status, count(*)::INT AS n FROM ${xf.table} WHERE ${predicateWithout(xf, REGISTRATION_SOURCE)} GROUP BY ALL`,
  );
  const data = REGISTRATION_STATUSES.map((status) => ({ status, n: rows.find((r) => r.status === status)?.n ?? 0 }));
  const picked = selectedValue(xf.selection, REGISTRATION_SOURCE);
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey="status" {...axisProps} width={130} />
          <Tooltip {...tooltipProps} formatter={(v) => int(v as number)} />
          <Bar
            dataKey="n"
            name="Listings"
            fill={CATEGORY[0]}
            cursor="pointer"
            isAnimationActive={false}
            onClick={(d: { status?: string }) => toggleEqualsClause(xf.selection, REGISTRATION_SOURCE, 'registration', d.status ?? null)}
          >
            {data.map((d) => (
              <Cell key={d.status} fill={picked && picked !== d.status ? COLOR.muted : CATEGORY[0]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const Mix: FC = () => {
  const xf = useXf();
  const { rows, isLoading, error } = useRows<{ area: string; entire: number; room: number; other: number }>(
    `SELECT area,
       count(*) FILTER (WHERE "type" = 'Entire home')::INT AS entire,
       count(*) FILTER (WHERE "type" = 'Room')::INT AS room,
       count(*) FILTER (WHERE "type" NOT IN ('Entire home', 'Room'))::INT AS other
     FROM ${xf.table} WHERE ${xf.predicate}
     GROUP BY area ORDER BY entire DESC`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="area" {...axisProps} />
          <YAxis {...axisProps} width={44} />
          <Tooltip {...tooltipProps} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="entire" name="Whole home" stackId="a" fill={CATEGORY[0]} isAnimationActive={false} />
          <Bar dataKey="room" name="Room" stackId="a" fill={CATEGORY[2]} isAnimationActive={false} />
          <Bar dataKey="other" name="Hotel room or unknown" stackId="a" fill={CATEGORY[5]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
