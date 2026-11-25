import { useState, type FC, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ErrorBar,
  Legend,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { int, money, monthName, pct1 } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { revenueCol } from '../model';
import { axisProps, Caveat, CATEGORY, ChartBox, COLOR, N, Segmented, Select, tooltipProps } from '../ui';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

/** Bedroom bins for entire homes; studios count with one bedroom. */
const BEDROOM_BINS = ['1', '2', '3', '4+'] as const;
type BedroomBin = (typeof BEDROOM_BINS)[number];

const BEDROOM_BIN_SQL = `CASE
  WHEN l.bedrooms ILIKE 'studio%' OR l.bedroom_count <= 1 THEN '1'
  WHEN l.bedroom_count = 2 THEN '2'
  WHEN l.bedroom_count = 3 THEN '3'
  WHEN l.bedroom_count >= 4 THEN '4+'
END`;

/**
 * Monthly long-term rent by bedrooms, editable. The defaults are HUD's
 * FY2026 Fair Market Rents for the Anchorage HUD Metro FMR Area (studio and
 * 1 bedroom are averaged into '1'); the reader can replace them with market
 * figures.
 */
const DEFAULT_RENT: Record<BedroomBin, number> = { '1': 1200, '2': 1631, '3': 2268, '4+': 2736 };

/** The default share of STR revenue spent running it: cleaning, supplies, platform fee, management. */
const DEFAULT_COST_SHARE = 0.3;

type View = 'compare' | 'scatter' | 'owner';
interface VisualState {
  view: View;
  month: string;
}

const rentCase = (rent: Record<BedroomBin, number>) => `CASE
  WHEN l.bedrooms ILIKE 'studio%' OR l.bedroom_count <= 1 THEN ${rent['1']}
  WHEN l.bedroom_count = 2 THEN ${rent['2']}
  WHEN l.bedroom_count = 3 THEN ${rent['3']}
  WHEN l.bedroom_count >= 4 THEN ${rent['4+']}
END`;

const entireHomesSql = (where: string, month: string, col: string, rent: Record<BedroomBin, number>, costShare: number) => `
  SELECT m.listing_id, l.name, ${BEDROOM_BIN_SQL} AS bedroom_bin,
    coalesce(m.${col}, 0) * ${1 - costShare} AS str_net,
    ${rentCase(rent)} AS rent,
    l.owner_occupied_exemption, l.owner_name IS NOT NULL AS has_parcel
  FROM est_listing_months m JOIN est_listings l USING (listing_id)
  WHERE m.month = DATE '${month}' AND l.listing_kind = 'Entire home'
    AND ${where}
    AND ${BEDROOM_BIN_SQL} IS NOT NULL
`;

export const Incentives: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const [rent, setRent] = useState(DEFAULT_RENT);
  const [costShare, setCostShare] = useState(DEFAULT_COST_SHARE);

  const { row: s } = useRow<{ homes: number; beatsRent: number; beatsRentHigh: number; ownerOcc: number; withParcel: number }>(
    `WITH h AS (${entireHomesSql('true', focus, 'revenue', rent, costShare)}),
     hi AS (${entireHomesSql('true', focus, 'revenue_high', rent, costShare)})
     SELECT count(*)::INT AS homes,
       count(*) FILTER (WHERE str_net > rent) / count(*) AS "beatsRent",
       (SELECT count(*) FILTER (WHERE str_net > rent) / count(*) FROM hi) AS "beatsRentHigh",
       count(*) FILTER (WHERE owner_occupied_exemption)::INT AS "ownerOcc",
       count(*) FILTER (WHERE has_parcel)::INT AS "withParcel"
     FROM h`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';

  const assumptions = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-muted-foreground">Long-term rent per month, by bedrooms:</span>
      {BEDROOM_BINS.map((b) => (
        <label key={b} className="flex items-center gap-1">
          {b}
          <input
            type="number"
            step={50}
            value={rent[b]}
            onChange={(e) => setRent({ ...rent, [b]: Number(e.target.value) || 0 })}
            className="bg-background w-16 rounded-md border px-1 py-0.5 tabular-nums"
          />
        </label>
      ))}
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">Airbnb running costs</span>
        <input
          type="range"
          min={0}
          max={0.6}
          step={0.05}
          value={costShare}
          onChange={(e) => setCostShare(Number(e.target.value))}
        />
        <span className="w-8 tabular-nums">{pct1(costShare)}</span>
      </label>
    </div>
  );

  return (
    <Chapter
      id="q6"
      title="Would owners earn more renting long-term?"
      lede={
        <>
          An owner can rent a home to visitors, rent it to someone who lives here, or live in it themselves.
          Rules meant to move homes from one use to another work by changing which choice pays better. Here we
          compare what an entire home earned on Airbnb, minus the costs of running it, with what it would rent for
          to a long-term tenant. You can change both of those figures above the chart.
        </>
      }
      steps={[
        <>
          In <N>{month}</N>, after {pct1(costShare)} for running costs, <N>{pct1(s?.beatsRent)}</N> of{' '}
          {int(s?.homes)} entire homes earned more on Airbnb than a long-term tenant would have paid. Under the high
          estimate, <N>{pct1(s?.beatsRentHigh)}</N> did.
          <Caveat>
            {month} is a quiet month for tourism. The real comparison is a full year on Airbnb against a full year
            of rent, which needs a summer of records; we started in September 2026.
          </Caveat>
        </>,
        <>
          Each dot is one entire home. Dots above the dashed line earned more on Airbnb that month than the rent we
          assumed. Homes near the line are the ones a new fee, tax or limit on nights would tip one way or the
          other.
        </>,
        <>
          Some owners live on the property. <N>{int(s?.ownerOcc)}</N> of the {int(s?.withParcel)} entire homes we can
          match to an owner are on property the owner claims as their home. They are renting part of where they
          live, which is a different choice from renting out a house nobody lives in.
          <Caveat>
            We can find the owner only for listings that show a Muni registration. The homeowner claim covers the
            whole property, so in a duplex or condo building the owner may live in one unit and rent another.
          </Caveat>
        </>,
      ]}
      visual={(step) => (
        <Visual step={step} focusMonth={focus} rent={rent} costShare={costShare} assumptions={assumptions} />
      )}
    />
  );
};

const Visual: FC<{
  step: number;
  focusMonth: string;
  rent: Record<BedroomBin, number>;
  costShare: number;
  assumptions: ReactNode;
}> = ({ step, focusMonth, rent, costShare, assumptions }) => {
  const months = useStartedMonths();
  const { state, update, exploring, reset } = useStepState<VisualState>(step, [
    { view: 'compare', month: focusMonth },
    { view: 'scatter', month: focusMonth },
    { view: 'owner', month: focusMonth },
  ]);
  const props = { state, rent, costShare };
  return (
    <XfProvider chapterId="q6" month={state.month}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <>
            <Segmented
              value={state.view}
              options={[
                { value: 'compare', label: 'By bedrooms' },
                { value: 'scatter', label: 'Each home' },
                { value: 'owner', label: 'Owner lives there?' },
              ]}
              onChange={(view) => update({ view })}
            />
            <Select
              label="Month"
              value={state.month}
              options={months.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(month) => update({ month })}
            />
            <div className="basis-full">{assumptions}</div>
          </>
        }
        chart={
          state.view === 'compare' ? <Compare {...props} /> : state.view === 'scatter' ? <EachHome {...props} /> : <ResidentOwners {...props} />
        }
        caption={CAPTION}
        side={<XfSide mapColor={{ field: 'owner lives there?', type: 'categorical', scheme: 'Set2', title: 'Owner lives there?' }} columns={TABLE_COLUMNS.incentive} />}
      />
    </XfProvider>
  );
};

interface PanelProps {
  state: VisualState;
  rent: Record<BedroomBin, number>;
  costShare: number;
}

const CAPTION = (
  <>
    Airbnb earnings minus running costs (cleaning, supplies, Airbnb's fee, management), before mortgage,
    property tax and insurance, which an owner pays either way. The starting rents are the federal
    government's (HUD) 2026 fair market rents for Anchorage; replace them with rents you know.
  </>
);

const Compare: FC<PanelProps> = ({ state, rent, costShare }) => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ bin: string; homes: number; p20: number; p50: number; p80: number; rent: number; beats: number }>(
    `SELECT bedroom_bin AS bin, count(*)::INT AS homes,
       quantile_cont(str_net, 0.2) AS p20, quantile_cont(str_net, 0.5) AS p50, quantile_cont(str_net, 0.8) AS p80,
       any_value(rent) AS rent, count(*) FILTER (WHERE str_net > rent) / count(*) AS beats
     FROM (${entireHomesSql(selectedListingsSql(xf, 'l'), state.month, revenueCol(model), rent, costShare)})
     GROUP BY bedroom_bin ORDER BY bedroom_bin`,
    { enabled: !!state.month },
  );
  const data = rows.map((r) => ({ ...r, label: `${r.bin === '1' ? 'Studio or 1' : r.bin} bedroom${r.bin === '1' ? '' : 's'} (${r.homes})`, err: [r.p50 - r.p20, r.p80 - r.p50] }));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={52} tickFormatter={(n: number) => money(n, true)} />
          <Tooltip
            {...tooltipProps}
            content={({ payload }) => {
              const r = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!r) return null;
              return (
                <div className="bg-popover rounded-md border p-2 text-xs shadow">
                  <div className="font-medium">{r.bin === '1' ? 'Studio or 1' : r.bin}-bedroom entire homes</div>
                  <div>Typical Airbnb earnings after costs {money(r.p50)} (middle 60%: {money(r.p20)} – {money(r.p80)})</div>
                  <div>Long-term rent {money(r.rent)}</div>
                  <div>{pct1(r.beats)} of {r.homes} earned more than the rent</div>
                </div>
              );
            }}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="p50" name="Typical Airbnb earnings after costs (line: middle 60%)" fill={COLOR.booked} isAnimationActive={false}>
            <ErrorBar dataKey="err" width={6} stroke="hsl(var(--foreground))" strokeOpacity={0.6} />
          </Bar>
          <Bar dataKey="rent" name="Long-term rent" fill={COLOR.available} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const EachHome: FC<PanelProps> = ({ state, rent, costShare }) => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ name: string; bin: string; rent: number; strNet: number }>(
    `SELECT name, bedroom_bin AS bin, rent, str_net AS "strNet"
     FROM (${entireHomesSql(selectedListingsSql(xf, 'l'), state.month, revenueCol(model), rent, costShare)})`,
    { enabled: !!state.month },
  );
  const xMax = Math.max(...Object.values(rent)) * 1.25;
  const max = xMax * 2.5;
  const byBin = BEDROOM_BINS.map((b) => rows.filter((r) => r.bin === b).map((r) => ({ ...r, strNet: Math.min(r.strNet, max) })));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart margin={{ top: 8, right: 8, bottom: 16, left: 8 }}>
          <CartesianGrid stroke="hsl(var(--border))" />
          <XAxis
            type="number"
            dataKey="rentJ"
            domain={[0, xMax]}
            allowDataOverflow
            {...axisProps}
            tickFormatter={(n: number) => money(n, true)}
            label={{ value: 'Long-term rent', position: 'insideBottom', offset: -8, fontSize: 11 }}
          />
          <YAxis type="number" dataKey="strNet" domain={[0, max]} {...axisProps} width={52} tickFormatter={(n: number) => money(n, true)} />
          <Tooltip
            {...tooltipProps}
            content={({ payload }) => {
              const r = payload?.[0]?.payload as { name: string; strNet: number; rent: number } | undefined;
              if (!r) return null;
              return (
                <div className="bg-popover rounded-md border p-2 text-xs shadow">
                  <div className="font-medium">{r.name}</div>
                  <div>Airbnb after costs {money(r.strNet)} · rent {money(r.rent)}</div>
                </div>
              );
            }}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Scatter
            data={[{ rentJ: 0, strNet: 0 }, { rentJ: xMax, strNet: xMax }]}
            line={{ stroke: 'hsl(var(--foreground))', strokeDasharray: '4 3' }}
            shape={() => <g />}
            legendType="none"
            isAnimationActive={false}
          />
          {byBin.map((pts, i) => (
            <Scatter
              key={BEDROOM_BINS[i]}
              name={`${BEDROOM_BINS[i]} bd`}
              data={pts.map((p, j) => ({ ...p, rentJ: p.rent + (((j * 37) % 100) - 50) * (p.rent / 900) }))}
              fill={CATEGORY[i]}
              fillOpacity={0.55}
              r={2}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const ResidentOwners: FC<PanelProps> = ({ state, rent, costShare }) => {
  const xf = useXf();
  const { model } = useStory();
  const { rows, isLoading, error } = useRows<{ group: string; homes: number; p50: number; beats: number }>(
    `SELECT CASE WHEN NOT has_parcel THEN 'Owner not known' WHEN owner_occupied_exemption THEN 'Owner lives there' ELSE 'Owner lives elsewhere' END AS "group",
       count(*)::INT AS homes, median(str_net) AS p50, count(*) FILTER (WHERE str_net > rent) / count(*) AS beats
     FROM (${entireHomesSql(selectedListingsSql(xf, 'l'), state.month, revenueCol(model), rent, costShare)})
     GROUP BY ALL ORDER BY homes DESC`,
    { enabled: !!state.month },
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" {...axisProps} />
          <YAxis type="category" dataKey="group" {...axisProps} width={170} />
          <Tooltip
            {...tooltipProps}
            content={({ payload }) => {
              const r = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              if (!r) return null;
              return (
                <div className="bg-popover rounded-md border p-2 text-xs shadow">
                  <div className="font-medium">{r.group}</div>
                  <div>{int(r.homes)} entire homes</div>
                  <div>Typical Airbnb earnings after costs {money(r.p50)}</div>
                  <div>{pct1(r.beats)} earned more than the rent</div>
                </div>
              );
            }}
          />
          <Bar dataKey="homes" name="Entire homes" fill={CATEGORY[0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};
