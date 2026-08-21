import type { DistributedArtifactEvidenceWindowQuery } from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeRetainedExport } from './analyze-export-blob.ts';
import type {
    AnalyzeWorkerArtifactOffer,
    AnalyzeWorkerErrorProjection,
    AnalyzeWorkerResponse
} from './analyze-worker-contract.ts';
import type { AnalyzeWorkerFactory } from './analyze-worker-factory.ts';
import type { AnalyzeWorkerPerformancePort } from './analyze-worker-performance.ts';

export type AnalyzeCompleteResponse = Extract<AnalyzeWorkerResponse, { type: 'complete'; }>;
export type AnalyzeSearchResponse = Extract<AnalyzeWorkerResponse, { type: 'search-complete'; }>;
export type AnalyzeWindowResponse = Extract<AnalyzeWorkerResponse, { type: 'window-complete'; }>;
export type AnalyzeSelectionResponse = Extract<AnalyzeWorkerResponse, { type: 'selection-complete'; }>;
export type AnalyzeTuneResponse = Extract<AnalyzeWorkerResponse, { type: 'tune-complete'; }>;

export type AnalyzeWorkerTimerHandle = number | ReturnType<typeof setTimeout>;

export type AnalyzeWorkerRequestAuthority = Readonly<{
    requestId: number;
    kind: 'search' | 'window' | 'selection' | 'tune';
}>;

export type AnalyzeWorkerClientCallbacks = Readonly<{
    onAccepted?(operationGeneration: number): void;
    onPendingPaint?(operationGeneration: number): void;
    onComplete?(response: AnalyzeCompleteResponse): void;
    onSearchComplete?(response: AnalyzeSearchResponse): void;
    onWindowComplete?(response: AnalyzeWindowResponse): void;
    onSelectionComplete?(response: AnalyzeSelectionResponse): void;
    onTuneComplete?(response: AnalyzeTuneResponse): void;
    onFailure?(
        error: AnalyzeWorkerErrorProjection,
        operationGeneration?: number,
        request?: AnalyzeWorkerRequestAuthority
    ): void;
    onUnavailable?(
        reason: 'error' | 'messageerror' | 'timeout',
        scope: 'candidate' | 'accepted-request' | 'accepted-worker',
        request?: AnalyzeWorkerRequestAuthority
    ): void;
}>;

export type AnalyzeWorkerClient = Readonly<{
    offer(artifact: AnalyzeWorkerArtifactOffer, operationGeneration?: number): number;
    search(query: DistributedArtifactEvidenceWindowQuery, windowSize?: number): number | undefined;
    window(
        input: Readonly<{
            query: DistributedArtifactEvidenceWindowQuery;
            cursor: string;
            windowSize?: number;
        }>
    ): number | undefined;
    select(evidenceId?: string): number | undefined;
    tune(
        input?: Readonly<{
            focusRunId?: string;
            compareLeft?: string;
            compareRight?: string;
            timingMetric?: string;
        }>
    ): number | undefined;
    currentExport(): AnalyzeRetainedExport | undefined;
    cancelCandidate(reason?: 'replacement' | 'crash'): void;
    clear(): void;
    dispose(): void;
}>;

export type AnalyzeWorkerClientOptions = Readonly<{
    createWorker: AnalyzeWorkerFactory;
    callbacks?: AnalyzeWorkerClientCallbacks;
    requestAnimationFrame?(callback: FrameRequestCallback): number;
    setTimeout?(callback: () => void, delayMs: number): AnalyzeWorkerTimerHandle;
    clearTimeout?(handle: AnalyzeWorkerTimerHandle): void;
    performance?: AnalyzeWorkerPerformancePort;
    watchdogMs?: number;
    validateComplete?(response: AnalyzeCompleteResponse): boolean;
}>;
