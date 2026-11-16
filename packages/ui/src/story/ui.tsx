import { SpinnerPane } from '@sqlrooms/ui';
import type { FC, ReactNode } from 'react';

/** Series colors, shared so a state reads the same in every chart. */
export const COLOR = {
  booked: 'hsl(12 76% 56%)',
  bookedInferred: 'hsl(12 70% 72%)',
  blocked: 'hsl(215 14% 62%)',
  available: 'hsl(173 58% 39%)',
  primary: 'hsl(221 70% 50%)',
  muted: 'hsl(215 16% 80%)',
  band: 'hsl(221 70% 50% / 0.18)',
  accent: 'hsl(43 85% 50%)',
} as const;

/** Categorical colors for up to 6 groups. */
export const CATEGORY = [
  'hsl(221 70% 50%)',
  'hsl(12 76% 56%)',
  'hsl(173 58% 39%)',
  'hsl(43 85% 50%)',
  'hsl(280 45% 55%)',
  'hsl(215 14% 62%)',
];

/** A chart filling the top of a cross-filter panel, with its loading and error states. */
export const ChartBox: FC<{ isLoading?: boolean; error?: Error | null; children: ReactNode }> = ({
  isLoading,
  error,
  children,
}) => (
  <div className="absolute inset-2">
    {error ? (
      <pre className="text-destructive h-full overflow-auto text-xs whitespace-pre-wrap">{error.message}</pre>
    ) : isLoading ? (
      <SpinnerPane className="h-full" />
    ) : (
      children
    )}
  </div>
);

/** A row of mutually exclusive buttons. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: readonly T[] | readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o as T, label: o as string } : o));
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-muted-foreground">{label}</span>}
      <div className="bg-muted inline-flex rounded-md p-0.5">
        {items.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={
              'rounded px-2 py-0.5 transition-colors ' +
              (o.value === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      {label && <span className="text-muted-foreground">{label}</span>}
      <select
        className="bg-background rounded-md border px-1.5 py-0.5"
        value={String(value)}
        onChange={(e) => {
          const found = options.find((o) => String(o.value) === e.target.value);
          if (found) onChange(found.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A figure quoted in the narrative, shown as "…" until it loads. */
export const N: FC<{ children: ReactNode }> = ({ children }) => (
  <strong className="text-foreground font-semibold tabular-nums">{children ?? '…'}</strong>
);

/** A caveat set off from the narrative. */
export const Caveat: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="text-muted-foreground mt-3 border-l-2 pl-3 text-[13px] leading-snug">{children}</p>
);

export const Swatch: FC<{ color: string; label: ReactNode }> = ({ color, label }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
    {label}
  </span>
);

/** Shared axis/tooltip styling for recharts. */
export const axisProps = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' },
} as const;

export const tooltipProps = {
  contentStyle: {
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid hsl(var(--border))',
    background: 'hsl(var(--popover))',
    color: 'hsl(var(--popover-foreground))',
  },
  cursor: { fill: 'hsl(var(--muted) / 0.6)' },
} as const;
