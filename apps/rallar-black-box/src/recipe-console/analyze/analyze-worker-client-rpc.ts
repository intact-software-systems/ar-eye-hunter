import type { DistributedArtifactEvidenceWindowQuery } from
    '@shared-test/rallar-bb-test/mod.ts';
import {
    ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    type AnalyzeWorkerRequest,
    type AnalyzeWorkerResponse,
} from './analyze-worker-contract.ts';
import type { AnalyzeWorkerPort } from './analyze-worker-factory.ts';
import { isAnalyzeWorkerRequest } from './analyze-worker-request-boundary.ts';
import { recordAnalyzeWorkerClientTelemetry } from
    './analyze-worker-client-telemetry.ts';
import type {
    AnalyzeWorkerClientCallbacks,
    AnalyzeWorkerClientOptions,
    AnalyzeWorkerRequestAuthority,
    AnalyzeWorkerTimerHandle,
} from './analyze-worker-client-contract.ts';

type RpcResponse = Extract<
    AnalyzeWorkerResponse,
    { type: 'search-complete' | 'window-complete' | 'selection-complete' | 'tune-complete' }
>;
type FailedResponse = Extract<AnalyzeWorkerResponse, { type: 'failed' }>;
type PendingRequest = AnalyzeWorkerRequestAuthority & Readonly<{
    watchdog: AnalyzeWorkerTimerHandle;
}>;

export type AnalyzeWorkerRpcClient = Readonly<{
    search(query: DistributedArtifactEvidenceWindowQuery, windowSize?: number): number | undefined;
    window(input: Readonly<{
        query: DistributedArtifactEvidenceWindowQuery;
        cursor: string;
        windowSize?: number;
    }>): number | undefined;
    select(evidenceId?: string): number | undefined;
    tune(input?: Readonly<{
        focusRunId?: string;
        compareLeft?: string;
        compareRight?: string;
        timingMetric?: string;
    }>): number | undefined;
    handleResponse(response: RpcResponse): void;
    finishFailure(response: FailedResponse): void;
    clear(): void;
}>;

export function createAnalyzeWorkerRpcClient(input: Readonly<{
    getAccepted(): Readonly<{
        worker: AnalyzeWorkerPort;
        modelGeneration: number;
    }> | undefined;
    isDisposed(): boolean;
    callbacks: AnalyzeWorkerClientCallbacks;
    setTimer: NonNullable<AnalyzeWorkerClientOptions['setTimeout']>;
    clearTimer: NonNullable<AnalyzeWorkerClientOptions['clearTimeout']>;
    watchdogMs: number;
    performance: AnalyzeWorkerClientOptions['performance'];
}>): AnalyzeWorkerRpcClient {
    const pendingRequests = new Map<number, PendingRequest>();
    let requestId = 0;
    let queryGeneration = 0;
    let windowGeneration = 0;
    let selectionGeneration = 0;
    let tuneGeneration = 0;

    function search(
        query: DistributedArtifactEvidenceWindowQuery,
        windowSize = ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    ): number | undefined {
        const owner = input.getAccepted();
        if (!owner) return undefined;
        const nextGeneration = queryGeneration + 1;
        const id = requestId + 1;
        const message: AnalyzeWorkerRequest = {
            type: 'search', modelGeneration: owner.modelGeneration,
            queryGeneration: nextGeneration, requestId: id, query, windowSize,
        };
        if (!isAnalyzeWorkerRequest(message)) return undefined;
        cancelPendingKind('window');
        queryGeneration = nextGeneration;
        windowGeneration = 0;
        requestId = id;
        return send('search', message);
    }

    function window(request: Readonly<{
        query: DistributedArtifactEvidenceWindowQuery;
        cursor: string;
        windowSize?: number;
    }>): number | undefined {
        const owner = input.getAccepted();
        if (!owner) return undefined;
        const nextGeneration = windowGeneration + 1;
        const id = requestId + 1;
        const message: AnalyzeWorkerRequest = {
            type: 'window', modelGeneration: owner.modelGeneration,
            queryGeneration, windowGeneration: nextGeneration, requestId: id,
            query: request.query, cursor: request.cursor,
            windowSize: request.windowSize ?? ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
        };
        if (!isAnalyzeWorkerRequest(message)) return undefined;
        windowGeneration = nextGeneration;
        requestId = id;
        return send('window', message);
    }

    function select(evidenceId?: string): number | undefined {
        const owner = input.getAccepted();
        if (!owner) return undefined;
        const nextGeneration = selectionGeneration + 1;
        const id = requestId + 1;
        const message: AnalyzeWorkerRequest = {
            type: 'select', modelGeneration: owner.modelGeneration,
            selectionGeneration: nextGeneration, requestId: id, evidenceId,
        };
        if (!isAnalyzeWorkerRequest(message)) return undefined;
        selectionGeneration = nextGeneration;
        requestId = id;
        return send('selection', message);
    }

    function tune(request: Readonly<{
        focusRunId?: string;
        compareLeft?: string;
        compareRight?: string;
        timingMetric?: string;
    }> = {}): number | undefined {
        const owner = input.getAccepted();
        if (!owner) return undefined;
        const nextGeneration = tuneGeneration + 1;
        const id = requestId + 1;
        const message: AnalyzeWorkerRequest = {
            type: 'tune', modelGeneration: owner.modelGeneration,
            tuneGeneration: nextGeneration, requestId: id, ...request,
        };
        if (!isAnalyzeWorkerRequest(message)) return undefined;
        tuneGeneration = nextGeneration;
        requestId = id;
        return send('tune', message);
    }

    function send(
        kind: PendingRequest['kind'],
        message: AnalyzeWorkerRequest,
    ): number | undefined {
        const owner = input.getAccepted();
        const id = 'requestId' in message ? message.requestId : -1;
        if (!owner || input.isDisposed() || id < 0) return undefined;
        cancelPendingKind(kind);
        const authority: AnalyzeWorkerRequestAuthority = { requestId: id, kind };
        const watchdog = input.setTimer(() => {
            if (!pendingRequests.delete(id)) return;
            input.callbacks.onUnavailable?.(
                'timeout',
                'accepted-request',
                authority,
            );
        }, input.watchdogMs);
        pendingRequests.set(id, { requestId: id, kind, watchdog });
        try {
            owner.worker.postMessage(message);
        } catch (error) {
            finishRequest(id);
            throw error;
        }
        return id;
    }

    function handleResponse(response: RpcResponse): void {
        const pending = finishRequest(response.requestId);
        if (!pending) return;
        if (response.type === 'search-complete') {
            if (pending.kind !== 'search' || response.queryGeneration !== queryGeneration) return;
            input.callbacks.onSearchComplete?.(response);
            recordAnalyzeWorkerClientTelemetry(input.performance, 'search', response);
        } else if (response.type === 'window-complete') {
            if (pending.kind !== 'window' || response.queryGeneration !== queryGeneration ||
                response.windowGeneration !== windowGeneration) return;
            input.callbacks.onWindowComplete?.(response);
            recordAnalyzeWorkerClientTelemetry(input.performance, 'window', response);
        } else if (response.type === 'selection-complete') {
            if (pending.kind !== 'selection' ||
                response.selectionGeneration !== selectionGeneration) return;
            input.callbacks.onSelectionComplete?.(response);
        } else {
            if (pending.kind !== 'tune' || response.tuneGeneration !== tuneGeneration) return;
            input.callbacks.onTuneComplete?.(response);
            recordAnalyzeWorkerClientTelemetry(input.performance, 'tune', response);
        }
    }

    function finishFailure(response: FailedResponse): void {
        const pending = finishRequest(response.requestId);
        if (!pending) return;
        input.callbacks.onFailure?.(
            response.error,
            response.operationGeneration,
            { requestId: pending.requestId, kind: pending.kind },
        );
    }

    function finishRequest(id: number | undefined): PendingRequest | undefined {
        if (id === undefined) return undefined;
        const pending = pendingRequests.get(id);
        if (!pending) return undefined;
        pendingRequests.delete(id);
        input.clearTimer(pending.watchdog);
        return pending;
    }

    function cancelPendingKind(kind: PendingRequest['kind']): void {
        for (const pending of pendingRequests.values()) {
            if (pending.kind !== kind) continue;
            input.clearTimer(pending.watchdog);
            pendingRequests.delete(pending.requestId);
        }
    }

    function clear(): void {
        for (const pending of pendingRequests.values()) {
            input.clearTimer(pending.watchdog);
        }
        pendingRequests.clear();
        queryGeneration = 0;
        windowGeneration = 0;
        selectionGeneration = 0;
        tuneGeneration = 0;
    }

    return { search, window, select, tune, handleResponse, finishFailure, clear };
}
