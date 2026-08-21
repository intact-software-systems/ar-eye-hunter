import { useMemo, useRef, type ReactNode } from 'react';
import type { AnalyzeTuneArtifactFacade } from '../analyze/analyze-worker-contract.ts';
import { HistoryWorkspace, type HistoryWorkspaceProps } from '../history/HistoryWorkspace.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { tunePerformanceRunIds } from './tune-performance-run-ids.ts';
import {
    createTuneRunCatalogCache,
    tuneRunCatalogCacheWorkForTest,
    type TuneRunCatalogCache
} from './tune-run-catalog-cache.ts';
import { deriveTuneSelectionModel } from './tune-selection-model.ts';
import { deriveTuneWorkspaceSourceModel } from './tune-workspace-source-model.ts';
import { TuneCandidate } from './TuneCandidate.tsx';
import { TuneCommandTiming } from './TuneCommandTiming.tsx';
import { TuneComparison } from './TuneComparison.tsx';
import { TuneHints } from './TuneHints.tsx';
import { TuneSourceSelection } from './TuneSourceSelection.tsx';
import { TuneStreamHealth } from './TuneStreamHealth.tsx';
import styles from './TuneWorkspace.module.css';
import { useTuneInspectionHost } from './use-tune-inspection-host.tsx';

export type TuneWorkspaceProps = Readonly<{
    query: HistoryWorkspaceProps['query'];
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeTuneArtifactFacade;
        error?: string;
    }>;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onInspect(trigger: HTMLButtonElement): void;
    onCopyLink(): void;
    retention: HistoryWorkspaceProps['retention'];
    replace: HistoryWorkspaceProps['replace'];
    refreshAfterCurrent: HistoryWorkspaceProps['refreshAfterCurrent'];
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>;

export default function TuneWorkspace({
    query,
    retained,
    urlState,
    navigate,
    onInspect,
    onCopyLink,
    onInspectorChange,
    onSelectionLabelChange,
    retention,
    replace,
    refreshAfterCurrent
}: TuneWorkspaceProps) {
    const catalogCacheRef = useRef<TuneRunCatalogCache | undefined>(undefined);
    catalogCacheRef.current ??= createTuneRunCatalogCache();
    const catalog = catalogCacheRef.current.get({
        snapshot: query.snapshot,
        retainedFacade: retained.model,
        performanceRunIds: tunePerformanceRunIds(urlState)
    });
    const catalogCacheWork = tuneRunCatalogCacheWorkForTest(
        catalogCacheRef.current
    );
    const sourceSearch = typeof window === 'undefined'
        ? ''
        : window.location.search;
    const sourceTruth = useMemo(() =>
        deriveTuneWorkspaceSourceModel({
            catalog,
            query,
            retained,
            sourceSearch,
            urlState
        }), [
        catalog,
        query.status,
        retained.error,
        retained.model,
        retained.status,
        sourceSearch,
        urlState
    ]);
    const source = useMemo(() =>
        sourceTruth.provenance.source === 'control'
            ? {
                ...sourceTruth,
                provenance: {
                    ...sourceTruth.provenance,
                    generatedAtEpochMs: query.receivedAtEpochMs
                }
            }
            : sourceTruth, [query.receivedAtEpochMs, sourceTruth]);
    const selection = useMemo(() =>
        deriveTuneSelectionModel({
            catalog,
            query,
            urlState
        }), [catalog, urlState]);
    const inspect = useTuneInspectionHost({
        source,
        onInspect,
        onInspectorChange,
        onSelectionLabelChange
    });

    return (
        <div
            className={styles.workspace}
            data-source-detail={source.provenance.detail}
            data-source-kind={source.provenance.source}
            data-tune-refreshing={query.isRefreshing}
            data-tune-catalog-builds={catalogCacheWork?.catalogBuildCount ?? 0}
            data-tune-catalog-cache-hit={catalogCacheWork?.lastLookup.cacheHit ?? false}
            data-tune-catalog-cache-hits={catalogCacheWork?.hitCount ?? 0}
            data-tune-control-rows-indexed={catalog.work.controlRowsIndexed}
            data-tune-distributed-rows-indexed={catalog.work.distributedRowsIndexed}
            data-tune-identity-projections={catalog.work.identityProjections}
            data-tune-performance-derivations={catalog.work.performanceDerivations}
            data-tune-manifest-validations={catalog.work.manifestValidations}
            data-tune-manifest-identity-checks={catalog.work.manifestIdentityChecks}
            data-tune-workspace
        >
            <TuneSourceSelection
                navigate={navigate}
                selection={selection}
                source={source}
                urlState={urlState}
            />
            <div className={styles.evidencePlane} data-tune-evidence-plane>
                <TuneCommandTiming
                    onInspect={inspect}
                    performance={source.performance}
                />
                <TuneStreamHealth
                    onInspect={inspect}
                    performance={source.performance}
                />
            </div>
            <TuneHints onInspect={inspect} source={source} />
            <TuneCandidate
                onInspect={inspect}
                source={source}
            />
            <TuneComparison selection={selection} />
            <HistoryWorkspace
                navigate={navigate}
                onCopyLink={onCopyLink}
                query={query}
                refreshAfterCurrent={refreshAfterCurrent}
                replace={replace}
                retention={retention}
                urlState={urlState}
            />
        </div>
    );
}
