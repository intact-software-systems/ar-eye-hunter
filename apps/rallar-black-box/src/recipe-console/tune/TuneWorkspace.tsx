import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';
import {
    TuneCandidate,
    tuneCandidateFingerprint,
} from './TuneCandidate.tsx';
import { TuneCommandTiming } from './TuneCommandTiming.tsx';
import { TuneComparison } from './TuneComparison.tsx';
import { TuneHints } from './TuneHints.tsx';
import { TuneInspector } from './TuneInspector.tsx';
import { TuneSourceSelection } from './TuneSourceSelection.tsx';
import { TuneStreamHealth } from './TuneStreamHealth.tsx';
import {
    tuneInspectionAuthority,
    tuneInspectionLabel,
    type TuneInspection,
} from './tune-inspection.ts';
import { buildTuneRunCatalog } from './tune-run-catalog.ts';
import { deriveTuneSelectionModel } from './tune-selection-model.ts';
import { deriveTuneSourceModel } from './tune-source-model.ts';
import styles from './TuneWorkspace.module.css';

export type TuneWorkspaceProps = Readonly<{
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeArtifactModel;
        error?: string;
    }>;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onInspect(trigger: HTMLButtonElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>;

export default function TuneWorkspace({
    query,
    retained,
    urlState,
    navigate,
    onInspect,
    onInspectorChange,
    onSelectionLabelChange,
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
    const inspectionAuthority = tuneInspectionAuthority(source);
    const [scopedInspection, setScopedInspection] = useState<Readonly<{
        authority: string;
        selection: TuneInspection;
    }>>();
    const inspection = scopedInspection?.authority === inspectionAuthority
        ? scopedInspection.selection
        : undefined;
    const inspector = useMemo(() => inspection ? (
        <TuneInspector selection={inspection} source={source} />
    ) : undefined, [inspection, source]);
    const inspect = useCallback((
        next: TuneInspection,
        trigger: HTMLButtonElement,
    ) => {
        setScopedInspection({
            authority: inspectionAuthority,
            selection: next,
        });
        onInspect(trigger);
    }, [inspectionAuthority, onInspect]);

    useLayoutEffect(() => {
        onInspectorChange(inspector);
        onSelectionLabelChange(inspection
            ? tuneInspectionLabel(inspection)
            : undefined);
    }, [
        inspection,
        inspector,
        onInspectorChange,
        onSelectionLabelChange,
    ]);
    useEffect(() => {
        if (
            scopedInspection &&
            scopedInspection.authority !== inspectionAuthority
        ) {
            setScopedInspection(undefined);
        }
    }, [inspectionAuthority, scopedInspection]);
    useEffect(() => () => {
        onInspectorChange(undefined);
        onSelectionLabelChange(undefined);
    }, [onInspectorChange, onSelectionLabelChange]);

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
        </div>
    );
}
