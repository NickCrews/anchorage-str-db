import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChapterNearContext, useChapterNear } from './near';
import { XfFilterChip, XfReady } from './xf/XfProvider';

/** The element the story scrolls in, which the step observers watch. */
export const ScrollRootContext = createContext<RefObject<HTMLElement | null> | null>(null);

export interface ChapterProps {
  id: string;
  title: string;
  /** One or two sentences under the title: what the chapter asks and why. */
  lede: ReactNode;
  /** The narrative, one block per step. Scrolling a step into view drives the chart and panel. */
  steps: ReactNode[];
  /** The chapter's body for the active step: a `ChapterGrid` inside an `XfProvider`. */
  visual: (step: number) => ReactNode;
}

interface ChapterContextValue extends Omit<ChapterProps, 'visual' | 'id'> {
  active: number;
  stepRefs: RefObject<(HTMLDivElement | null)[]>;
}

const ChapterContext = createContext<ChapterContextValue | null>(null);

/**
 * One question. The step nearest the middle of the visible narrative is
 * active; the chapter's chart and panel show that step's view until the
 * reader changes a control.
 */
export const Chapter: FC<ChapterProps> = ({ id, title, lede, steps, visual }) => {
  const root = useContext(ScrollRootContext);
  const [active, setActive] = useState(0);
  const [near, setNear] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), {
      root: root?.current ?? null,
      rootMargin: '100% 0px 100% 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      // The sticky chart covers the top of the narrative column, so the
      // band that picks a step sits in the visible part below it.
      { root: root?.current ?? null, rootMargin: '-68% 0px -30% 0px' },
    );
    for (const el of stepRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [root, steps.length]);

  return (
    <section ref={sectionRef} id={id} className="border-t px-4 py-10 lg:px-8">
      <ChapterNearContext.Provider value={near}>
        <ChapterContext.Provider value={{ title, lede, steps, active, stepRefs }}>
          {visual(active)}
        </ChapterContext.Provider>
      </ChapterNearContext.Provider>
    </section>
  );
};

/**
 * A chapter's two columns. Left: the question, a sticky chart with its
 * controls, and the narrative steps scrolling beneath it. Right: a sticky
 * panel, the map and table.
 */
export const ChapterGrid: FC<{
  controls?: ReactNode;
  exploring?: boolean;
  onReset?: () => void;
  chart: ReactNode;
  caption?: ReactNode;
  side: ReactNode;
}> = ({ controls, exploring, onReset, chart, caption, side }) => {
  const ctx = useContext(ChapterContext);
  if (!ctx) throw new Error('ChapterGrid outside Chapter');
  const { title, lede, steps, active, stepRefs } = ctx;
  const near = useChapterNear();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(360px,2fr)_3fr] lg:gap-8">
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">{title}</h2>
        <div className="text-muted-foreground mt-3 max-w-prose text-[15px] leading-relaxed">{lede}</div>

        <div className="bg-background sticky top-12 z-20 -mx-1 mt-4 border-b px-1 pt-3 pb-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {controls}
            <span className="ml-auto flex gap-2">
              <XfFilterChip />
              {exploring && onReset && (
                <button
                  onClick={onReset}
                  className="rounded-full border border-amber-500/60 bg-amber-50 px-2.5 py-0.5 whitespace-nowrap text-amber-900 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-100"
                >
                  Exploring · back to the story
                </button>
              )}
            </span>
          </div>
          <div className="relative mt-2 h-[30vh] min-h-48">
            {near && <XfReady>{chart}</XfReady>}
          </div>
          {caption && <div className="text-muted-foreground mt-1 text-[11px] leading-snug">{caption}</div>}
        </div>

        {/* The bottom padding lets the last step reach the reading band. */}
        <div className="pb-[30vh]">
          {steps.map((step, i) => (
            <div
              key={i}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
              data-step={i}
              className="flex min-h-[45vh] items-center py-4"
            >
              <div
                className={
                  'max-w-prose rounded-lg border p-5 text-[15px] leading-relaxed transition-colors ' +
                  (i === active ? 'border-foreground/30 bg-card shadow-sm' : 'border-transparent opacity-50')
                }
              >
                {step}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <div className="sticky top-14 h-[80vh] lg:h-[calc(100vh-5rem)]">{near && side}</div>
      </div>
    </div>
  );
};

/**
 * Per-step view state. Each step has a preset; scrolling to a step resets
 * the state to its preset, and a control the reader changes overrides it
 * until the next step. `exploring` is true while it differs. A preset that
 * changes, such as one naming a month that has just loaded, also resets it.
 */
export function useStepState<T>(step: number, presets: T[]) {
  const preset = presets[Math.min(step, presets.length - 1)] as T;
  const presetKey = `${step}:${JSON.stringify(preset)}`;
  const [state, setState] = useState<T>(preset);
  const [forKey, setForKey] = useState(presetKey);
  if (forKey !== presetKey) {
    setForKey(presetKey);
    setState(preset);
  }
  const exploring = JSON.stringify(state) !== JSON.stringify(preset);
  const update = useCallback((patch: Partial<T>) => setState((s) => ({ ...s, ...patch })), []);
  const reset = useCallback(() => setState(preset), [preset]);
  return { state, update, exploring, reset };
}
