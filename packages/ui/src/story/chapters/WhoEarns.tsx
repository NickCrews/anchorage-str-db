import { useMemo, type FC } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { int, money, monthName, pct1 } from '../../format';
import { useRow, useRows } from '../../lib/query';
import { Chapter, ChapterGrid, useStepState } from '../Chapter';
import { useStory } from '../context';
import { useStartedMonths } from '../hooks';
import { listingMonthsSql } from '../sql';
import { revenueCol } from '../model';
import { axisProps, Caveat, CATEGORY, ChartBox, N, Segmented, Select, tooltipProps } from '../ui';
import { predicateWithout, selectedValue, toggleEqualsClause } from '../xf/clause';
import { selectedListingsSql, useXf } from '../xf/context';
import { TABLE_COLUMNS } from '../xf/table';
import { XfProvider } from '../xf/XfProvider';
import { XfSide } from '../xf/XfSide';

const MAILING = ['In the Muni', 'Elsewhere in Alaska', 'Outside Alaska'] as const;

type View = 'groups' | 'owners';
interface VisualState {
  view: View;
  month: string;
  metric: 'listings' | 'revenue';
}

export const WhoEarns: FC = () => {
  const { meta } = useStory();
  const focus = meta?.focusMonthSql ?? '';
  const { row: s } = useRow<{
    listings: number;
    matched: number;
    muniIndividual: number;
    company: number;
    companyRevenue: number;
    outside: number;
    outsideRevenue: number;
  }>(
    `WITH m AS (${listingMonthsSql(focus)}),
     k AS (SELECT * FROM m WHERE owner_kind <> 'Unknown')
     SELECT (SELECT count(*) FROM m)::INT AS listings, count(*)::INT AS matched,
       count(*) FILTER (WHERE owner_kind = 'Individual' AND owner_mailing = 'In the Muni') / count(*) AS "muniIndividual",
       count(*) FILTER (WHERE owner_kind = 'Company') / count(*) AS company,
       sum(revenue) FILTER (WHERE owner_kind = 'Company') / sum(revenue) AS "companyRevenue",
       count(*) FILTER (WHERE owner_mailing <> 'In the Muni') / count(*) AS outside,
       sum(revenue) FILTER (WHERE owner_mailing <> 'In the Muni') / sum(revenue) AS "outsideRevenue"
     FROM k`,
    { enabled: !!focus },
  );
  const month = meta ? monthName(meta.focusMonth) : '…';
  return (
    <Chapter
      id="q10"
      title="Who earns the money?"
      lede={
        <>
          The Muni's property records name each property's owner and the address where its tax bill is sent.
          That tells us whether the owner is a person, a family trust or a company, and roughly where they are. We
          can find the owner only for listings that show a Muni registration.
        </>
      }
      steps={[
        <>
          We found the owner for <N>{int(s?.matched)}</N> of {int(s?.listings)} listings. Of those,{' '}
          <N>{pct1(s?.muniIndividual)}</N> are owned by people whose tax bill goes to an address in the
          Municipality.
        </>,
        <>
          Companies (LLCs, corporations, partnerships) own <N>{pct1(s?.company)}</N> of those listings and earned{' '}
          <N>{pct1(s?.companyRevenue)}</N> of their money in <N>{month}</N>. Click a bar to see their listings.
        </>,
        <>
          Owners whose tax bill goes outside the Municipality hold <N>{pct1(s?.outside)}</N> of the listings and earned{' '}
          <N>{pct1(s?.outsideRevenue)}</N> of the money. Much of what they earn likely leaves the local economy.
          <Caveat>
            A mailing address is where the tax bill goes, not proof of where someone lives: a local owner can use an
            out-of-state address, and an out-of-town owner can use a local manager's.
          </Caveat>
        </>,
        <>
          The owners with the most listings. Names are as the Muni records them, so one owner may appear under
          several spellings.
          <Caveat>
            The owner isn't always who runs the listing: a management company can run many owners' homes under
            one Airbnb account.
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
    { view: 'groups', month: focusMonth, metric: 'listings' },
    { view: 'groups', month: focusMonth, metric: 'revenue' },
    { view: 'groups', month: focusMonth, metric: 'revenue' },
    { view: 'owners', month: focusMonth, metric: 'listings' },
  ]);
  return (
    <XfProvider chapterId="q10" month={state.month}>
      <ChapterGrid
        exploring={exploring}
        onReset={reset}
        controls={
          <>
            <Segmented
              value={state.view}
              options={[
                { value: 'groups', label: 'Kinds of owner' },
                { value: 'owners', label: 'Biggest owners' },
              ]}
              onChange={(view) => update({ view })}
            />
            {state.view === 'groups' && (
              <Segmented
                label="Count"
                value={state.metric}
                options={[
                  { value: 'listings', label: 'Listings' },
                  { value: 'revenue', label: 'Earnings' },
                ]}
                onChange={(metric) => update({ metric })}
              />
            )}
            <Select
              label="Month"
              value={state.month}
              options={months.map((m) => ({ value: m.value, label: m.label }))}
              onChange={(month) => update({ month })}
            />
          </>
        }
        chart={state.view === 'groups' ? <Groups state={state} /> : <Owners state={state} />}
        caption={
          state.view === 'groups'
            ? 'Click a bar to filter. A company is an owner named as an LLC, corporation, partnership or similar; a trust is named as a trust.'
            : "Owner names as the Muni's assessor records them; one owner may be spelled several ways."
        }
        side={<XfSide mapColor={{ field: "owner's mail goes to", type: 'categorical', scheme: 'Set1', title: "Owner's tax bill goes to" }} columns={TABLE_COLUMNS.owners} />}
      />
    </XfProvider>
  );
};

interface PanelProps {
  state: VisualState;
}

/** The owner-group chart's identity as a clause source in the chapter selection. */
const KIND_SOURCE = { name: 'owner-kind-bars' };

const Groups: FC<PanelProps> = ({ state }) => {
  const xf = useXf();
  const { model } = useStory();
  const col = revenueCol(model);
  const value = state.metric === 'listings' ? 'count(*)' : `coalesce(sum(${col}), 0)`;
  const { rows, isLoading, error } = useRows<{ kind: string; mailing: string; v: number }>(
    `SELECT owner_kind AS kind, owner_mailing AS mailing, ${value} AS v
     FROM (${listingMonthsSql(state.month, `l.listing_id IN (SELECT listing_id::BIGINT FROM ${xf.table} WHERE ${predicateWithout(xf, KIND_SOURCE)})`)})
     WHERE owner_kind <> 'Unknown' GROUP BY ALL`,
  );
  const data = useMemo(
    () =>
      ['Individual', 'Trust', 'Company'].map((kind) => {
        const entry: Record<string, string | number> = { kind };
        for (const m of MAILING) entry[m] = rows.find((r) => r.kind === kind && r.mailing === m)?.v ?? 0;
        return entry;
      }),
    [rows],
  );
  const picked = selectedValue(xf.selection, KIND_SOURCE);
  const fmt = (v: number) => (state.metric === 'listings' ? int(v) : money(v, true));
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="kind" {...axisProps} />
          <YAxis {...axisProps} width={52} tickFormatter={(n: number) => fmt(n)} />
          <Tooltip {...tooltipProps} formatter={(v) => fmt(v as number)} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          {MAILING.map((m, i) => (
            <Bar
              key={m}
              dataKey={m}
              name={`Tax bill goes ${m.toLowerCase().replace('in the muni', 'to the Muni').replace('elsewhere in alaska', 'elsewhere in Alaska').replace('outside alaska', 'outside Alaska')}`}
              stackId="a"
              fill={CATEGORY[[0, 3, 1][i] ?? 0]}
              cursor="pointer"
              onClick={(d: { kind?: string }) => toggleEqualsClause(xf.selection, KIND_SOURCE, 'owner type', d.kind ?? null)}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={String(d.kind)} fillOpacity={picked && picked !== d.kind ? 0.3 : 1} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartBox>
  );
};

const Owners: FC<PanelProps> = ({ state }) => {
  const xf = useXf();
  const { model } = useStory();
  const col = revenueCol(model);
  const { rows, isLoading, error } = useRows<{ owner: string; kind: string; mailing: string; listings: number; parcels: number; revenue: number }>(
    `SELECT owner_name AS owner, any_value(owner_kind) AS kind, any_value(owner_city || ', ' || owner_state) AS mailing,
       count(*)::INT AS listings, count(DISTINCT parcel_id)::INT AS parcels, coalesce(sum(${col}), 0) AS revenue
     FROM (${listingMonthsSql(state.month, selectedListingsSql(xf, 'l'))}) WHERE owner_name IS NOT NULL
     GROUP BY owner_name ORDER BY listings DESC, revenue DESC LIMIT 40`,
  );
  return (
    <ChartBox isLoading={isLoading} error={error}>
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-card text-muted-foreground sticky top-0 text-left">
            <tr>
              <th className="py-1 pr-2 font-normal">Owner of record</th>
              <th className="py-1 pr-2 font-normal">Tax bill goes to</th>
              <th className="py-1 pr-2 text-right font-normal">Listings</th>
              <th className="py-1 pr-2 text-right font-normal">Properties</th>
              <th className="py-1 text-right font-normal">Earned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.owner} className="border-t">
                <td className="py-1 pr-2">
                  {r.owner} <span className="text-muted-foreground">· {r.kind}</span>
                </td>
                <td className="py-1 pr-2">{r.mailing}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.listings}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{r.parcels}</td>
                <td className="py-1 text-right tabular-nums">{money(r.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartBox>
  );
};
