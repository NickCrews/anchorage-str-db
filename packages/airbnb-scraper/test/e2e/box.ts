import type { BBox } from 'airbnb-dlp';
import type { Recording } from 'airbnb-dlp/testing';

import type { IsoDate } from '@anchorage-str-db/utils/dates';

/** A few blocks of Midtown Anchorage, with about a dozen listings. */
export const E2E_BOX: BBox = { south: 61.196, west: -149.902, north: 61.198, east: -149.897 };

export interface E2eRecording {
  scrapeDate: IsoDate;
  /** When the recorded run started, on the system clock. */
  startedAtMs: number;
  recordings: Recording[];
}
