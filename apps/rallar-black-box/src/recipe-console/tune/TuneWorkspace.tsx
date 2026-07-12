import {
    useMemo,
    type ReactNode,
} from 'react';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
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
import { deriveTuneSourceModel } from './tune-source-model.ts';
import { useTuneInspectionHost } from './use-tune-inspection-host.tsx';
import styles from './TuneWorkspace.module.css';

export type TuneWorkspaceProps = Readonly<{
    query: HistoryWorkspaceProps['query'];
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeArtifactModel;
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
    const focusRunId = urlState.compareRight ?? urlState.distributedRunId;
    const catalog = useMemo(() => buildTuneRunCatalog({
        distributedRuns: query.snapshot?.distributedRuns ?? [],
        controlRuns: query.snapshot?.runs ?? [],
        retainedArtifact: retained.model,
        retainedArtifactStatus: retained.status,
        retainedArtifactFocusRunId: focusRunId,
    }), [
        focusRunId,
        query.snapshot?.distributedRuns,
        query.snapshot?.runs,
        retained.model,
        retained.status,
    ]);
    const sourceSearch = typeof window === 'undefined'
        ? ''
        : window.location.search;
    const source = useMemo(() => deriveTuneSourceModel({
        catalog,
        query,
        retained: {
            status: retained.status,
            model: retained.model,
            error: retained.error,
        },
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
        retainedArtifact: retained.model,
        urlState,
    }), [catalog, query, retained.model, urlState]);
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
