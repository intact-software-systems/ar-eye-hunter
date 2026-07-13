import { searchDistributedArtifactEvidenceWindow } from
    '@shared-test/rallar-bb-test/mod.ts';
import {
    analyzeEvidenceEntryMatchesProjectedId,
    projectAnalyzeEvidenceEntry,
    projectAnalyzeEvidenceWindow,
    projectAnalyzeTuneArtifactFacade,
} from './analyze-artifact-projection.ts';
import {
    ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    type AnalyzeWorkerEnvelope,
    type AnalyzeWorkerErrorProjection,
    type AnalyzeWorkerRequest,
} from './analyze-worker-contract.ts';
import {
    analyzeWorkerDuration,
    analyzeWorkerTelemetry,
    type AnalyzeWorkerActiveModel,
} from './analyze-worker-runtime-model.ts';

type RpcRequest = Extract<
    AnalyzeWorkerRequest,
    { type: 'search' | 'window' | 'select' | 'tune' }
>;

export type AnalyzeWorkerRpcRuntime = Readonly<{
    reset(queryGeneration?: number): void;
    handle(request: RpcRequest): Promise<void>;
}>;

export function createAnalyzeWorkerRpcRuntime(input: Readonly<{
    getActive(): AnalyzeWorkerActiveModel | undefined;
    isDisposed(): boolean;
    now(): number;
    post(envelope: AnalyzeWorkerEnvelope): void;
    fail(
        error: AnalyzeWorkerErrorProjection,
        request?: Readonly<{ requestId?: number }>,
    ): void;
}>): AnalyzeWorkerRpcRuntime {
    let queryGeneration = -1;
    let windowGeneration = -1;
    let selectionGeneration = -1;
    let tuneGeneration = -1;

    function reset(nextQueryGeneration = -1): void {
        queryGeneration = nextQueryGeneration;
        windowGeneration = -1;
        selectionGeneration = -1;
        tuneGeneration = -1;
    }

    async function handle(request: RpcRequest): Promise<void> {
        if (request.type === 'search') await search(request);
        else if (request.type === 'window') await window(request);
        else if (request.type === 'select') select(request);
        else tune(request);
    }

    async function search(
        request: Extract<RpcRequest, { type: 'search' }>,
    ): Promise<void> {
        const snapshot = input.getActive();
        if (!snapshot || request.queryGeneration <= queryGeneration) return;
        queryGeneration = request.queryGeneration;
        windowGeneration = -1;
        const startedAt = input.now();
        const result = await searchDistributedArtifactEvidenceWindow(snapshot.catalog, {
            query: request.query,
            windowSize: ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
        });
        if (
            !result.ok || input.getActive() !== snapshot || input.isDisposed() ||
            request.queryGeneration !== queryGeneration
        ) {
            if (!result.ok && input.getActive() === snapshot && !input.isDisposed()) {
                input.fail(
                    { code: 'invalid-request', stage: 'search', recoverable: true },
                    { requestId: request.requestId },
                );
            }
            return;
        }
        input.post({ message: {
            type: 'search-complete',
            modelGeneration: snapshot.generation,
            queryGeneration: request.queryGeneration,
            requestId: request.requestId,
            window: projectAnalyzeEvidenceWindow(result.window),
            telemetry: analyzeWorkerTelemetry(
                snapshot, result.window, analyzeWorkerDuration(input.now(), startedAt),
            ),
        } });
    }

    async function window(
        request: Extract<RpcRequest, { type: 'window' }>,
    ): Promise<void> {
        const snapshot = input.getActive();
        if (!snapshot || request.queryGeneration !== queryGeneration ||
            request.windowGeneration <= windowGeneration) return;
        windowGeneration = request.windowGeneration;
        const startedAt = input.now();
        const result = await searchDistributedArtifactEvidenceWindow(snapshot.catalog, {
            query: request.query,
            cursor: request.cursor,
            windowSize: ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
        });
        if (
            !result.ok || input.getActive() !== snapshot || input.isDisposed() ||
            request.windowGeneration !== windowGeneration ||
            request.queryGeneration !== queryGeneration
        ) {
            if (!result.ok && input.getActive() === snapshot && !input.isDisposed()) {
                input.fail(
                    { code: 'invalid-request', stage: 'window', recoverable: true },
                    { requestId: request.requestId },
                );
            }
            return;
        }
        input.post({ message: {
            type: 'window-complete',
            modelGeneration: snapshot.generation,
            queryGeneration: request.queryGeneration,
            windowGeneration: request.windowGeneration,
            requestId: request.requestId,
            window: projectAnalyzeEvidenceWindow(result.window),
            telemetry: analyzeWorkerTelemetry(
                snapshot, result.window, analyzeWorkerDuration(input.now(), startedAt),
            ),
        } });
    }

    function select(request: Extract<RpcRequest, { type: 'select' }>): void {
        const snapshot = input.getActive();
        if (!snapshot || request.selectionGeneration <= selectionGeneration) return;
        selectionGeneration = request.selectionGeneration;
        const selected = request.evidenceId
            ? snapshot.catalog.entries.find(row =>
                  analyzeEvidenceEntryMatchesProjectedId(row, request.evidenceId!)
              )
            : undefined;
        input.post({ message: {
            type: 'selection-complete',
            modelGeneration: snapshot.generation,
            selectionGeneration: request.selectionGeneration,
            requestId: request.requestId,
            ...(selected ? { selected: projectAnalyzeEvidenceEntry(selected) } : {}),
        } });
    }

    function tune(request: Extract<RpcRequest, { type: 'tune' }>): void {
        const snapshot = input.getActive();
        if (!snapshot || request.tuneGeneration <= tuneGeneration) return;
        tuneGeneration = request.tuneGeneration;
        const startedAt = input.now();
        input.post({ message: {
            type: 'tune-complete',
            modelGeneration: snapshot.generation,
            tuneGeneration: request.tuneGeneration,
            requestId: request.requestId,
            facade: projectAnalyzeTuneArtifactFacade(snapshot.model, request),
            telemetry: analyzeWorkerTelemetry(
                snapshot, undefined, analyzeWorkerDuration(input.now(), startedAt),
            ),
        } });
    }

    return { reset, handle };
}
