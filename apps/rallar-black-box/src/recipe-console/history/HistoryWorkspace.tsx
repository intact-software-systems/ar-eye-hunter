import { useMemo, useState } from 'react';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import { createAnalyzeLegacyRunsHref } from
    '../analyze/analyze-legacy-links.ts';
import type { RecipeConsoleControlQueryProvenance } from
    '../control/control-api.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';
import {
    StatusMark,
    type OperationalStatus,
} from '../ui/StatusMark.tsx';
import { HistoryFilters } from './HistoryFilters.tsx';
import { HistorySavedFilters } from './HistorySavedFilters.tsx';
import { HistoryTable } from './HistoryTable.tsx';
import {
    historyFilterPresetApplyPatch,
    type HistoryFilterPreset,
} from './history-filter-contract.ts';
import {
    deriveRecipeConsoleHistoryModel,
    type RecipeConsoleHistoryProvenance,
} from './history-model.ts';
import { useHistoryFilterPresets } from './use-history-filter-presets.ts';
import { historyUtcDisplay } from './history-utc.ts';
import styles from './HistoryWorkspace.module.css';

export type HistoryWorkspaceProps = Readonly<{
    query: ControlQuerySnapshot<
        ControlServerSnapshot,
        RecipeConsoleControlQueryProvenance
    >;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onCopyLink(): void;
}>;

export function HistoryWorkspace({
    query,
    urlState,
    navigate,
    onCopyLink,
}: HistoryWorkspaceProps) {
    const model = useMemo(() => deriveRecipeConsoleHistoryModel({
        query,
        urlState,
    }), [query, urlState]);
    const presets = useHistoryFilterPresets({ committedUrlState: urlState });
    const [resetRevision, setResetRevision] = useState(0);
    const sourceSearch = typeof window === 'undefined' ? '' : window.location.search;
    const legacyRunsHref = createAnalyzeLegacyRunsHref({
        v: 1,
        experience: 'recipe-console',
        view: 'tune',
    }, sourceSearch);
    const historyAvailable = model.provenance.distributedRunsSource !== 'unavailable' &&
        query.snapshot?.distributedRuns !== undefined;

    function commitFilters(patch: Partial<RecipeConsoleUrlState>): void {
        navigate(patch);
    }

    function resetFilters(patch: Partial<RecipeConsoleUrlState>): void {
        navigate(patch);
        setResetRevision(revision => revision + 1);
    }

    function applyPreset(preset: HistoryFilterPreset): void {
        navigate(historyFilterPresetApplyPatch(preset));
        setResetRevision(revision => revision + 1);
    }

    return (
        <section
            aria-labelledby="server-run-history-heading"
            className={styles.workspace}
            data-history-workspace
        >
            <header className={styles.heading}>
                <div className={styles.headingTop}>
                    <div className={styles.title}>
                        <h2 id="server-run-history-heading">Server run history</h2>
                        <StatusMark
                            label={provenanceLabel(model.provenance)}
                            status={provenanceTone(model.provenance)}
                        />
                    </div>
                    <div className={styles.actions}>
                        <button onClick={onCopyLink} type="button">
                            Copy filtered link
                        </button>
                        <a href={legacyRunsHref}>Open legacy Runs</a>
                    </div>
                </div>
                <p className={styles.summary}>{filterSummary(urlState)}</p>
                {historyNotice(model.provenance) ? (
                    <p className={styles.notice} role="status">
                        {historyNotice(model.provenance)}
                    </p>
                ) : null}
            </header>

            <HistoryFilters
                onApply={commitFilters}
                onReset={resetFilters}
                resetRevision={resetRevision}
                urlState={urlState}
            />
            <HistorySavedFilters controller={presets} onApply={applyPreset} />

            {!historyAvailable ? (
                <StatePanel kind="error" title="History unavailable">
                    <p>{query.lastError?.message ??
                        'The root query has no distributed-run history.'}</p>
                </StatePanel>
            ) : (
                <>
                    {model.counts.total === 0 ? (
                        <StatePanel kind="empty" title="No runs match these filters">
                            <p>Reset or adjust the committed History filters.</p>
                        </StatePanel>
                    ) : null}
                    <HistoryTable
                        model={model}
                        onBaseline={navigate}
                        onCandidate={navigate}
                    />
                </>
            )}
        </section>
    );
}

function provenanceLabel(value: RecipeConsoleHistoryProvenance): string {
    const source = value.distributedRunsSource === 'root-snapshot'
        ? 'Root snapshot'
        : value.distributedRunsSource === 'canonical-fallback'
        ? 'Canonical fallback'
        : 'Source unavailable';
    return `${source} · ${value.completeness} · ${value.freshness}`;
}

function provenanceTone(value: RecipeConsoleHistoryProvenance): OperationalStatus {
    if (value.status === 'offline') return 'failed';
    if (value.freshness === 'unavailable') return 'disabled';
    if (value.freshness === 'last-known') return 'stale';
    if (value.completeness === 'partial') return 'partial';
    return value.status === 'live' ? 'passed' : 'running';
}

function historyNotice(value: RecipeConsoleHistoryProvenance): string | undefined {
    if (value.freshness === 'last-known') {
        return 'Showing last-known server history while the root query recovers.';
    }
    if (value.completeness === 'partial') {
        return 'History is partial; unavailable evidence is not inferred.';
    }
    return undefined;
}

function filterSummary(state: RecipeConsoleUrlState): string {
    const parts = [
        state.historyQuery && `Text “${state.historyQuery}”`,
        state.historyGroup && `Group ${state.historyGroup}`,
        state.historyRecipeId && `Recipe ${state.historyRecipeId}`,
        state.historyProfile && `Profile ${state.historyProfile}`,
        state.failureCategory && `Failure ${state.failureCategory}`,
        state.status && `Status ${state.status}`,
        state.from !== undefined && `From ${historyUtcDisplay(state.from)}`,
        state.to !== undefined && `To ${historyUtcDisplay(state.to)}`,
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' · ') : 'All server runs';
}
