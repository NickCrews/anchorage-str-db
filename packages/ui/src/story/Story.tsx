import { useRef, type FC } from 'react';
import { DataStatusGate } from '../components/DataStatusGate';
import { longDate } from '../format';
import { ScrollRootContext } from './Chapter';
import { Baseline } from './chapters/Baseline';
import { HostRevenue } from './chapters/HostRevenue';
import { Incentives } from './chapters/Incentives';
import { ListingRevenue } from './chapters/ListingRevenue';
import { Locals } from './chapters/Locals';
import { MuniIncome } from './chapters/MuniIncome';
import { NightlyRates } from './chapters/NightlyRates';
import { Occupancy } from './chapters/Occupancy';
import { Supply } from './chapters/Supply';
import { Tourism } from './chapters/Tourism';
import { WhoEarns } from './chapters/WhoEarns';
import { StoryProvider, useStory } from './context';
import { Methodology, REPO_URL } from './Methodology';

const CONTACT_EMAIL = 'nicholas.b.crews@gmail.com';

const CHAPTERS = [
  ['q1', 'Earnings'],
  ['q2', 'Hosts'],
  ['q3', 'Prices'],
  ['q4', 'Occupancy'],
  ['q5', 'How many'],
  ['q6', 'Rent long-term?'],
  ['q7', 'Visitors'],
  ['q8', 'Neighborhoods'],
  ['q9', 'Room tax'],
  ['q10', 'Who earns'],
  ['q11', 'Baseline'],
] as const;

/**
 * The page: a work-in-progress banner, a header with the Methodology menu
 * and section links, then one section per question. The page scrolls
 * inside `main`, which the sections' step observers watch.
 */
export const Story: FC = () => {
  const scrollRef = useRef<HTMLElement | null>(null);
  return (
    <DataStatusGate>
      <StoryProvider>
        <ScrollRootContext.Provider value={scrollRef}>
          <main ref={scrollRef} className="bg-background h-full overflow-y-auto scroll-smooth">
            <Banner />
            <Header />
            <Intro />
            <ListingRevenue />
            <HostRevenue />
            <NightlyRates />
            <Occupancy />
            <Supply />
            <Incentives />
            <Tourism />
            <Locals />
            <MuniIncome />
            <WhoEarns />
            <Baseline />
            <Footer />
          </main>
        </ScrollRootContext.Provider>
      </StoryProvider>
    </DataStatusGate>
  );
};

const Banner: FC = () => (
  <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-[13px] text-amber-950 lg:px-8 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
    <strong>Work in progress.</strong> These numbers are rough and still changing; please don't quote them yet.
    Questions or corrections:{' '}
    <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
    .
  </div>
);

const Header: FC = () => (
  <header className="bg-background/95 sticky top-0 z-40 flex h-12 items-center gap-3 border-b px-4 backdrop-blur lg:px-8">
    <Methodology />
    <a href="#top" className="shrink-0 text-sm font-semibold">
      Anchorage short-term rentals
    </a>
    <nav className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto text-xs">
      {CHAPTERS.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded px-1.5 py-1">
          {label}
        </a>
      ))}
    </nav>
    <a
      href={`${import.meta.env.BASE_URL}registration-problems`}
      className="text-muted-foreground hover:text-foreground shrink-0 text-xs"
    >
      Registration problems
    </a>
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1.5 text-xs"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
        <path
          fill="currentColor"
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
      GitHub
    </a>
  </header>
);

const Intro: FC = () => {
  const { meta } = useStory();
  return (
    <section id="top" className="mx-auto max-w-3xl px-4 py-14 lg:py-20">
      <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Municipality of Anchorage</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight text-balance">
        Who profits from short-term rentals, and what do they cost the rest of us?
      </h1>
      <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
        Every day we record every Airbnb listing in the Municipality of Anchorage: which nights are booked, what
        each one charges, who runs it and who owns the property. Each section below asks one question. Read on
        the left; the chart, map and table follow along.
      </p>
      <p className="text-muted-foreground mt-4 leading-relaxed">
        You can explore too. Drag across a chart, or click a value at the top of a table column, to narrow
        everything in that section to those listings. Click a dot on the map or a row in the table to see one
        listing up close.
      </p>
      <p className="text-muted-foreground mt-4 text-sm">
        Recorded daily since <strong className="text-foreground">{meta ? longDate(meta.firstRunDate) : '…'}</strong>,
        most recently on <strong className="text-foreground">{meta ? longDate(meta.latestRunDate) : '…'}</strong>.
        Earnings and bookings are estimates; the <strong className="text-foreground">Methodology</strong> menu at the
        top left explains how they are made and lets you choose how cautious to be.
      </p>
    </section>
  );
};

const Footer: FC = () => (
  <footer className="text-muted-foreground border-t px-4 py-10 text-center text-sm lg:px-8">
    The code and the full database behind this page are public on{' '}
    <a className="underline" href={REPO_URL} target="_blank" rel="noreferrer">
      GitHub
    </a>
    . Questions or corrections:{' '}
    <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
    .
  </footer>
);
