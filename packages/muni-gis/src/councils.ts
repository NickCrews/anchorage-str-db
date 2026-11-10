/**
 * The Muni's community council polygons, and which council a coordinate is
 * in.
 *
 * The layer has 39 features for 36 councils (Eagle River Valley and Eklutna
 * Valley are several polygons each) and about 34,000 vertices, one request.
 * Councils do not overlap: each of the archived registration layer's 2,564
 * geocoded coordinates (2026-09-28) fell in exactly one polygon, the one named
 * by its `CommunityCouncil`. They do not cover the whole Municipality either,
 * so a coordinate can be in none.
 */

import { inRings, type Ring } from '@anchorage-str-db/utils/muni_geography';

import { fetchLayer, liveMuniArcgisFetcher, MUNI_ARCGIS_SERVICES, type FetchJson } from './arcgis.ts';

export const COMMUNITY_COUNCILS_URL = `${MUNI_ARCGIS_SERVICES}/CommunityCouncil_Links/FeatureServer/0`;

/** One polygon of a council, as `[lng, lat]` rings. */
export interface CouncilPolygon {
  /** The layer's `COUNCIL`: `Girdwood`, `Turnagain Arm`, ... */
  council: string;
  rings: Ring[];
}

/** Every council polygon, in WGS84. Throws on a feature without a name or rings. */
export async function fetchCommunityCouncils(fetchJson: FetchJson = liveMuniArcgisFetcher()): Promise<CouncilPolygon[]> {
  const { features } = await fetchLayer(COMMUNITY_COUNCILS_URL, { fetchJson, pageSize: 1000, returnGeometry: true });
  return features.map(({ attributes, geometry }) => {
    const council = attributes.COUNCIL;
    if (typeof council !== 'string' || !geometry?.rings?.length) {
      throw new Error(`a community council feature without a COUNCIL or rings: ${JSON.stringify(attributes)}`);
    }
    return { council, rings: geometry.rings };
  });
}

/** The council whose polygon contains the coordinate, or null when none does. */
export function councilAt(councils: readonly CouncilPolygon[], lat: number, lng: number): string | null {
  return councils.find(({ rings }) => inRings(rings, lat, lng))?.council ?? null;
}
