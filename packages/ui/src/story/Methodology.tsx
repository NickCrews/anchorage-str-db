import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { longDate, pct1 } from '../format';
import {
  BLOCK_RUN_NIGHTS,
  FREH_BOOKED_NIGHTS,
  FREH_OFFERED_NIGHTS,
  FREH_WINDOW_NIGHTS,
  FREHM_MIN_NIGHTS,
  ROOM_TAX_RATE,
} from '../model/estimates';
import { useStory } from './context';
import { MODELS, modelLabel } from './model';

export const REPO_URL = 'https://github.com/NickCrews/anchorage-str-db';

/**
 * The Methodology menu at the top left: how the numbers are made, what they
 * assume and miss, and the choice of model every chart follows. Closed, it
 * shows the current model under its name.
 */
export const Methodology: FC = () => {
  const { model } = useStory();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:bg-muted flex items-center gap-2 rounded-md border px-2.5 py-1 text-left"
      >
        <span className="flex flex-col leading-tight">
          <span className="text-xs font-medium">Methodology</span>
          <span className="text-muted-foreground text-[11px]">{modelLabel(model)}</span>
        </span>
        <svg
          viewBox="0 0 16 16"
          className={'text-muted-foreground h-3.5 w-3.5 transition-transform ' + (open ? 'rotate-180' : '')}
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <Panel />}
    </div>
  );
};

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="space-y-1.5">
    <h3 className="text-foreground text-sm font-semibold">{title}</h3>
    {children}
  </section>
);

const Panel: FC = () => {
  const { model, setModel, meta } = useStory();
  return (
    <div className="bg-popover text-muted-foreground absolute top-full left-0 z-50 mt-2 max-h-[78vh] w-[min(34rem,calc(100vw-2rem))] space-y-5 overflow-auto rounded-lg border p-5 text-[13px] leading-relaxed shadow-xl">
      <Section title="Where the numbers come from">
        <p>
          Every day we look up every Airbnb listing in the Municipality of Anchorage and save two things Airbnb
          shows the public: its calendar of open and closed nights, and the price it asks for its next open
          night. We match listings to the Muni's short-term rental registrations, and through those to the
          Muni's property records, which name each property's owner.
        </p>
        <p>
          We started on {meta ? longDate(meta.firstRunDate) : '…'}. The latest look was on{' '}
          {meta ? longDate(meta.latestRunDate) : '…'}.
        </p>
      </Section>

      <Section title="How bookings are counted">
        <p>
          Airbnb doesn't say whether a closed night was booked by a guest or closed by the owner, and it never
          shows what a guest paid. So how often a place is booked, and how much it earns, have to be estimated.
          Choose how:
        </p>
        <div className="space-y-2">
          {MODELS.map((m) => (
            <label
              key={m.value}
              className={
                'flex cursor-pointer gap-3 rounded-md border p-3 ' +
                (m.value === model ? 'border-foreground/40 bg-muted/60' : 'hover:bg-muted/40')
              }
            >
              <input
                type="radio"
                name="model"
                className="mt-1"
                checked={m.value === model}
                onChange={() => setModel(m.value)}
              />
              <span>
                <span className="text-foreground block font-medium">{m.label}</span>
                <span className="block">{m.summary}</span>
              </span>
            </label>
          ))}
        </div>
        <p>
          A "long closed stretch" is more than {BLOCK_RUN_NIGHTS} closed nights in a row. Every chart, map and table
          follows your choice. The story's text quotes the middle estimate, with the low-to-high range where it
          matters.
        </p>
      </Section>

      <Section title="Frequently rented whole homes (FREHM)">
        <p>
          Housing researchers call a listing FREH, a frequently rented entire home, if over {FREH_WINDOW_NIGHTS}{' '}
          nights it is a whole home, open or booked at least {FREH_OFFERED_NIGHTS} of them, and booked at least{' '}
          {FREH_BOOKED_NIGHTS}. A home rented that often is unlikely to be anyone's home.
        </p>
        <p>
          Until we have a full year, we use FREHM, FREH modified: the same test over the nights we have recorded,
          up to the last {FREH_WINDOW_NIGHTS}, with both thresholds scaled to that many nights. Over 60 nights, a
          whole home needs to be open or booked at least {Math.ceil((FREH_OFFERED_NIGHTS * 60) / FREH_WINDOW_NIGHTS)}{' '}
          and booked at least {Math.ceil((FREH_BOOKED_NIGHTS * 60) / FREH_WINDOW_NIGHTS)}. A listing with fewer than{' '}
          {FREHM_MIN_NIGHTS} nights recorded is unknown. Once a listing has a full year recorded, FREHM is FREH.
        </p>
        <p>
          Which nights count as booked follows the estimate chosen above. Our nights so far are fall nights, so
          FREHM leans toward listings that are busy outside the summer. It counts listings, not homes: one home
          listed twice counts twice, and a listing that rents several homes together counts on top of the
          listings for each home.
        </p>
      </Section>

      <Section title="Other assumptions">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            A booked night earns what the listing was asking for open nights that month. Asking prices include
            last-minute discounts and leave out cleaning fees, so revenue is likely a little low.
          </li>
          <li>Room tax is {pct1(ROOM_TAX_RATE)} of what guests pay, the Muni's rate for stays under 30 days.</li>
          <li>
            A listing's neighborhood and owner come from the Muni registration it displays. Listings that show no
            registration have neither.
          </li>
          <li>
            "Owner lives there" means the owner claims the Muni's property-tax exemption for their primary
            residence on that property.
          </li>
        </ul>
      </Section>

      <Section title="What this can't tell you">
        <ul className="list-disc space-y-1 pl-5">
          <li>Anything about Vrbo, direct bookings, or other sites. This is Airbnb only.</li>
          <li>
            Anything before we started. With only a few months recorded, we can't yet show a full year, and the
            busy summer season is still to come.
          </li>
          <li>
            Exactly how many homes are rented. One home can have several listings, and one listing can cover
            several homes.
          </li>
          <li>
            Where an owner actually lives. We know only where their tax bill is mailed.
          </li>
          <li>Exact locations for every listing. Airbnb shifts some map pins by up to a few hundred meters.</li>
        </ul>
      </Section>

      <p>
        The code and the full database are public on{' '}
        <a className="text-foreground underline" href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>
    </div>
  );
};
