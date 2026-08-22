import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { useMemo, useState } from 'react';
import type {
    RecipeConsoleControlQueryProvenance,
    RecipeConsoleControlRetentionCapability
} from '../control/control-api.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';
import { historyFilterPresetApplyPatch, type HistoryFilterPreset } from './history-filter-contract.ts';
import { createRecipeConsoleHistoryCollection, deriveRecipeConsoleHistoryWindow } from './history-model.ts';
import { HistoryFilters } from './HistoryFilters.tsx';
import { HistoryHeader } from './HistoryHeader.tsx';
import { HistoryRetentionWorkspace } from './HistoryRetentionWorkspace.tsx';
import { HistorySavedFilters } from './HistorySavedFilters.tsx';
import { HistoryTable } from './HistoryTable.tsx';
import styles from './HistoryWorkspace.module.css';
import { useHistoryFilterPresets } from './use-history-filter-presets.ts';
import { useHistoryWindow } from './use-history-window.ts';

export type HistoryWorkspaceProps = Readonly<{
    query: ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance>;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onCopyLink(): void;
    retention?: RecipeConsoleControlRetentionCapability;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    refreshAfterCurrent(): Promise<void>;
}>;

export function HistoryWorkspace({
    query,
    urlState,
    navigate,
    onCopyLink,
    retention,
    replace,
    refreshAfterCurrent
}: HistoryWorkspaceProps) {
    const collection = useMemo(() =>
        createRecipeConsoleHistoryCollection({
            query,
            urlState
        }), [query, urlState]);
    const historyWindow = useHistoryWindow(collection);
    const model = useMemo(() =>
        deriveRecipeConsoleHistoryWindow(
            collection,
            historyWindow.model.startIndex
        ), [collection, historyWindow.model.startIndex]);
    const presets = useHistoryFilterPresets({ committedUrlState: urlState });
    const [resetRevision, setResetRevision] = useState(0);
    const historyAvailable = model.provenance.distributedRunsSource !== 'unavailable' &&
        query.snapshot?.distributedRuns !== undefined;

    function commitFilters(patch: Partial<RecipeConsoleUrlState>): void {
        navigate(patch);
    }

    function resetFilters(patch: Partial<RecipeConsoleUrlState>): void {
        navigate(patch);
        setResetRevision((revision) => revision + 1);
    }

    function applyPreset(preset: HistoryFilterPreset): void {
        navigate(historyFilterPresetApplyPatch(preset));
        setResetRevision((revision) => revision + 1);
    }

    return (
        <section
            aria-labelledby="server-run-history-heading"
            className={styles.workspace}
            data-history-workspace
        >
            <HistoryHeader
                onCopyLink={onCopyLink}
                provenance={model.provenance}
                urlState={urlState}
            />

            <HistoryFilters
                onApply={commitFilters}
                onReset={resetFilters}
                resetRevision={resetRevision}
                urlState={urlState}
            />
            <HistorySavedFilters controller={presets} onApply={applyPreset} />

            {!historyAvailable
                ? (
                    <StatePanel kind="error" title="History unavailable">
                        <p>
                            {query.lastError?.message ??
                                'The root query has no distributed-run history.'}
                        </p>
                    </StatePanel>
                )
                : (
                    <>
                        {model.counts.total === 0
                            ? (
                                <StatePanel kind="empty" title="No runs match these filters">
                                    <p>Reset or adjust the committed History filters.</p>
                                </StatePanel>
                            )
                            : null}
                        <HistoryTable
                            collectionWork={collection.work}
                            model={model}
                            onBaseline={navigate}
                            onCandidate={navigate}
                            window={historyWindow}
                        />
                    </>
                )}
            <HistoryRetentionWorkspace
                authorization={query.authorization}
                capability={retention}
                lastError={query.lastError}
                refreshAfterCurrent={refreshAfterCurrent}
                replace={replace}
                urlState={urlState}
            />
        </section>
    );
}
