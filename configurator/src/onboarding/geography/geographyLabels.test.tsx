import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nContextProvider, type I18nProvider } from 'ra-core';
import type { Boundary } from '@/api/types';
import type { BoundaryDraft } from './boundaryDraft';
import { BoundaryDraftCard } from './BoundaryDraftCard';
import { PreconfiguredCard } from './PreconfiguredCard';

const FRENCH: Record<string, string> = {
  'app.onboarding.geography.draft.not_saved': 'Pas encore enregistré',
  'app.onboarding.geography.draft.summary': '%{areas} depuis %{source}.',
  'app.onboarding.geography.created.area_other': '%{count} zones',
  'app.onboarding.geography.created.level': 'Niveau',
  'app.onboarding.common.edit': 'Modifier',
  'app.onboarding.geography.preconfigured_title': 'Limites préconfigurées',
  'app.onboarding.geography.preconfigured_coming_soon': 'Les limites préconfigurées pour %{country} arrivent bientôt.',
};

/** Like polyglot: the language's text, else the English default, filling only the params it was given. */
const french: I18nProvider = {
  translate: (key: string, options?: Record<string, unknown>) =>
    String(FRENCH[key] ?? options?._ ?? key).replace(/%\{(\w+)\}/g, (match, name: string) =>
      options && name in options ? String(options[name]) : match,
    ),
  changeLocale: async () => {},
  getLocale: () => 'fr_FR',
};

const inFrench = (node: ReactNode) => render(<I18nContextProvider value={french}>{node}</I18nContextProvider>);

describe('Geography in another language', () => {
  it('translates the unsaved selection card', () => {
    const area = (code: string, boundaryType: string): Boundary => ({ tenantId: 'ke', code, name: code, boundaryType, hierarchyType: 'ADMIN' });
    const draft: BoundaryDraft = {
      source: 'excel',
      hierarchyType: 'ADMIN',
      levels: ['County', 'Ward'],
      hierarchyExists: false,
      boundaries: [area('C1', 'County'), area('W1', 'Ward'), area('W2', 'Ward')],
      sourceText: 'your Excel upload',
      skipped: 0,
      attribution: null,
      preconfigured: null,
      resume: {
        kind: 'excel',
        hierarchy: { tenantId: 'ke', hierarchyType: 'ADMIN', boundaryHierarchy: [] },
        file: null,
        parsed: [],
        valid: [],
        invalid: [],
        polygonFile: null,
        polygonSidecar: null,
      },
    };
    inFrench(<BoundaryDraftCard draft={draft} onEdit={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Pas encore enregistré')).toBeTruthy();
    expect(screen.getByText('3 zones depuis your Excel upload.')).toBeTruthy();
    expect(screen.getByText('Niveau')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Modifier' })).toBeTruthy();
  });

  it('translates the Preconfigured card, and leaves a string with no translation in English', () => {
    inFrench(<PreconfiguredCard state={{ status: 'none', country: 'KE' }} onUse={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('Limites préconfigurées')).toBeTruthy();
    expect(screen.getByTestId('option-unavailable').textContent).toBe('Les limites préconfigurées pour Kenya arrivent bientôt.');
    inFrench(<PreconfiguredCard state={{ status: 'loading' }} onUse={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('Checking which boundaries we hold for your country…')).toBeTruthy();
  });
});
