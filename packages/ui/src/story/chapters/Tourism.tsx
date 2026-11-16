import type { FC } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, monthName, shortDate } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { bookedNightSql } from '../model';
import { axisProps, Caveat, ChartBox, COLOR, N, Segmented, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

type View = 'guests' | 'needed';

export const Tourism: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{ listingNights: number; guestCapacityNights: number; peakNight: number; peakListings: number }>(
    `WITH n AS (
       SELECT n.night_date, l.guest_capacity
       FROM est_nights n JOIN est_listings l USING (listing_id)
       WHERE n.month = DATE '${focus}' AND n.state LIKE 'booked%'
     ),
     per_night AS (SELECT night_date, count(*) AS listings FROM n GROUP BY night_date)
     SELECT (SELECT count(*) FROM n)::INT AS "listingNights",
       (SELECT sum(guest_capacity) FROM n)::INT AS "guestCapacityNights",
       arg_max(night_date, listings) AS "peakNight", max(listings)::INT AS "peakListings"
     FROM per_night`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';
  return (
    <Chapter
      id="q7"
      title="How many visitors do they house?"
      lede={
        <>
          Short-term rentals are places for visitors to stay, like hotels. If there were fewer of them, would
          their guests stay in hotels instead, or not come at all? That depends on whether hotels have empty
          rooms on the nights rentals are busiest. We have the rental half of that picture.
        </>
      }
      steps={[
        <>
          In <N>{month}</N>, Airbnb listings were booked for about <N>{int(s?.listingNights)}</N> nights in total.
          Those listings sleep up to <N>{int(s?.guestCapacityNights)}</N> guests across those nights; real groups are
          often smaller than a place sleeps, so the true number of guests is lower.
        </>,
        <>
          The busiest night was <N>{s?.peakNight ? shortDate(s.peakNight) : '…'}</N>, with <N>{int(s?.peakListings)}</N>{' '}
          listings booked. Nights after today show bookings made so far.
        </>,
        <>
          To know whether rentals bring extra visitors or take them from hotels, we need information we don't
          have yet, listed above. With it, the test is simple: on nights when hotels are full, rental guests are
          extra visitors; on nights with empty hotel rooms, fewer rentals would mostly send guests to hotels.
          <Caveat>
            A year of daily records, before and after a rule change, will also show whether the remaining rentals
            get booked more when there are fewer of them.
          </Caveat>
        </>,
      ]}
      visual={(step) => <Visual step={step} focusMonth={focus} />}
    />
  );
};

const Visual: FC<{ step: number; focusMonth: string }> = ({ step, focusMonth }) => {
  const { state, update, exploring, reset } = useStepState<{ view: View }>(step, [
    { view: 'guests' },
    { view: 'guests' },
    { view: 'needed' },
  ]);
  return (
    <XfProvider chapterId="q7" month={focusMonth}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <Segmented
            value={state.view}
            options={[
              { value: 'guests', label: 'Booked each night' },
              { value: 'needed', label: "What we're missing" },
            ]}
            onChange={(view) => update({ view })}
          />
        }
        chart={state.view === 'guests' ? <Guests /> : <Needed />}
        caption={
          state.view === 'guests'
            ? 'Listings booked each night, and how many guests those listings sleep. Real groups are usually smaller.'
            : undefined
        }
        side={<XfSide mapColor={{ field: 'nights booked', type: 'quantile', scheme: 'Blues', title: 'Nights booked' }} columns={TABLE_COLUMNS.tourism} />}
      />
    </XfProvider>
  );
};

const Guests: FC = () => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ night: number; listings: number; capacity: number }>(
    `SELECT n.night_date AS night, count(*)::INT AS listings, sum(l.guest_capacity)::INT AS capacity
     FROM est_nights n JOIN est_listings l USING (listing_id)
     WHERE ${bookedNightSql(model)} AND ${selectedListingsSql(xf, 'n')}
       AND n.night_date < (SELECT latest_run_date + INTERVAL 90 DAY FROM est_run_dates)
     GROUP BY ALL ORDER BY night`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="night" {...axisProps} tickFormatter={(v: number) => shortDate(v)} minTickGap={32} />
          <YAxis {...axisProps} width={44} />
          <Tooltip {...tooltipProps} labelFormatter={(v) => shortDate(v as number)} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Area dataKey="capacity" name="Guests they sleep" fill={COLOR.band} stroke={COLOR.primary} isAnimationActive={false} />
          <Area dataKey="listings" name="Listings booked" fill={COLOR.booked} stroke={COLOR.booked} fillOpacity={0.6} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const NEEDED: [string, string][] = [
  ['Hotel and motel rooms', 'How many rooms each hotel has and how full they are each night or month. Possible sources: the Muni, Visit Anchorage, or hotel industry reports.'],
  ['Room tax collected', 'How much room tax the Muni collects each month from hotels and from Airbnb and similar sites, to check our estimates.'],
  ['Vrbo and direct bookings', 'We only see Airbnb. Registered rentals with no Airbnb listing hint at how much we miss.'],
  ['Visitor counts', 'Airport arrivals and cruise passengers, to put rental guests in proportion.'],
];

const Needed: FC = () => (
  <div className="absolute inset-0">
    <ul className="h-full space-y-2 overflow-auto text-sm">
      {NEEDED.map(([what, why]) => (
        <li key={what} className="rounded-md border p-3">
          <div className="font-medium">{what}</div>
          <div className="text-muted-foreground mt-1 text-[13px] leading-snug">{why}</div>
        </li>
      ))}
    </ul>
  </div>
);
