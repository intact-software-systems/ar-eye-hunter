import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';
import { AnalyzeEvidenceQuality } from './AnalyzeEvidenceQuality.tsx';
import { AnalyzeEvidenceSearch } from './AnalyzeEvidenceSearch.tsx';
import { AnalyzeInspector } from './AnalyzeInspector.tsx';
import {
    createAnalyzeLegacyRunsHref,
    createAnalyzeLegacySharedTestHref,
} from './analyze-legacy-links.ts';
import { safeAnalyzeArtifactIdentity } from './analyze-identity-policy.ts';
import { AnalyzeMarkdown } from './AnalyzeMarkdown.tsx';
import { AnalyzePerformance } from './AnalyzePerformance.tsx';
import { AnalyzeSourcePanel } from './AnalyzeSourcePanel.tsx';
import { AnalyzeVerdict } from './AnalyzeVerdict.tsx';
import type { AnalyzeWorkspaceController } from './use-analyze-workspace.ts';
import styles from './AnalyzeWorkspace.module.css';

export function AnalyzeWorkspace({
    controller,
    urlState,
    onInspect,
    onInspectorChange,
    onSelectionLabelChange,
}: Readonly<{
    controller: AnalyzeWorkspaceController;
    urlState: RecipeConsoleUrlState;
    onInspect(trigger: HTMLElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>) {
    const renderCountRef = useRef(0);
    renderCountRef.current += 1;
    const inspector = useMemo(() => (
        controller.model && controller.selectedEvidence
            ? <AnalyzeInspector entry={controller.selectedEvidence} model={controller.model} />
            : undefined
    ), [controller.model, controller.selectedEvidence]);
    const sourceSearch = typeof window === 'undefined' ? '' : window.location.search;
    const loadedIdentity = controller.model
        ? safeAnalyzeArtifactIdentity(controller.model.identity)
        : undefined;
    const legacyState = controller.model
        ? {
            ...urlState,
            controlRunId: loadedIdentity?.controlRunId,
            distributedRunId: loadedIdentity?.distributedRunId,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        }
        : urlState;

    useEffect(() => {
        onInspectorChange(inspector);
        onSelectionLabelChange(controller.selectedEvidence
            ? `${evidenceKind(controller.selectedEvidence.kind)} · ${controller.selectedEvidence.summary}`
            : undefined);
    }, [controller.selectedEvidence, inspector, onInspectorChange, onSelectionLabelChange]);
    useEffect(() => () => {
        onInspectorChange(undefined);
        onSelectionLabelChange(undefined);
    }, [onInspectorChange, onSelectionLabelChange]);

    return (
        <div
            className={styles.workspace}
            data-analyze-index-count={controller.telemetry?.retainedEntryCount}
            data-analyze-index-omitted-count={controller.telemetry?.indexOmittedEntryCount}
            data-analyze-match-count={controller.telemetry?.matchedEntryCount}
            data-analyze-mounted-count={controller.searchResult?.entries.length ?? 0}
            data-analyze-operation-generation={controller.operationGeneration}
            data-analyze-pending-painted={
                controller.status === 'pending' &&
                controller.pendingPaintGeneration === controller.operationGeneration
                    ? 'true'
                    : undefined
            }
            data-analyze-render-count={renderCountRef.current}
            data-analyze-source-count={controller.telemetry?.sourceFileCount}
            data-analyze-total-entry-count={controller.telemetry?.totalEntryCount}
            data-analyze-workspace
        >
            <AnalyzeSourcePanel
                controller={controller}
                legacyRunsHref={createAnalyzeLegacyRunsHref(legacyState, sourceSearch)}
                legacySharedTestHref={createAnalyzeLegacySharedTestHref(sourceSearch)}
            />
            {controller.model ? (
                <>
                    <AnalyzeVerdict
                        model={controller.model}
                        onInspect={trigger => {
                            controller.selectEvidence(
                                controller.model?.firstActionableEvidenceId,
                            );
                            onInspect(trigger);
                        }}
                    />
                    <AnalyzeEvidenceQuality model={controller.model} />
                    <AnalyzePerformance model={controller.model} />
                    <AnalyzeEvidenceSearch
                        controller={controller}
                        onInspect={onInspect}
                        urlState={urlState}
                    />
                    <AnalyzeMarkdown model={controller.model} />
                </>
            ) : emptyState(controller)}
        </div>
    );
}

function emptyState(controller: AnalyzeWorkspaceController): ReactNode {
    if (controller.status === 'pending') {
        return (
            <StatePanel kind="empty" title="Reading artifact evidence">
                <p>The previous analysis stays available until this bounded operation completes.</p>
            </StatePanel>
        );
    }
    if (controller.error) {
        return (
            <StatePanel kind="error" title="Artifact was not loaded">
                <p>{controller.error}</p>
                <p>Select the bundle again or load a compatible distributed run. No candidate files were retained.</p>
            </StatePanel>
        );
    }
    return (
        <StatePanel kind="empty" title="Import distributed-run evidence">
            <p>Drop a CI bundle or choose JSON and JSONL files. Artifact bytes stay in memory and must be re-imported after reload.</p>
            <p>Generic black-box-runner exports remain available through the legacy Shared Test importer.</p>
        </StatePanel>
    );
}

function evidenceKind(kind: string): string {
    return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
}
