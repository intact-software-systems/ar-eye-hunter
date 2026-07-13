import {
    useMemo,
    type ReactNode,
} from 'react';
import type { AnalyzeTuneArtifactFacade } from '../analyze/analyze-worker-contract.ts';
import {
    HistoryWorkspace,
    type HistoryWorkspaceProps,
} from '../history/HistoryWorkspace.tsx';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';
import {
    TuneCandidate,
    tuneCandidateFingerprint,
} from './TuneCandidate.tsx';
import { TuneCommandTiming } from './TuneCommandTiming.tsx';
import { TuneComparison } from './TuneComparison.tsx';
import { TuneHints } from './TuneHints.tsx';
import { TuneSourceSelection } from './TuneSourceSelection.tsx';
import { TuneStreamHealth } from './TuneStreamHealth.tsx';
import { buildTuneRunCatalog } from './tune-run-catalog.ts';
import { deriveTuneSelectionModel } from './tune-selection-model.ts';
import { deriveTuneWorkspaceSourceModel } from './tune-workspace-source-model.ts';
import { useTuneInspectionHost } from './use-tune-inspection-host.tsx';
import styles from './TuneWorkspace.module.css';

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
    refreshAfterCurrent,
}: TuneWorkspaceProps) {
    const catalog = useMemo(() => buildTuneRunCatalog({
        distributedRuns: query.snapshot?.distributedRuns ?? [],
        controlRuns: query.snapshot?.runs ?? [],
        retainedFacade: retained.model,
    }), [
        query.snapshot?.distributedRuns,
        query.snapshot?.runs,
        retained.model,
    ]);
    const sourceSearch = typeof window === 'undefined'
        ? ''
        : window.location.search;
    const source = useMemo(() => deriveTuneWorkspaceSourceModel({
        catalog,
        query,
        retained,
        sourceSearch,
        urlState,
    }), [
        catalog,
        query,
        retained.error,
        retained.model,
        retained.status,
        sourceSearch,
        urlState,
    ]);
    const selection = useMemo(() => deriveTuneSelectionModel({
        catalog,
        query,
        urlState,
    }), [catalog, query, urlState]);
    const inspect = useTuneInspectionHost({
        source,
        onInspect,
        onInspectorChange,
        onSelectionLabelChange,
    });

    return (
        <div
            className={styles.workspace}
            data-source-detail={source.provenance.detail}
            data-source-kind={source.provenance.source}
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
                key={tuneCandidateFingerprint(source)}
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
