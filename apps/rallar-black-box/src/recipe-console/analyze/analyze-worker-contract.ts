import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowQuery
} from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactIgnoredFile } from './analyze-artifact-model.ts';
import type { AnalyzeControlIdentityDigest } from './analyze-control-identity-digest.ts';
import type {
    AnalyzeArtifactProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade
} from './analyze-worker-projection-contract.ts';

export const ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE = 64;

export type AnalyzeWorkerTransferFile = Readonly<{
    name: string;
    bytes: ArrayBuffer;
}>;

export type AnalyzeWorkerLocalFilesOffer = Readonly<{
    source: 'local-files';
    label: string;
    generatedAtEpochMs: number;
    files: readonly AnalyzeWorkerTransferFile[];
    ignoredFiles: readonly AnalyzeArtifactIgnoredFile[];
}>;

export type AnalyzeWorkerControlOffer = Readonly<{
    source: 'control';
    label: string;
    controlEnvelope: ArrayBuffer;
    expectedControlIdentity: AnalyzeControlIdentityDigest;
}>;

export type AnalyzeWorkerArtifactOffer =
    | AnalyzeWorkerLocalFilesOffer
    | AnalyzeWorkerControlOffer;

export type AnalyzeWorkerRequest =
    | Readonly<{
        type: 'offer';
        operationGeneration: number;
        artifact: AnalyzeWorkerArtifactOffer;
    }>
    | Readonly<{
        type: 'start';
        operationGeneration: number;
    }>
    | Readonly<{
        type: 'search';
        modelGeneration: number;
        queryGeneration: number;
        requestId: number;
        query: DistributedArtifactEvidenceWindowQuery;
        windowSize: number;
    }>
    | Readonly<{
        type: 'window';
        modelGeneration: number;
        queryGeneration: number;
        windowGeneration: number;
        requestId: number;
        query: DistributedArtifactEvidenceWindowQuery;
        cursor: string;
        windowSize: number;
    }>
    | Readonly<{
        type: 'select';
        modelGeneration: number;
        selectionGeneration: number;
        requestId: number;
        /** Absent when the request clears the current evidence selection. */
        evidenceId?: string;
    }>
    | Readonly<{
        type: 'tune';
        modelGeneration: number;
        tuneGeneration: number;
        requestId: number;
        /** Absent when the URL names no focus run for the Tune facade. */
        focusRunId?: string;
        /** Absent when the URL names no left comparison run. */
        compareLeft?: string;
        /** Absent when the URL names no right comparison run. */
        compareRight?: string;
        /** Absent when the URL names no timing metric, so the facade keeps its own default. */
        timingMetric?: string;
    }>
    | Readonly<{
        type: 'dispose';
        reason: 'clear' | 'replacement' | 'unmount' | 'crash';
    }>;

export type AnalyzeWorkerTelemetry = Readonly<{
    durationMs: number;
    parseDurationMs: number;
    sourceFileCount: number;
    sourceBytes: number;
    pipelinePassCount: number;
    sourceCollectionPassCount: number;
    sourceFileVisitCount: number;
    documentParseCount: number;
    jsonlFilePassCount: number;
    jsonlRowParseCount: number;
    totalEntryCount: number;
    retainedEntryCount: number;
    indexOmittedEntryCount: number;
    matchedEntryCount: number;
    projectedEntryCount: number;
}>;

export type AnalyzeWorkerErrorCode =
    | 'invalid-request'
    | 'invalid-artifact'
    | 'unusable-artifact'
    | 'unsupported-artifact'
    | 'identity-mismatch'
    | 'stale-generation'
    | 'worker-unavailable'
    | 'worker-disposed';

export type AnalyzeWorkerErrorProjection = Readonly<{
    code: AnalyzeWorkerErrorCode;
    stage: 'offer' | 'parse' | 'model' | 'search' | 'window' | 'selection' | 'tune';
    recoverable: boolean;
}>;

export type AnalyzeWorkerResponse =
    | Readonly<{
        type: 'accepted';
        operationGeneration: number;
    }>
    | Readonly<{
        type: 'complete';
        operationGeneration: number;
        modelGeneration: number;
        projection: AnalyzeArtifactProjection;
        initialWindow: AnalyzeEvidenceWindowProjection;
        /** Absent when the analysis names no first actionable evidence row to open. */
        selected?: DistributedArtifactEvidenceEntry;
        exportBytes: ArrayBuffer;
        telemetry: AnalyzeWorkerTelemetry;
        controlIdentityValidated: boolean;
    }>
    | Readonly<{
        type: 'search-complete';
        modelGeneration: number;
        queryGeneration: number;
        requestId: number;
        window: AnalyzeEvidenceWindowProjection;
        telemetry: AnalyzeWorkerTelemetry;
    }>
    | Readonly<{
        type: 'window-complete';
        modelGeneration: number;
        queryGeneration: number;
        windowGeneration: number;
        requestId: number;
        window: AnalyzeEvidenceWindowProjection;
        telemetry: AnalyzeWorkerTelemetry;
    }>
    | Readonly<{
        type: 'selection-complete';
        modelGeneration: number;
        selectionGeneration: number;
        requestId: number;
        /** Absent when the request cleared the selection or its id matched no evidence row. */
        selected?: DistributedArtifactEvidenceEntry;
    }>
    | Readonly<{
        type: 'tune-complete';
        modelGeneration: number;
        tuneGeneration: number;
        requestId: number;
        facade: AnalyzeTuneArtifactFacade;
        telemetry: AnalyzeWorkerTelemetry;
    }>
    | Readonly<{
        type: 'failed';
        /**
         * Absent when the failure belongs to an RPC request, and when a message the worker
         * rejected as invalid carries no generation it could be attributed to.
         */
        operationGeneration?: number;
        /**
         * Absent when the failure belongs to an artifact offer, and when a message the worker
         * rejected as invalid carries no request id it could be attributed to.
         */
        requestId?: number;
        error: AnalyzeWorkerErrorProjection;
    }>
    | Readonly<{ type: 'disposed'; }>;

export type AnalyzeWorkerEnvelope = Readonly<{
    message: AnalyzeWorkerResponse;
    /** Absent when the response transfers no buffers, so it is posted by structured clone alone. */
    transfer?: readonly Transferable[];
}>;
