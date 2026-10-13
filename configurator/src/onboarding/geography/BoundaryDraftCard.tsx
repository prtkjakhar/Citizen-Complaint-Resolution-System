import { MapPin, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { draftCounts, type BoundaryDraft } from './boundaryDraft';
import { useOnboardingT } from '../i18n';

/**
 * The boundaries chosen in Geography, before Save and continue writes them:
 * what is in them level by level, where they came from, and the ways to change
 * the choice. Nothing here is on the server yet.
 */
export function BoundaryDraftCard({
  draft,
  onEdit,
  onRemove,
  disabled = false,
}: {
  draft: BoundaryDraft;
  onEdit: () => void;
  onRemove: () => void;
  /** While the draft is being saved. */
  disabled?: boolean;
}) {
  const t = useOnboardingT();
  const counts = draftCounts(draft);
  const total = draft.boundaries.length;
  const n = (count: number) =>
    count === 1
      ? t('geography.created.area_one', '%{count} area', { count: count.toLocaleString('en-US') })
      : t('geography.created.area_other', '%{count} areas', { count: count.toLocaleString('en-US') });
  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4" data-testid="boundary-draft">
      <div className="flex flex-wrap items-start gap-3">
        <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <MapPin className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-foreground">{draft.hierarchyType}</h3>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
              {t('geography.draft.not_saved', 'Not saved yet')}
            </span>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {t('geography.draft.summary', '%{areas} from %{source}.', { areas: n(total), source: draft.sourceText })}
          </p>
          <p className="text-xs text-muted-foreground">{draft.levels.join(' → ')}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={disabled} className="gap-1.5">
            <Pencil className="w-4 h-4" />
            {t('common.edit', 'Edit')}
          </Button>
          <DeleteConfirmDialog
            title={t('geography.draft.remove_title', 'Remove these boundaries?')}
            description={t(
              'geography.draft.remove_body',
              'They haven\'t been saved, so nothing else changes. You can choose boundaries again from any source.',
            )}
            onConfirm={onRemove}
            disabled={disabled}
            trigger={
              <Button variant="ghost" size="sm" disabled={disabled} className="gap-1.5 text-destructive hover:text-destructive">
                <Trash2 className="w-4 h-4" />
                {t('common.remove', 'Remove')}
              </Button>
            }
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('geography.created.level', 'Level')}</TableHead>
              <TableHead className="text-right">{t('geography.created.areas', 'Areas')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.levels.map((level, i) => (
              <TableRow key={level}>
                <TableCell>
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-xs font-medium text-primary">
                    {i + 1}
                  </span>
                  {level}
                </TableCell>
                <TableCell className="text-right tabular-nums">{(counts[level] ?? 0).toLocaleString('en-US')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">{t('geography.created.total', 'Total')}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{total.toLocaleString('en-US')}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {(draft.skipped > 0 || draft.attribution) && (
        <div className="space-y-1 text-sm text-muted-foreground">
          {draft.skipped > 0 && (
            <p>
              {draft.skipped === 1
                ? t('geography.draft.skipped_one', '%{count} area was left out: unnamed, or lying in no area of the level above.', {
                    count: draft.skipped.toLocaleString('en-US'),
                  })
                : t('geography.draft.skipped_other', '%{count} areas were left out: unnamed, or lying in no area of the level above.', {
                    count: draft.skipped.toLocaleString('en-US'),
                  })}
            </p>
          )}
          {draft.attribution && (
            <p className="text-xs" data-testid="boundary-attribution">
              {draft.attribution}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
