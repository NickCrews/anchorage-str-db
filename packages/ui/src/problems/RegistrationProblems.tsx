import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { DataStatusGate } from '../components/DataStatusGate';
import { int, isoDate, longDate } from '../format';
import { useRow, useRows } from '../lib/query';
import { REPO_URL } from '../story/Methodology';
import { caseText, classify, distance, PROBLEM_LABEL, PROBLEMS, sortCases, title, type Case, type Problem } from './problems';
import { CASES_SQL, FAR_METERS, NEAR_METERS, SUMMARY_SQL, type CaseRow, type SummaryRow } from './sql';
import './problems.css';

const STORY_URL = import.meta.env.BASE_URL;
const PROGRAM_URL = 'https://www.muni.org/Departments/Assembly/Clerk/Licensing/Pages/Short-Term-Rental-Registration-Program.aspx';
const ANCWORKS_URL = 'https://www.muni.org/anchorageworks/CRM/ServiceRequest/ServiceRequestCategory';

const date = (epochMs: number | null | undefined) => (epochMs == null ? '' : longDate(epochMs));
const pinLabel = (exact: boolean) => (exact ? 'Exact' : 'Approximate');
const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

/**
 * Every active Airbnb listing with a registration problem: the kinds of
 * problem with an example of each, a table of every case, and each case on a
 * map beside the listing and its registration. Laid out like the report in
 * docs/research/registration-location-mismatch.
 */
export const RegistrationProblems: FC = () => (
  <div className="report">
    <DataStatusGate>
      <Report />
    </DataStatusGate>
  </div>
);

const Report: FC = () => {
  const { rows, isLoading, error } = useRows<CaseRow>(CASES_SQL);
  const { row: summary } = useRow<SummaryRow>(SUMMARY_SQL);
  const cases = useMemo(() => sortCases(rows.map(classify)), [rows]);
  const [current, setCurrent] = useState(() => {
    const fromHash = /^#case-(\d+)$/.exec(location.hash);
    return fromHash ? Number(fromHash[1]) - 1 : 0;
  });
  const viewerRef = useRef<HTMLHeadingElement | null>(null);
  const index = Math.min(Math.max(current, 0), Math.max(cases.length - 1, 0));

  const show = (i: number, scroll = false) => {
    setCurrent(i);
    history.replaceState(null, '', `#case-${i + 1}`);
    if (scroll) viewerRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  if (error) return <pre className="muted">{error.message}</pre>;

  return (
    <main>
      <a className="back" href={STORY_URL}>
        ← Anchorage short-term rentals
      </a>
      <h1>Airbnb listings with a registration problem</h1>
      <p className="dateline">
        Airbnb listings as of {date(summary?.listing_date) || '…'}. Registrations as of the Municipal Clerk's license
        pages read {date(summary?.license_date) || '…'}.
      </p>

      <section>
        <p>
          Since July 31, 2026, every short-term rental in the Municipality must show its STR Registration Number on
          its listings. Each registration records the street address of the rental (AMC 10.90.020), so the id on a
          listing should lead to the place being rented.
        </p>
        <p>
          {isLoading || !summary
            ? '…'
            : `On ${date(summary.listing_date)}, ${int(cases.length)} of ${int(summary.active)} active Airbnb listings had a registration problem: ` +
              `no id, an id the Muni has no record of, a lapsed registration, or a registration more than ${distance(FAR_METERS)} from the listing. ` +
              `Airbnb blurs map locations by up to about 200 m, so a listing that far from its registered address is somewhere else.`}
        </p>
        <p>
          Each case is a lead to check, not a finding: a listing can be right in ways this data cannot see. Every case
          below links to the Airbnb listing and the registration's license page, and shows both on a map.
        </p>
      </section>

      <section>
        <h2>Six kinds of problem</h2>
        <div className="kinds">
          {PROBLEMS.map((p) => {
            const matching = cases.filter((c) => c.problem === p.key);
            const example = matching.find((c) => c.registration_id === p.example) ?? (p.example ? matching[0] : undefined);
            return (
              <article key={p.key} className={`kind f-${p.key}`}>
                <div className="kind-count">
                  <b>{isLoading ? '…' : int(matching.length)}</b>
                  {matching.length === 1 ? 'listing' : 'listings'}
                </div>
                <h3>{p.label}</h3>
                <p>{p.description}</p>
                {example ? (
                  <p className="example">
                    <strong>Example:</strong> {caseText(example)}{' '}
                    <a
                      href={`#case-${cases.indexOf(example) + 1}`}
                      onClick={(e) => {
                        e.preventDefault();
                        show(cases.indexOf(example), true);
                      }}
                    >
                      See it on the map
                    </a>
                  </p>
                ) : (
                  <span className="spacer" />
                )}
                <p className="fix">
                  <strong>Suggested fix:</strong> {p.fix}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <CaseTable cases={cases} current={index} isLoading={isLoading} onPick={(i) => show(i, true)} listingDate={summary?.listing_date ?? null} />

      <section className="viewer-section">
        <h2 ref={viewerRef}>Case by case</h2>
        {cases.length > 0 && <Viewer cases={cases} index={index} onShow={(i) => show(i)} />}
      </section>

      <section>
        <h2>How the cases were found</h2>
        <p>
          <strong>Sources.</strong> Airbnb listings are read daily from Airbnb's public search and listing pages, most
          recently on {date(summary?.listing_date) || '…'}. Each listing page shows the registration id the host
          entered and a map location. Registrations come from the Municipal Clerk's public license pages, read{' '}
          {date(summary?.license_date) || '…'}, and each registered address is placed by the Muni's geocoder.
        </p>
        <p>
          <strong>Distance.</strong> For each active listing that shows the id of an active, geocoded registration, we
          measured the distance from Airbnb's map location to the registered address's geocoded point. Airbnb moves
          most pins by up to about 200 m to hide the exact address; some pins are exact.
          {summary &&
            ` Of the ${int(summary.compared)} listings compared, ${int(summary.within_200_m)} are within 200 m, ` +
              `${int(summary.from_200_to_500_m)} are between 200 m and 500 m, ${int(summary.from_500_m_to_1_km)} are between 500 m and 1 km, ` +
              `and ${int(summary.over_1_km)} are more than 1 km away.`}{' '}
          A listing more than {distance(FAR_METERS)} from its registered address is not explained by Airbnb's offset.
        </p>
        <p>
          <strong>Problems.</strong> Each listing is given the first of these that applies:
        </p>
        <ol>
          <li>
            <Tag problem="no-id" /> The listing shows no registration id.
          </li>
          <li>
            <Tag problem="not-on-file" /> No license page the Muni publishes holds the id.
          </li>
          <li>
            <Tag problem="lapsed" /> The registration's STR Certificate is not Active.
          </li>
          <li>
            <Tag problem="wrong-id" /> The listing is more than {distance(FAR_METERS)} from its registered address, and a
            different registration within {NEAR_METERS} m of the listing has a business name that matches the shown
            registration's business name, the Airbnb host's name, or the start of the listing's title. Names are
            compared ignoring case, punctuation and "LLC". A street named in the title, or an id one digit off from the
            shown one, is noted as extra evidence but is not enough by itself.
          </li>
          <li>
            <Tag problem="second-place" /> The listing is more than {distance(FAR_METERS)} from its registered address, and
            another listing showing the same id is within {distance(FAR_METERS)} of it.
          </li>
          <li>
            <Tag problem="not-at-address" /> The listing is more than {distance(FAR_METERS)} from its registered address,
            and neither of the above.
          </li>
        </ol>
        <p>
          The same name match suggests a registration for listings with no id or an id not on file, in the table's
          last column.
        </p>
        <p>
          <strong>Limits.</strong> A host can place an Airbnb pin incorrectly, and the Muni's geocoder can place a
          typed address incorrectly; the registered and geocoded addresses are both shown for each case. Name matches
          are suggestions for review, not confirmations. Listings between 200 m and {distance(FAR_METERS)} from their
          registration, and listings whose registration the geocoder could not place, are not included.
        </p>
        <p>
          <strong>Reporting.</strong> The Muni takes complaints about a rental through{' '}
          <a href={ANCWORKS_URL} target="_blank" rel="noreferrer">
            ANCWorks
          </a>{' '}
          (the "Other" option) or the Code Enforcement Hotline (907-343-4141), and registration questions at
          MuniLicenses@anchorageak.gov (907-343-4311).
        </p>
      </section>

      <footer>
        <p>
          Requirements quoted from the Municipal Clerk's{' '}
          <a href={PROGRAM_URL} target="_blank" rel="noreferrer">
            Short Term Rental Registration Program
          </a>{' '}
          page. The code and the full database behind this page are public on{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          . Maps and imagery © Esri and its data providers.
        </p>
      </footer>
    </main>
  );
};

const Tag: FC<{ problem: Problem }> = ({ problem }) => (
  <span className={`finding-tag f-${problem}`}>{PROBLEM_LABEL[problem]}</span>
);

const EXPORT_COLUMNS: [string, (c: Case, i: number) => unknown][] = [
  ['Case', (_c, i) => i + 1],
  ['Problem', (c) => PROBLEM_LABEL[c.problem]],
  ['Registration shown', (c) => c.registration_id],
  ['Registration status', (c) => c.registration_status],
  ['Registered business name', (c) => title(c.business_name)],
  ['Registered address', (c) => title(c.registered_address)],
  ['Muni geocoded address', (c) => title(c.geocoded_address)],
  ['Registered lat', (c) => c.registered_lat],
  ['Registered lng', (c) => c.registered_lng],
  ['License page', (c) => c.license_url],
  ['Airbnb listing ID', (c) => c.listing_id],
  ['Airbnb listing title', (c) => title(c.listing_name)],
  ['Airbnb URL', (c) => c.listing_url],
  ['Airbnb host', (c) => title(c.host_name)],
  ['Airbnb host ID', (c) => c.host_id],
  ['Airbnb pin', (c) => pinLabel(c.listing_pin_is_exact)],
  ['Airbnb lat', (c) => c.listing_lat],
  ['Airbnb lng', (c) => c.listing_lng],
  ['Distance (m)', (c) => c.distance_m],
  ['Listings showing this id', (c) => (c.registration_id ? c.listings_on_registration.length : '')],
  ['Matching registrations near the listing', (c) => c.suggested_registrations.map((r) => `${r.registration_id} ${title(r.business_name)}`).join('; ')],
  ['Explanation', (c) => caseText(c)],
];

const CaseTable: FC<{
  cases: Case[];
  current: number;
  isLoading: boolean;
  onPick: (index: number) => void;
  listingDate: number | null;
}> = ({ cases, current, isLoading, onPick, listingDate }) => {
  const [problem, setProblem] = useState<Problem | 'all'>('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return cases
      .map((c, i) => [c, i] as const)
      .filter(
        ([c]) =>
          (problem === 'all' || c.problem === problem) &&
          (!needle ||
            [c.listing_name, c.host_name, c.registration_id, c.business_name, c.registered_address, c.listing_id].some((v) =>
              v?.toLowerCase().includes(needle),
            )),
      );
  }, [cases, problem, search]);

  const exportRows = () => [EXPORT_COLUMNS.map(([h]) => h), ...shown.map(([c, i]) => EXPORT_COLUMNS.map(([, f]) => f(c, i)))];

  const copy = async () => {
    const tsv = exportRows()
      .map((row) => row.map((v) => String(v ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      setStatus('Copied. Paste into a spreadsheet.');
    } catch {
      setStatus('Copy was blocked by the browser; use Download CSV.');
    }
    setTimeout(() => setStatus(''), 4000);
  };

  const download = () => {
    const csv = exportRows()
      .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `str-registration-problems${listingDate ? `-${isoDate(listingDate)}` : ''}.csv`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <h2>All cases</h2>
      <p className="muted">One row per Airbnb listing. Select a row to see it on the map below.</p>
      <div className="toolbar">
        <select value={problem} onChange={(e) => setProblem(e.target.value as Problem | 'all')} aria-label="Problem">
          <option value="all">Every problem</option>
          {PROBLEMS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search listing, host, id, business name or address"
          aria-label="Search"
        />
        <button type="button" onClick={copy}>
          Copy table
        </button>
        <button type="button" onClick={download}>
          Download CSV
        </button>
        <span className="muted">{int(shown.length)} listings</span>
        <span className="status" role="status">
          {status}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Registration shown</th>
              <th>Airbnb listing</th>
              <th>Airbnb host</th>
              <th>Distance</th>
              <th>Problem</th>
              <th>Registration near the listing that matches it</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="muted">
                  Loading…
                </td>
              </tr>
            ) : (
              shown.map(([c, i]) => (
                <tr
                  key={c.listing_id}
                  tabIndex={0}
                  className={i === current ? 'active' : undefined}
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('a')) onPick(i);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onPick(i);
                  }}
                >
                  <td className="num">{i + 1}</td>
                  <td>
                    {c.registration_id == null ? (
                      <span className="muted">none</span>
                    ) : c.license_url ? (
                      <a href={c.license_url} target="_blank" rel="noreferrer">
                        {c.registration_id}
                      </a>
                    ) : (
                      c.registration_id
                    )}
                    {c.business_name && (
                      <>
                        <br />
                        {title(c.business_name)}
                      </>
                    )}
                    {c.registered_address && (
                      <>
                        <br />
                        <span className="muted">{title(c.registered_address)}</span>
                      </>
                    )}
                    {c.problem === 'not-on-file' && (
                      <>
                        <br />
                        <span className="muted">{c.newer_than_newest ? 'newer than any id on file' : 'not on file'}</span>
                      </>
                    )}
                  </td>
                  <td>
                    <a href={c.listing_url ?? undefined} target="_blank" rel="noreferrer">
                      {c.listing_id}
                    </a>
                    <br />
                    {title(c.listing_name)}
                  </td>
                  <td>{title(c.host_name)}</td>
                  <td className="num">{distance(c.distance_m)}</td>
                  <td>
                    <Tag problem={c.problem} />
                  </td>
                  <td>
                    {c.suggested_registrations.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {c.suggested_registrations.slice(0, 2).map((r) => (
                          <div key={r.registration_id}>
                            {r.registration_id} <span className="muted">{title(r.business_name)}</span>
                          </div>
                        ))}
                        {c.suggested_registrations.length > 2 && (
                          <span className="muted">+{c.suggested_registrations.length - 2} more</span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const Viewer: FC<{ cases: Case[]; index: number; onShow: (index: number) => void }> = ({ cases, index, onShow }) => {
  const c = cases[index]!;
  const prev = () => onShow((index - 1 + cases.length) % cases.length);
  const next = () => onShow((index + 1) % cases.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') onShow((index - 1 + cases.length) % cases.length);
      if (e.key === 'ArrowRight') onShow((index + 1) % cases.length);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, cases.length, onShow]);

  const near = c.registrations_near_listing;
  const nearShown = [...near.filter((r) => r.reasons.length), ...near.filter((r) => !r.reasons.length)].slice(0, 8);

  return (
    <div className="viewer">
      <div className="viewer-head">
        <h3>
          Case {index + 1} of {cases.length}: {c.registration_id ?? title(c.listing_name)} <Tag problem={c.problem} />
        </h3>
        <div className="toolbar" style={{ margin: 0 }}>
          <button type="button" onClick={prev} aria-label="Previous case">
            ← Previous
          </button>
          <select className="case-select" value={index} onChange={(e) => onShow(Number(e.target.value))} aria-label="Choose a case">
            {cases.map((o, i) => (
              <option key={o.listing_id} value={i}>
                {i + 1}. {o.registration_id ?? 'No id'} · {title(o.listing_name).slice(0, 48)}
              </option>
            ))}
          </select>
          <button type="button" onClick={next} aria-label="Next case">
            Next →
          </button>
        </div>
      </div>
      <div className={`finding f-${c.problem}`}>{caseText(c)}</div>
      <div className="case-grid">
        <div>
          <div className="sources">
            <div className="card listing">
              <h4>
                <i className="swatch" style={{ background: 'var(--listing)', borderRadius: '50%' }} />
                Airbnb listing
              </h4>
              {c.photo_url && (
                <img
                  key={c.photo_url}
                  src={`${c.photo_url}?im_w=480`}
                  alt="First photo on the Airbnb listing"
                  loading="lazy"
                  onError={(e) => e.currentTarget.remove()}
                />
              )}
              <dl>
                <dt>Title</dt>
                <dd>
                  <a href={c.listing_url ?? undefined} target="_blank" rel="noreferrer">
                    {title(c.listing_name)}
                  </a>
                </dd>
                <dt>Listing ID</dt>
                <dd>{c.listing_id}</dd>
                <dt>Host</dt>
                <dd>
                  <a href={`https://www.airbnb.com/users/show/${c.host_id}`} target="_blank" rel="noreferrer">
                    {title(c.host_name) || c.host_id}
                  </a>
                </dd>
                <dt>Type</dt>
                <dd>
                  {c.listing_type}
                  {c.bedrooms ? `, ${c.bedrooms}` : ''}
                  {c.guest_capacity ? `, ${c.guest_capacity} guests` : ''}
                </dd>
                <dt>Id shown</dt>
                <dd>{c.registration_id ?? <span className="muted">none</span>}</dd>
                <dt>Map pin</dt>
                <dd>
                  {pinLabel(c.listing_pin_is_exact)},{' '}
                  <a href={mapsLink(c.listing_lat, c.listing_lng)} target="_blank" rel="noreferrer">
                    {c.listing_lat.toFixed(5)}, {c.listing_lng.toFixed(5)}
                  </a>
                </dd>
                <dt>Seen</dt>
                <dd>{date(c.listing_seen_date)}</dd>
              </dl>
            </div>
            <div className="card registered">
              <h4>
                <i className="swatch" style={{ background: 'var(--registered)', borderRadius: 2 }} />
                Muni registration
              </h4>
              {c.registered_address || c.business_name ? (
                <dl>
                  <dt>Id</dt>
                  <dd>
                    <a href={c.license_url ?? undefined} target="_blank" rel="noreferrer">
                      {c.registration_id}
                    </a>
                  </dd>
                  <dt>Status</dt>
                  <dd>{c.registration_status}</dd>
                  <dt>Business name</dt>
                  <dd>{title(c.business_name) || <span className="muted">none given</span>}</dd>
                  <dt>Registered address</dt>
                  <dd>{title(c.registered_address)}</dd>
                  <dt>Geocoded as</dt>
                  <dd>
                    {c.registered_lat != null && c.registered_lng != null ? (
                      <a href={mapsLink(c.registered_lat, c.registered_lng)} target="_blank" rel="noreferrer">
                        {title(c.geocoded_address) || 'map'}
                      </a>
                    ) : (
                      <span className="muted">not placed</span>
                    )}
                  </dd>
                  <dt>Community council</dt>
                  <dd>{c.community_council}</dd>
                  <dt>Issued</dt>
                  <dd>{date(c.issued_date)}</dd>
                </dl>
              ) : (
                <p className="muted" style={{ fontSize: '0.86rem' }}>
                  {c.registration_id
                    ? `No license page the Muni publishes holds ${c.registration_id}.`
                    : 'The listing shows no registration id.'}
                </p>
              )}
            </div>
          </div>
          {c.registration_id && (
            <>
              <h3>Listings that show {c.registration_id}</h3>
              <ul className="mini-list">
                {c.listings_on_registration.map((o) => (
                  <li key={o.listing_id}>
                    {o.listing_id === c.listing_id && <strong>This listing: </strong>}
                    <a href={o.url ?? undefined} target="_blank" rel="noreferrer">
                      {title(o.name)}
                    </a>{' '}
                    <span className="muted">
                      · {title(o.host_name)} · {pinLabel(o.pin_is_exact).toLowerCase()} pin
                      {o.distance_m != null && ` · ${distance(o.distance_m)} from the registered address`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Registrations within {NEAR_METERS} m of this listing</h3>
          <ul className="mini-list">
            {near.length === 0 ? (
              <li className="muted">None.</li>
            ) : (
              <>
                {nearShown.map((r) => (
                  <li key={r.registration_id}>
                    <a href={r.license_url ?? undefined} target="_blank" rel="noreferrer">
                      {r.registration_id}
                    </a>{' '}
                    {title(r.business_name)}{' '}
                    <span className="muted">
                      · {title(r.address)} · {distance(r.distance_m)}
                    </span>
                    {r.reasons.length > 0 && (
                      <>
                        <br />
                        <span style={{ color: 'var(--match)' }}>Matches: {r.reasons.join('; ')}</span>
                      </>
                    )}
                  </li>
                ))}
                {near.length > nearShown.length && <li className="muted">and {near.length - nearShown.length} more</li>}
              </>
            )}
          </ul>
        </div>
        <CaseMap c={c} />
      </div>
    </div>
  );
};

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const pin = (cls: string, label: string, size = 22) =>
  L.divIcon({
    className: '',
    html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

/** One case on a Leaflet map: the listing, its registered address, the other listings on its id, and nearby registrations. */
const CaseMap: FC<{ c: Case }> = ({ c }) => {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const hasRegistered = c.registered_lat != null && c.registered_lng != null;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { scrollWheelZoom: false });
    const streets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Map © Esri, HERE, Garmin, OpenStreetMap contributors',
    }).addTo(m);
    const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    });
    L.control.layers({ Streets: streets, Satellite: imagery }, undefined, { collapsed: false }).addTo(m);
    L.control.scale({ imperial: true, metric: true }).addTo(m);
    m.on('click', () => m.scrollWheelZoom.enable());
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const listingLL: L.LatLngTuple = [c.listing_lat, c.listing_lng];

    L.circle(listingLL, { radius: c.listing_pin_is_exact ? 50 : 200, color: '#1f5fbf', weight: 1, fillOpacity: 0.1 }).addTo(g);

    for (const r of c.registrations_near_listing) {
      const matched = r.reasons.length > 0;
      L.marker([r.lat, r.lng], {
        icon: pin(matched ? 'pin-match' : 'pin-other', matched ? '✓' : '', matched ? 18 : 12),
        zIndexOffset: matched ? 200 : 0,
      })
        .bindPopup(
          `<b>${esc(r.registration_id)}</b><br>${esc(title(r.business_name))}<br>${esc(title(r.address))}` +
            (matched ? `<br><span style="color:var(--match)">${esc(r.reasons.join('; '))}</span>` : ''),
        )
        .addTo(g);
    }
    for (const o of c.listings_on_registration) {
      if (o.listing_id === c.listing_id) continue;
      L.marker([o.lat, o.lng], { icon: pin('pin-sibling', '', 16), zIndexOffset: 300 })
        .bindPopup(
          `<b>Also shows ${esc(c.registration_id)}</b><br>${esc(title(o.name))}` +
            (o.distance_m != null ? `<br>${distance(o.distance_m)} from the registered address` : ''),
        )
        .addTo(g);
    }

    const points: L.LatLngTuple[] = [listingLL, ...c.listings_on_registration.map((o): L.LatLngTuple => [o.lat, o.lng])];
    if (hasRegistered) {
      const registeredLL: L.LatLngTuple = [c.registered_lat!, c.registered_lng!];
      points.push(registeredLL);
      if (c.distance_m != null && c.distance_m > NEAR_METERS) {
        L.polyline([listingLL, registeredLL], { color: '#1c2128', weight: 2, dashArray: '6 6' })
          .bindTooltip(distance(c.distance_m), { permanent: true, direction: 'center', className: 'distance' })
          .addTo(g);
      }
      L.marker(registeredLL, { icon: pin('pin-registered', 'R', 24), zIndexOffset: 1000 })
        .bindPopup(
          `<b>Registered address of ${esc(c.registration_id)}</b><br>${esc(title(c.registered_address))}` +
            `<br><span class="muted">Geocoded as ${esc(title(c.geocoded_address))}</span>`,
        )
        .addTo(g);
    } else {
      points.push(...c.registrations_near_listing.map((r): L.LatLngTuple => [r.lat, r.lng]));
    }
    L.marker(listingLL, { icon: pin('pin-listing', 'A', 24), zIndexOffset: 1100 })
      .bindPopup(`<b>Airbnb location</b><br>${esc(title(c.listing_name))}<br>${pinLabel(c.listing_pin_is_exact)} pin`)
      .addTo(g);

    m.invalidateSize();
    m.fitBounds(L.latLngBounds(points).pad(0.05), { padding: [36, 36], maxZoom: 17 });
  }, [c, hasRegistered]);

  const zoomTo = (ll: L.LatLngTuple, zoom: number) => map.current?.setView(ll, zoom);
  return (
    <div className="map-wrap">
      <div className="toolbar" style={{ margin: 0 }}>
        {hasRegistered && (
          <button
            type="button"
            onClick={() =>
              map.current?.fitBounds(
                L.latLngBounds([
                  [c.listing_lat, c.listing_lng],
                  [c.registered_lat!, c.registered_lng!],
                ]),
                { padding: [36, 36], maxZoom: 17 },
              )
            }
          >
            Show both
          </button>
        )}
        <button type="button" onClick={() => zoomTo([c.listing_lat, c.listing_lng], 17)}>
          Zoom to Airbnb location
        </button>
        {hasRegistered && (
          <button type="button" onClick={() => zoomTo([c.registered_lat!, c.registered_lng!], 18)}>
            Zoom to registered address
          </button>
        )}
      </div>
      <div ref={el} className="map" role="img" aria-label="Map of the Airbnb location and the registered address" />
      <div className="legend">
        <span>
          <i className="swatch" style={{ background: 'var(--listing)', borderRadius: '50%' }} />
          This listing on Airbnb
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--registered)', borderRadius: 2 }} />
          Registered address
        </span>
        <span>
          <i className="swatch" style={{ background: '#7aa7e6', borderRadius: '50%' }} />
          Other listings that show the same id
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--match)', borderRadius: 2 }} />
          Nearby registration that matches the listing
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--other)', borderRadius: 2 }} />
          Other nearby registrations
        </span>
      </div>
      <p className="muted" style={{ fontSize: '.82rem', margin: 0 }}>
        The shaded circle is where the rental can be, given Airbnb's pin: 200 m for an approximate pin, 50 m for an
        exact one.
      </p>
    </div>
  );
};

