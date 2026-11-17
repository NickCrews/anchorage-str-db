import { useMemo, useState, type FC } from 'react';
import { DataStatusGate } from '../components/DataStatusGate';
import { int, longDate, shortDate } from '../format';
import { useRow, useRows } from '../lib/query';
import { REPO_URL } from '../story/Methodology';
import { AT_ADDRESS_METERS, FAR_METERS, PROBLEMS, PROBLEMS_SQL, type ProblemKey, type ProblemRow } from './sql';

const STORY_URL = import.meta.env.BASE_URL;

/**
 * Every active Airbnb listing with a registration problem, grouped by
 * problem, with what it means and what would fix it, as a table a reader
 * can filter, search and download.
 */
export const RegistrationProblems: FC = () => (
  <DataStatusGate>
    <main className="bg-background h-full overflow-y-auto">
      <header className="bg-background/95 sticky top-0 z-40 flex h-12 items-center gap-3 border-b px-4 backdrop-blur lg:px-8">
        <a href={STORY_URL} className="text-sm font-semibold">
          Anchorage short-term rentals
        </a>
        <span className="text-muted-foreground text-sm">/ Registration problems</span>
      </header>
      <Body />
      <footer className="text-muted-foreground border-t px-4 py-10 text-center text-sm lg:px-8">
        The code and the full database behind this page are public on{' '}
        <a className="underline" href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </footer>
    </main>
  </DataStatusGate>
);

const Body: FC = () => {
  const { rows, isLoading, error } = useRows<ProblemRow>(PROBLEMS_SQL);
  const { row: dates } = useRow<{ airbnb: number | null; licenses: number | null; active: number }>(
    `SELECT
       (SELECT last_success_date FROM source_freshness WHERE source = 'airbnb') AS airbnb,
       (SELECT last_success_date FROM source_freshness WHERE source = 'muni_licenses') AS licenses,
       (SELECT count(*)::INT FROM listings_active) AS active`,
  );
  const [picked, setPicked] = useState<ProblemKey | null>(null);
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    const out = new Map<ProblemKey, number>();
    for (const r of rows) out.set(r.problem, (out.get(r.problem) ?? 0) + 1);
    return out;
  }, [rows]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!picked || r.problem === picked) &&
        (!needle ||
          [r.listing, r.host, r.registration_id, r.registrant, r.registered_address].some((v) => v?.toLowerCase().includes(needle))),
    );
  }, [rows, picked, search]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 lg:px-8">
      <h1 className="text-3xl font-semibold tracking-tight">Airbnb listings with a registration problem</h1>
      <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
        Since July 31, 2026, every short-term rental in the Municipality of Anchorage must show its STR
        registration id on every listing. This page lists the active Airbnb listings where that id is missing, not
        on file with the Muni, lapsed, or registered somewhere else. Each is a lead to check, not a finding: a
        listing can be correct in ways this data cannot see.
      </p>
      <p className="text-muted-foreground mt-3 text-sm">
        Airbnb read <strong className="text-foreground">{dates?.airbnb ? longDate(dates.airbnb) : '…'}</strong>
        {' · '}Muni license pages read{' '}
        <strong className="text-foreground">{dates?.licenses ? longDate(dates.licenses) : '…'}</strong>
        {' · '}
        <strong className="text-foreground">{int(isLoading ? null : rows.length)}</strong> of{' '}
        <strong className="text-foreground">{int(dates?.active)}</strong> active listings
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PROBLEMS.map((p) => {
          const on = picked === p.key;
          return (
            <button
              key={p.key}
              onClick={() => setPicked(on ? null : p.key)}
              aria-pressed={on}
              className={
                'flex flex-col rounded-lg border p-3 text-left transition-colors ' +
                (on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60')
              }
            >
              <span className="text-2xl font-semibold tabular-nums">{isLoading ? '…' : int(counts.get(p.key) ?? 0)}</span>
              <span className="text-sm font-medium">{p.title}</span>
              <span className="text-muted-foreground mt-1.5 text-xs leading-snug">{p.meaning}</span>
              <span className="mt-1.5 text-xs leading-snug">
                <span className="text-muted-foreground">Fix: </span>
                {p.fix}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-2 text-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search listing, host, id, registrant or address"
          className="bg-background min-w-0 flex-1 basis-64 rounded-md border px-2.5 py-1.5"
        />
        {picked && (
          <button className="hover:bg-muted rounded-md border px-2.5 py-1.5" onClick={() => setPicked(null)}>
            Show every problem
          </button>
        )}
        <button className="hover:bg-muted rounded-md border px-2.5 py-1.5" onClick={() => downloadCsv(shown)} disabled={!shown.length}>
          Download CSV
        </button>
        <span className="text-muted-foreground">{int(shown.length)} listings</span>
      </div>

      {error ? (
        <pre className="text-destructive mt-4 text-xs whitespace-pre-wrap">{error.message}</pre>
      ) : (
        <ProblemTable rows={shown} isLoading={isLoading} />
      )}

      <section className="text-muted-foreground mt-10 max-w-3xl space-y-3 text-sm leading-relaxed">
        <h2 className="text-foreground text-base font-semibold">How listings are sorted</h2>
        <p>
          Each listing gets the first problem that applies, in the order of the cards above. Distance is from
          Airbnb's coordinate for the listing to the Muni geocoder's coordinate for the registered address. Airbnb
          offsets about half of its coordinates by up to about 200 m for privacy, so a listing counts as at the
          registered address within {AT_ADDRESS_METERS} m and somewhere else beyond {FAR_METERS} m. Listings between
          the two, and listings whose registration the geocoder could not place, are not flagged.
        </p>
        <p>
          An id not on file that is higher than the newest id on file may simply be newer than our last read of the
          Muni's license pages; the table marks those.
        </p>
        <p>
          The Muni takes reports through the Code Enforcement Hotline (907-343-4141) or ANCWorks, and registration
          questions at MuniLicenses@anchorageak.gov (907-343-4311).
        </p>
      </section>
    </div>
  );
};

const ProblemTable: FC<{ rows: ProblemRow[]; isLoading: boolean }> = ({ rows, isLoading }) => (
  <div className="mt-3 overflow-x-auto rounded-lg border">
    <table className="w-full text-left text-sm">
      <thead className="bg-muted/60 text-muted-foreground text-xs">
        <tr>
          <th className="px-3 py-2 font-medium">Problem</th>
          <th className="px-3 py-2 font-medium">Listing</th>
          <th className="px-3 py-2 font-medium">Host</th>
          <th className="px-3 py-2 font-medium">Id shown</th>
          <th className="px-3 py-2 font-medium">Registered to</th>
          <th className="px-3 py-2 text-right font-medium">Distance</th>
          <th className="px-3 py-2 text-right font-medium">Listings showing the id</th>
        </tr>
      </thead>
      <tbody>
        {isLoading ? (
          <tr>
            <td colSpan={7} className="text-muted-foreground px-3 py-6 text-center">
              Loading…
            </td>
          </tr>
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={7} className="text-muted-foreground px-3 py-6 text-center">
              No listings match.
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.listing_id} className="border-t align-top">
              <td className="px-3 py-2 whitespace-nowrap">{r.problem}</td>
              <td className="max-w-72 px-3 py-2">
                <a className="underline" href={r.url ?? undefined} target="_blank" rel="noreferrer">
                  {r.listing ?? r.listing_id}
                </a>
                <div className="text-muted-foreground text-xs">
                  {r.listing_type}
                  {r.first_seen_date != null && ` · on Airbnb since ${shortDate(r.first_seen_date)}`}
                </div>
              </td>
              <td className="px-3 py-2">
                {r.host_id ? (
                  <a className="underline" href={`https://www.airbnb.com/users/show/${r.host_id}`} target="_blank" rel="noreferrer">
                    {r.host}
                  </a>
                ) : (
                  r.host
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {r.registration_id == null ? (
                  <span className="text-muted-foreground">none</span>
                ) : r.status_url ? (
                  <a className="underline" href={r.status_url} target="_blank" rel="noreferrer">
                    {r.registration_id}
                  </a>
                ) : (
                  r.registration_id
                )}
                {r.newer_than_newest && <div className="text-muted-foreground text-xs">newer than any on file</div>}
                {r.problem === 'Lapsed' && r.registration_status && (
                  <div className="text-muted-foreground text-xs">{r.registration_status}</div>
                )}
              </td>
              <td className="max-w-64 px-3 py-2">
                {r.registrant}
                {r.registered_address && <div className="text-muted-foreground text-xs">{r.registered_address}</div>}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{distance(r.meters)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.registration_id ? int(r.listings_showing) : ''}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

const distance = (meters: number | null) =>
  meters == null ? '' : meters < 1000 ? `${int(meters)} m` : `${(meters / 1000).toFixed(1)} km`;

const CSV_COLUMNS: (keyof ProblemRow)[] = [
  'problem',
  'listing_id',
  'listing',
  'url',
  'listing_type',
  'host_id',
  'host',
  'registration_id',
  'registration_status',
  'registrant',
  'registered_address',
  'status_url',
  'meters',
  'location_is_exact',
  'listings_showing',
  'newer_than_newest',
];

function downloadCsv(rows: ProblemRow[]) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'registration_problems.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
