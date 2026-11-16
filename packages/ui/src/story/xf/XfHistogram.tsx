import { VgPlotChart, type Param, type Selection, type Spec } from '@sqlrooms/mosaic';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useXf } from './context';

// Hex, not hsl(): vgplot reads a string it cannot parse as a color as a column name.
const BACKGROUND = '#c9d4ee';
const FOREGROUND = '#2f62d0';

/**
 * A cross-filtered histogram of one column of the chapter's table: every
 * listing in a pale bar, the selected ones over it, and a median rule for
 * the selection. Dragging across it brushes a range into the selection.
 */
export const XfHistogram: FC<{ column: string; label: string; bins?: number }> = ({ column, label, bins = 40 }) => {
  const { table, selection, version } = useXf();
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) =>
        s && Math.abs(s.width - width) < 8 && Math.abs(s.height - height) < 8
          ? s
          : { width: Math.floor(width), height: Math.floor(height) },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const spec = useMemo<Spec | null>(() => {
    if (!size || size.width < 50 || size.height < 50) return null;
    const layer = (filtered: boolean) => ({
      mark: 'rectY',
      data: filtered ? { from: table, filterBy: '$brush' } : { from: table },
      x: { bin: column, maxbins: bins },
      y: { count: null },
      fill: filtered ? FOREGROUND : BACKGROUND,
      inset: 0.5,
    });
    return {
      plot: [
        layer(false),
        layer(true),
        {
          mark: 'ruleX',
          data: { from: table, filterBy: '$brush' },
          x: { median: column },
          stroke: '#333333',
          strokeDasharray: '3 3',
        },
        { select: 'intervalX', as: '$brush' },
      ],
      xLabel: label,
      yLabel: 'listings',
      width: size.width,
      height: size.height,
      margins: { left: 40, right: 12, top: 12, bottom: 32 },
      params: { brush: { select: 'crossfilter' } },
    } as Spec;
  }, [size, table, column, label, bins]);

  const params = useMemo(() => new Map<string, Param<unknown> | Selection>([['brush', selection]]), [selection]);

  return (
    <div ref={ref} className="absolute inset-2 text-[11px]">
      {spec && <VgPlotChart key={`${version}-${column}-${size?.width}-${size?.height}`} spec={spec} params={params} />}
    </div>
  );
};
