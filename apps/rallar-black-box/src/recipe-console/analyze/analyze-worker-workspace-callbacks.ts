import type { Dispatch, SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import {
    completeAnalyzeWorkspaceOperation,
    failAnalyzeWorkspaceOperation,
    type AnalyzeWorkspaceState,
} from './analyze-workspace-state.ts';
import type {
    AnalyzeArtifactProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerErrorProjection,
    AnalyzeWorkerTelemetry,
} from './analyze-worker-contract.ts';
import type { AnalyzeWorkerClientCallbacks } from './analyze-worker-client.ts';
import { analyzeWorkerError } from './analyze-worker-error.ts';
import { analyzeCompletionNavigationIdentity } from
    './analyze-completion-navigation.ts';
import type { useAnalyzeEvidenceRequests } from
    './use-analyze-evidence-requests.ts';
import type {
    AnalyzeMutableRef,
    AnalyzePendingOperation,
} from './analyze-worker-workspace-adapter.ts';

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

export type AnalyzePendingIdentityPatch = Readonly<{
    generation: number;
    identity: AnalyzeArtifactProjection['identity'];
}>;

export function createAnalyzeWorkerWorkspaceCallbacks(input: Readonly<{
    pendingRef: AnalyzeMutableRef<AnalyzePendingOperation | undefined>;
    validationErrorRef: AnalyzeMutableRef<Error | undefined>;
    pendingIdentityPatchRef: AnalyzeMutableRef<
        AnalyzePendingIdentityPatch | undefined
    >;
    setState: StateSetter<AnalyzeWorkspaceState<AnalyzeArtifactProjection>>;
    evidence: ReturnType<typeof useAnalyzeEvidenceRequests>;
    setSelectedEvidence: StateSetter<
        AnalyzeEvidenceWindowProjection['entries'][number] | undefined
    >;
    setTuneFacade: StateSetter<AnalyzeTuneArtifactFacade | undefined>;
    setTelemetry: StateSetter<AnalyzeWorkerTelemetry | undefined>;
    setWorkerUnavailable: StateSetter<string | undefined>;
    setPendingPaintGeneration: StateSetter<number | undefined>;
}>): AnalyzeWorkerClientCallbacks {
    return {
        onPendingPaint(generation: number) {
            flushSync(() => input.setPendingPaintGeneration(generation));
        },
        onComplete(response) {
            const pending = input.pendingRef.current;
            if (pending?.authority.generation !== response.operationGeneration) return;
            const navigationIdentity = analyzeCompletionNavigationIdentity({
                action: pending.authority.action,
                expectedDistributedRunId: pending.authority.expectedDistributedRunId,
                expectedControlRunId: pending.authority.expectedControlRunId,
                projection: response.projection.identity,
            });
            input.pendingIdentityPatchRef.current = navigationIdentity
                ? { generation: response.operationGeneration, identity: navigationIdentity }
                : undefined;
            input.evidence.acceptInitial(response.initialWindow);
            input.setSelectedEvidence(response.selected);
            input.setTuneFacade(undefined);
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
            input.setState(previous => completeAnalyzeWorkspaceOperation(
                previous,
                pending.authority,
                {
                    artifact: response.projection,
                    selectedEvidenceId: response.selected?.id ??
                        response.projection.firstActionableEvidenceId,
                    controlIdentityValidated: response.controlIdentityValidated,
                },
            ));
            input.pendingRef.current = undefined;
            input.setPendingPaintGeneration(undefined);
            pending.resolve(true);
        },
        onSearchComplete(response) {
            if (!input.evidence.complete({
                kind: 'search',
                requestId: response.requestId,
                window: response.window,
            })) return;
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
            input.setSelectedEvidence(previous => previous &&
                response.window.entries.some(row => row.id === previous.id)
                ? previous
                : undefined);
        },
        onWindowComplete(response) {
            if (!input.evidence.complete({
                kind: 'window',
                requestId: response.requestId,
                window: response.window,
            })) return;
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
        },
        onSelectionComplete(response) {
            input.setSelectedEvidence(response.selected);
        },
        onTuneComplete(response) {
            input.setTuneFacade(response.facade);
            input.setWorkerUnavailable(undefined);
        },
        onFailure(error, operationGeneration, request) {
            const pending = input.pendingRef.current;
            if (!pending || pending.authority.generation !== operationGeneration) {
                if (error.stage === 'search' || error.stage === 'window') {
                    input.evidence.fail(
                        error.stage,
                        request?.requestId,
                    );
                }
                return;
            }
            const failure = input.validationErrorRef.current ?? analyzeWorkerError(error);
            input.validationErrorRef.current = undefined;
            input.setState(previous => failAnalyzeWorkspaceOperation(
                previous,
                pending.authority,
                failure,
            ));
            input.pendingRef.current = undefined;
            pending.resolve(false);
        },
        onUnavailable(reason, scope, request) {
            const pending = input.pendingRef.current;
            if (scope === 'candidate' && pending) {
                input.setState(previous => failAnalyzeWorkspaceOperation(
                    previous,
                    pending.authority,
                    new Error('The Analyze worker became unavailable before the candidate completed.'),
                ));
                input.pendingRef.current = undefined;
                pending.resolve(false);
                input.setPendingPaintGeneration(undefined);
            }
            if (scope === 'accepted-request') {
                if (
                    request?.kind === 'search' ||
                    request?.kind === 'window'
                ) {
                    input.evidence.fail(request.kind, request.requestId);
                }
                return;
            }
            if (scope === 'accepted-worker') {
                input.evidence.fail();
                input.setWorkerUnavailable(
                    `Analyze worker unavailable (${reason}); the last bounded projection and export remain available.`,
                );
            }
        },
    };
}
