import type { FC } from 'react';
import { ListingDetail } from './ListingDetail';
import { XfMap, type XfMapColor } from './XfMap';
import { XfFilterChip, XfReady } from './XfProvider';
import { XfTable } from './XfTable';

/**
 * A chapter's right-hand panel: the selected listings on a map above the
 * table of them. Clicking a dot or a row opens that listing's details over
 * the map.
 */
export const XfSide: FC<{ mapColor: XfMapColor; columns: readonly string[] }> = ({ mapColor, columns }) => (
  <div className="bg-card flex h-full flex-col overflow-hidden rounded-lg border shadow-sm">
    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
      <span className="text-muted-foreground mr-auto">Click a dot or a row for details. Filter in the column headers.</span>
      <XfFilterChip />
    </div>
    <XfReady className="flex-1">
      <div className="relative min-h-0 flex-[5]">
        <XfMap color={mapColor} />
        <ListingDetail />
      </div>
      <div className="relative flex min-h-0 flex-[4] flex-col border-t">
        <XfTable columns={columns} />
      </div>
    </XfReady>
  </div>
);
