import { useSyncExternalStore } from 'react';
import { apiClient, boundaryService, localizationService, mdmsService, ApiClientError } from '@/api';
import { reportStepError, trackStepAction } from '../telemetry';
import { labelLocales } from '../labelLocales';
import { englishT, MessageError, type OnboardingT } from '../i18n';
import { deriveMapPosition } from '@/utils/mapConfigFromBoundaries';
import type { OsmAdminLevel } from '@/utils/osmBoundaries';
import type { ParsedGeoJsonSidecar } from '@/utils/boundaryGeoJson';
import type { SuggestionFeature } from '@/utils/turbopassSuggestions';
import type { OfficialSet } from '@/utils/officialBoundaries';
import type { Boundary, BoundaryExcelRow, BoundaryHierarchy } from '@/api/types';

export type BoundarySource = 'osm' | 'excel';

/** What the import screen needs to reopen where the operator left it. */
export type ImportResume =
  | {
      kind: 'osm';
      searchTerm: string;
      pickedSuggestion: SuggestionFeature | null;
      turbopassSource: string;
      fetchedPlace: { id: string; name: string; label: string; country: string | null };
      adminLevels: OsmAdminLevel[];
      attribution: string | null;
      officialSet: OfficialSet | null;
    }
  | {
      kind: 'excel';
      hierarchy: BoundaryHierarchy;
      file: File | null;
      parsed: BoundaryExcelRow[];
      valid: BoundaryExcelRow[];
      invalid: { boundary: BoundaryExcelRow; error: string }[];
      polygonFile: File | null;
      polygonSidecar: ParsedGeoJsonSidecar | null;
    };

/**
 * Boundaries the operator has chosen in Geography but not saved. boundary-service
 * can't delete a hierarchy or an area, so nothing is written until the step's
 * Save and continue: until then the selection can be edited or thrown away.
 */
export interface BoundaryDraft {
  source: BoundarySource;
  hierarchyType: string;
  /** Level names, broadest first. */
  levels: string[];
  /** The hierarchy is already defined on the server (Excel's "use an existing hierarchy"). */
  hierarchyExists: boolean;
  boundaries: Boundary[];
  /** Where the areas came from, e.g. "the official boundaries for Kenya (OCHA COD-AB)". */
  sourceText: string;
  /** Areas left out before save (unnamed, or in no area of the level above). */
  skipped: number;
  attribution: string | null;
  /** Geography's Preconfigured choice the import was opened with. */
  preconfigured: OfficialSet | null;
  resume: ImportResume;
}

// One unsaved selection per workspace, held in this tab's memory only: a reload
// drops it, and Geography warns before that happens.
const drafts = new Map<string, BoundaryDraft>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setBoundaryDraft(tenantId: string, draft: BoundaryDraft | null) {
  if (draft) drafts.set(tenantId, draft);
  else drafts.delete(tenantId);
  listeners.forEach((listener) => listener());
}

export function useBoundaryDraft(tenantId: string): BoundaryDraft | null {
  return useSyncExternalStore(subscribe, () => drafts.get(tenantId) ?? null);
}

/** Areas per level, for "3 districts · 12 wards". */
export function draftCounts(draft: BoundaryDraft): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const boundary of draft.boundaries) counts[boundary.boundaryType] = (counts[boundary.boundaryType] ?? 0) + 1;
  return counts;
}

/**
 * Defines the hierarchy, unless one of that name is already there with the same
 * levels. Any other existing definition would make every area create fail slowly
 * (validation retries) with a misleading error, so it stops here instead.
 */
async function ensureHierarchy(tenantId: string, hierarchyType: string, levels: string[]) {
  try {
    await boundaryService.createHierarchyFromLevels(tenantId, hierarchyType, levels);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (!msg.toLowerCase().includes('already exist') && !msg.includes('DUPLICATE')) throw e;
    const existing = (await boundaryService.getHierarchies(tenantId)).find((h) => h.hierarchyType === hierarchyType);
    const existingLevels = (existing?.boundaryHierarchy ?? []).map((l) => l.boundaryType);
    const sameLevels = existingLevels.length === levels.length && existingLevels.every((name, i) => name === levels[i]);
    if (!sameLevels) {
      throw new MessageError(
        'geography.levels_mismatch_edit',
        'A "%{type}" hierarchy already exists on %{tenant} with levels [%{existing}], which do not match yours [%{mapped}]. Edit your boundaries and name the levels to match.',
        { type: hierarchyType, tenant: tenantId, existing: existingLevels.join(' → '), mapped: levels.join(' → ') },
      );
    }
  }
}

// After the areas are created: localizations (boundary names are required for
// the citizen UI; the rest is best-effort), localization cache-bust, and the
// boundary-path repair tool. Returns a message for the operator when the
// hierarchy record didn't save.
async function runPostCreatePipeline(
  tenantId: string,
  created: Boundary[],
  hierarchyType: string,
  levels: { boundaryType: string }[],
  t: OnboardingT = englishT,
): Promise<string | null> {
  // Make this the tenant's PGR hierarchy (CMS-BOUNDARY.HierarchySchema) when it
  // has none yet: digit-ui, the dashboard and PGR read it in place of the
  // deployment-wide HIERARCHY_TYPE / pgrBoundary*Level globalConfigs (#2260).
  // The boundaries exist either way, so the rest still runs, but the operator
  // is told: without this row the Geography step can't complete.
  let schemaError: string | null = null;
  if (levels.length > 0) {
    try {
      await mdmsService.ensureHierarchySchema(tenantId, {
        hierarchy: hierarchyType,
        highestHierarchy: levels[0].boundaryType,
        lowestHierarchy: levels[levels.length - 1].boundaryType,
      });
    } catch (e) {
      console.warn('[geography] CMS-BOUNDARY.HierarchySchema not written', e);
      reportStepError('geography', 'hierarchy_schema', e, tenantId);
      const reason = e instanceof ApiClientError ? e.firstError : e instanceof Error ? e.message : String(e);
      schemaError = t('geography.schema_not_saved_draft', 'Boundaries were saved, but the hierarchy record didn\'t save: %{reason}', { reason });
    }
  }

  const boundaryData = created.map((b) => ({ code: b.code, name: b.name }));

  // Seed under en_IN (digit-ui's boot locale) plus every StateInfo language:
  // the citizen app reads boundary names under its active locale, so a missing
  // one leaves the locality dropdown and map ward tooltips showing raw codes.
  for (const locale of await labelLocales(tenantId)) {
    await localizationService.uploadBoundaryLocalizations(tenantId, boundaryData, hierarchyType, locale);

    // Create level-label localization keys so DIGIT-UI renders "MUNICÍPIO" / "DISTRITO"
    // instead of the raw key "maputo_hierarchy_type_MUNICÍPIO" in the complaint form.
    await localizationService
      .uploadHierarchyLevelLocalizations(tenantId, hierarchyType, levels, locale)
      .catch((e) => console.warn(`hierarchy-level localization failed (non-fatal) for ${locale}`, e));
  }

  await localizationService.cacheBust().catch((e) => console.warn('cache-bust failed', e));

  // The boundaries just onboarded describe exactly the area this tenant serves,
  // so they already answer where the citizen map should open, how far in, and
  // which extent the address search may return results from. Derive all three
  // rather than asking an admin to type eight numbers they cannot sanity-check
  // without a map in front of them — and note a wrong search extent is not
  // cosmetic: Nominatim's bounded search DISCARDS anything outside the box.
  //
  // Best-effort. Boundaries are the operator's real work here; failing the step
  // over a map default would be a poor trade. An unwritten MapConfig just means
  // the map keeps its built-in defaults.
  try {
    const derived = deriveMapPosition(created);
    if (derived) {
      await mdmsService.upsertMapConfig(tenantId, {
        ...derived,
        // The wards the map draws are the ones we just created, for this tenant.
        boundaryTenantId: tenantId,
      });
    } else {
      console.warn('[geography] no boundary geometry — leaving MapConfig at its defaults');
    }
  } catch (e) {
    console.warn('[geography] map position not written (non-fatal)', e);
  }

  // Clear ancestralmaterializedpath so boundary-service includeChildren=true
  // doesn't combine two overlapping queries and return each node twice in the
  // citizen create-complaint dropdown. Fire-and-forget: if the MCP REST shim
  // isn't deployed, the step still completes and an operator can run
  // fix_boundary_paths via the MCP tool manually.
  try {
    const { token } = apiClient.getAuth();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(`${window.location.origin}/v1/tools/fix_boundary_paths`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ tenant_id: tenantId }),
    });
    clearTimeout(timer);
    if (!res.ok) console.warn(`[geography] boundary path fix returned ${res.status}`);
  } catch (e) {
    console.warn('[geography] boundary path fix skipped (MCP not reachable):', e);
  }
  return schemaError;
}

export interface DraftSaveResult {
  created: Boundary[];
  failed: { boundary: Boundary; error: string }[];
  /** Set when the areas landed but the hierarchy record didn't. */
  schemaError: string | null;
}

/**
 * Writes a draft: the hierarchy, its areas, then what the rest of the platform
 * reads alongside them. Throws when nothing could be written (the draft is still
 * good to edit and retry); a partial save comes back with its failures.
 */
export async function saveBoundaryDraft(
  tenantId: string,
  draft: BoundaryDraft,
  t: OnboardingT = englishT,
): Promise<DraftSaveResult> {
  if (!draft.hierarchyExists) await ensureHierarchy(tenantId, draft.hierarchyType, draft.levels);
  const result = await boundaryService.createBoundaries(draft.boundaries);
  const schemaError = result.success.length
    ? await runPostCreatePipeline(
        tenantId,
        result.success,
        draft.hierarchyType,
        draft.levels.map((boundaryType) => ({ boundaryType })),
        t,
      )
    : null;
  trackStepAction('geography', 'entity_import', 'boundary', {
    tenant: tenantId,
    source: draft.source,
    count: result.success.length,
    failed: result.failed.length,
    levels: draft.levels.length,
  });
  return { created: result.success, failed: result.failed, schemaError };
}
