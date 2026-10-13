import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Info, Loader2, Lock, MapPin } from 'lucide-react';
import { useApp } from '../../App';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { boundaryService, ApiClientError } from '@/api';
import { toast } from '@/hooks/use-toast';
import { StepHeader } from '../StepHeader';
import { EmptyState, OptionCard, StepActions } from '../StepParts';
import { adjacentSteps, stepById } from '../steps';
import { probeGate, useStepProbe } from '../stepProbe';
import { reportStepError } from '../telemetry';
import { useTurbopassHealth } from '@/hooks/useTurbopassSources';
import { usePreconfiguredBoundaries } from '@/hooks/usePreconfiguredBoundaries';
import { countryName, type OfficialSet } from '@/utils/officialBoundaries';
import { TURBOPASS_UNAVAILABLE_MESSAGE } from '@/utils/turbopassSuggestions';
import BoundaryImport from './BoundaryImport';
import { BoundaryDraftCard } from './BoundaryDraftCard';
import {
  saveBoundaryDraft,
  setBoundaryDraft,
  useBoundaryDraft,
  type BoundaryDraft,
  type BoundarySource,
  type ImportResume,
} from './boundaryDraft';
import { plural } from '@/utils/plural';
import { PreconfiguredCard } from './PreconfiguredCard';
import { MessageError, useOnboardingT, type OnboardingT } from '../i18n';

const STEP = stepById('geography');
const { previous, next } = adjacentSteps('geography');

interface HierarchySummary {
  hierarchyType: string;
  levels: string[];
  counts: Record<string, number>;
  total: number;
}

async function loadHierarchies(tenant: string): Promise<HierarchySummary[]> {
  const hierarchies = await boundaryService.getHierarchies(tenant);
  return Promise.all(
    hierarchies.map(async (hierarchy) => {
      const boundaries = await boundaryService
        .searchBoundaries(tenant, { hierarchyType: hierarchy.hierarchyType })
        .catch(() => []);
      const counts: Record<string, number> = {};
      for (const boundary of boundaries) counts[boundary.boundaryType] = (counts[boundary.boundaryType] ?? 0) + 1;
      return {
        hierarchyType: hierarchy.hierarchyType,
        levels: (hierarchy.boundaryHierarchy ?? []).map((level) => level.boundaryType),
        counts,
        total: boundaries.length,
      };
    }),
  );
}

/** "3 districts · 12 wards", in level order. Level names are the workspace's own, so they stay as named. */
function summaryLine(hierarchy: HierarchySummary, t: OnboardingT): string {
  const parts = hierarchy.levels
    .filter((level) => hierarchy.counts[level])
    .map((level) => {
      const count = hierarchy.counts[level];
      const word = level.toLowerCase();
      return `${count} ${count === 1 ? word : plural(word)}`;
    });
  return parts.length ? parts.join(' · ') : t('geography.nothing_in_it_yet', 'Nothing in it yet');
}

const areas = (count: number, t: OnboardingT) =>
  count === 1
    ? t('geography.created.area_one', '%{count} area', { count: count.toLocaleString('en-US') })
    : t('geography.created.area_other', '%{count} areas', { count: count.toLocaleString('en-US') });

function reasonOf(err: unknown): string {
  return err instanceof ApiClientError ? err.firstError : err instanceof Error ? err.message : String(err);
}

export default function GeographyStep() {
  const { state, completePhase } = useApp();
  const navigate = useNavigate();
  const t = useOnboardingT();
  // Boundaries live at the workspace tenant, which every later step reads them from.
  const tenant = state.targetTenant || state.tenant;
  const done = state.completedPhases.includes(STEP.number);

  // The import screen, open for a source, or for Edit with the draft's choices.
  const [importing, setImporting] = useState<{
    source: BoundarySource;
    preconfigured: OfficialSet | null;
    resume: ImportResume | null;
  } | null>(null);
  // Chosen but unsaved boundaries: nothing reaches the server before Save and continue.
  const draft = useBoundaryDraft(tenant);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hierarchies, setHierarchies] = useState<HierarchySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Fetching boundaries needs the turbopass service; say so up front when it's missing.
  // One /health read serves both the Fetch sources and Preconfigured.
  const health = useTurbopassHealth();
  const boundarySources = health?.sources ?? null;
  // "Preconfigured": the official set turbopass holds for the tenant's country.
  const preconfigured = usePreconfiguredBoundaries(tenant, health?.officialCountries ?? null);
  const workspace = preconfigured.workspaceName ?? tenant;

  useEffect(() => {
    let cancelled = false;
    loadHierarchies(tenant)
      .then((loaded) => {
        if (cancelled) return;
        setHierarchies(loaded);
        setLoadError(null);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, reloadKey]);

  const reload = () => {
    setHierarchies(null);
    setReloadKey((key) => key + 1);
  };

  // Saved boundaries can't be changed: boundary-service has no delete.
  const hasBoundaries = !!hierarchies?.some((hierarchy) => hierarchy.total > 0);
  const locked = hasBoundaries;
  const pending = !locked && !!draft;

  // A draft lives in this tab's memory only: say so before a reload or close drops it.
  useEffect(() => {
    if (!pending && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, saving]);

  const { probe, recheck } = useStepProbe(
    state.tenant,
    'GEOGRAPHY',
    (hierarchies ?? []).map((hierarchy) => `${hierarchy.hierarchyType}:${hierarchy.total}`).join(','),
  );
  // With a draft, Save and continue saves it first, so the server's check can't pass yet.
  const gate = pending
    ? { disabled: saving, hint: undefined, canRecheck: false }
    : probeGate(
        'GEOGRAPHY',
        {
          ready: hasBoundaries,
          hint: hierarchies && !hasBoundaries ? t('geography.gate_hint', 'Bring in a boundary hierarchy to continue.') : undefined,
        },
        probe,
      );

  /** Writes the draft. True when every area landed; anything else stays on screen. */
  const saveDraft = async (toSave: BoundaryDraft): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveBoundaryDraft(tenant, toSave, t);
      if (result.created.length === 0) {
        // The hierarchy itself may have been defined: Excel's "use an existing hierarchy" should see it.
        reload();
        const reason = result.failed[0]?.error;
        const total = areas(toSave.boundaries.length, t);
        setSaveError(
          reason
            ? t(
                'geography.save_none_reason',
                'None of the %{areas} could be saved: %{reason} Your selection is kept, so you can edit it or try again.',
                { areas: total, reason },
              )
            : t('geography.save_none', 'None of the %{areas} could be saved. Your selection is kept, so you can edit it or try again.', {
                areas: total,
              }),
        );
        return false;
      }
      setBoundaryDraft(tenant, null);
      reload();
      const problems = [
        result.failed.length
          ? t('geography.save_some_failed', '%{failed} of %{areas} couldn\'t be saved: %{reason}', {
              failed: result.failed.length.toLocaleString('en-US'),
              areas: areas(toSave.boundaries.length, t),
              reason: result.failed[0].error,
            })
          : null,
        result.schemaError,
      ].filter(Boolean);
      if (problems.length) {
        setSaveError(problems.join(' '));
        return false;
      }
      toast({ title: t('geography.saved_toast', 'Boundaries saved') });
      return true;
    } catch (err) {
      console.error(err);
      reportStepError('geography', 'save_boundaries', err, tenant);
      const reason = err instanceof MessageError ? t(err.key, err.english, err.params) : reasonOf(err);
      setSaveError(t('geography.save_failed', 'Your boundaries weren\'t saved: %{reason}', { reason }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (importing) {
    const close = () => setImporting(null);
    const official = importing.preconfigured;
    return (
      <div className="space-y-6">
        <StepHeader
          eyebrow={t('steps.geography', 'Geography')}
          title={
            official
              ? t('geography.preconfigured_title', 'Preconfigured boundaries')
              : importing.source === 'osm'
                ? t('geography.fetch_title', 'Fetch boundaries')
                : t('geography.excel_title', 'Upload from Excel')
          }
          done={done}
        >
          {official
            ? t(
                'geography.preconfigured_intro',
                'Official boundaries for %{country}. Search for your city or region, then pick which levels become your boundary hierarchy.',
                { country: countryName(official.country) },
              )
            : importing.source === 'osm'
              ? t('geography.fetch_intro', 'Search for your area and pick which administrative levels become your boundary hierarchy.')
              : t('geography.excel_intro', 'Define your levels, fill the template with your areas, and upload it.')}
        </StepHeader>
        <BoundaryImport
          source={importing.source}
          hasHierarchies={!!hierarchies?.length}
          sourceChoices={boundarySources}
          preconfigured={official}
          resume={importing.resume}
          onCancel={close}
          onDone={(chosen) => {
            setBoundaryDraft(tenant, chosen);
            setSaveError(null);
            close();
            toast({
              title: t('geography.selected_toast', 'Boundaries selected'),
              description: t('geography.selected_toast_body', 'Check them, then Save and continue to save them.'),
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <StepHeader eyebrow={t('step.your_account', 'Your account')} title={t('steps.geography', 'Geography')} done={done}>
        {t('geography.intro', 'The boundary hierarchies your complaint services work in. Bring them in from one of three sources.')}
      </StepHeader>

      {!locked && (
        <Alert variant="info" data-testid="geography-save-notice">
          <Info className="h-4 w-4" />
          <AlertDescription>
            <span className="font-medium">{t('geography.save_notice_title', 'Boundaries can\'t be changed once saved.')}</span>{' '}
            {t(
              'geography.save_notice_body',
              'Nothing is saved until you select Save and continue, so check them here first: until then you can edit or remove them.',
            )}
          </AlertDescription>
        </Alert>
      )}

      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('geography.load_failed', 'Couldn’t load your boundaries. %{reason}', { reason: loadError })}</span>
            <Button variant="outline" size="sm" onClick={reload}>
              {t('common.try_again', 'Try again')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !hierarchies ? (
        <div className="h-40 rounded-lg border border-dashed border-border bg-muted/40 animate-pulse" aria-busy="true" />
      ) : locked ? (
        <section className="space-y-3" data-testid="geography-saved">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" />
            {t('geography.saved_locked', 'Saved. Boundaries can\'t be edited or removed after they are saved.')}
          </p>
          <ul className="space-y-3">
            {hierarchies.map((hierarchy) => (
              <li key={hierarchy.hierarchyType} className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{hierarchy.hierarchyType}</p>
                  <p className="text-sm text-muted-foreground">{summaryLine(hierarchy, t)}</p>
                  {hierarchy.levels.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">{hierarchy.levels.join(' → ')}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : draft ? (
        <div className="space-y-4">
          <BoundaryDraftCard
            draft={draft}
            disabled={saving}
            onEdit={() => setImporting({ source: draft.source, preconfigured: draft.preconfigured, resume: draft.resume })}
            onRemove={() => {
              setBoundaryDraft(tenant, null);
              setSaveError(null);
            }}
          />
          {saving && (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4" aria-busy="true" data-testid="geography-saving">
              <Loader2 className="mt-0.5 h-5 w-5 flex-shrink-0 animate-spin text-primary" />
              <div>
                <p className="font-medium text-foreground">
                  {t('geography.saving', 'Saving %{areas} to %{workspace}…', { areas: areas(draft.boundaries.length, t), workspace })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('geography.saving_body', 'A large set can take a few minutes. Keep this page open.')}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <EmptyState icon={MapPin} title={t('geography.empty_title', 'No boundaries yet')}>
            {t(
              'geography.empty_body_below',
              'Your complaint services are routed inside a boundary hierarchy: countries, districts, wards. Bring one in from a source below to get started.',
            )}
          </EmptyState>
          <section className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground">
              {t('geography.how_heading', 'How do you want to bring in your geography?')}
            </h3>
            {/* Three across only from lg: with the onboarding sidebar open on a tablet
                (820px), three cards are ~156px and the Preconfigured button overflows. */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:gap-6">
              <PreconfiguredCard
                state={preconfigured.state}
                onRetry={preconfigured.retry}
                onUse={() => {
                  if (preconfigured.state.status !== 'ready') return;
                  setImporting({ source: 'osm', preconfigured: preconfigured.state.set, resume: null });
                }}
              />
              <OptionCard
                icon={MapPin}
                title={t('geography.fetch_title', 'Fetch boundaries')}
                action={t('geography.fetch_action', 'Search boundaries')}
                onClick={() => setImporting({ source: 'osm', preconfigured: null, resume: null })}
                disabledReason={
                  boundarySources?.length === 0 ? t('geography.turbopass_unavailable', TURBOPASS_UNAVAILABLE_MESSAGE) : undefined
                }
              >
                {t(
                  'geography.fetch_body',
                  'Pull administrative boundaries, with map polygons, from the official sets (OCHA COD-AB, geoBoundaries) or OpenStreetMap.',
                )}
              </OptionCard>
              <OptionCard
                icon={Download}
                title={t('geography.excel_title', 'Upload from Excel')}
                action={t('common.upload_file', 'Upload a file')}
                onClick={() => setImporting({ source: 'excel', preconfigured: null, resume: null })}
              >
                {t('geography.excel_body', 'Bring in your own levels and areas from a spreadsheet.')}
              </OptionCard>
            </div>
          </section>
        </div>
      )}

      {saveError && (
        <Alert variant="destructive" data-testid="geography-save-error">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <StepActions
          onBack={previous && !saving ? () => navigate(previous.path) : undefined}
          onContinue={async () => {
            if (pending && draft && !(await saveDraft(draft))) return;
            if (!await completePhase(STEP.number)) return;
            if (next) navigate(next.path);
          }}
          busy={saving}
          disabled={gate.disabled}
          hint={gate.hint}
        />
        {gate.canRecheck && (
          <Button variant="ghost" size="sm" onClick={recheck}>
            {t('probe.check_again', 'Check again')}
          </Button>
        )}
      </div>
    </div>
  );
}
