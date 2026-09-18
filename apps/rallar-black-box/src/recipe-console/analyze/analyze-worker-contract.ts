import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowQuery
} from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactIgnoredFile, AnalyzeArtifactSource } from './analyze-artifact-model.ts';
import type { AnalyzeControlIdentityDigest } from './analyze-control-identity-digest.ts';
import type {
    AnalyzeArtifactProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade
} from './analyze-worker-projection-contract.ts';

export type {
    AnalyzeArtifactProjection,
    AnalyzeArtifactWorkspaceProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerAnalysisProjection,
    AnalyzeWorkerAnalysisProjectionSections,
    AnalyzeWorkerFailedAnalysisProjection,
    AnalyzeWorkerPassedAnalysisProjection
} from './analyze-worker-projection-contract.ts';

export const ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE = 64;

export type AnalyzeWorkerTransferFile = Readonly<{
    name: string;
    bytes: ArrayBuffer;
}>;

export type AnalyzeWorkerArtifactOffer = Readonly<{
    source: AnalyzeArtifactSource;
    label: string;
    /** Absent when the offered artifact records no generation time of its own. */
    generatedAtEpochMs?: number;
    /** Absent when the offered artifact declares no schema version. */
    artifactSchemaVersion?: number;
    files: readonly AnalyzeWorkerTransferFile[];
    /** Absent unless the offer carries a raw Control response envelope instead of loose files. */
    controlEnvelope?: ArrayBuffer;
    /** Absent unless a Control identity digest must match before the analysis is accepted. */
    expectedControlIdentity?: AnalyzeControlIdentityDigest;
    /** Absent when the offer's producer records no ignored-file list. */
    ignoredFiles?: readonly AnalyzeArtifactIgnoredFile[];
}>;

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
        /** Absent when the failure belongs to an RPC request rather than to an artifact offer. */
        operationGeneration?: number;
        /** Absent when the failure belongs to an artifact offer rather than to an RPC request. */
        requestId?: number;
        error: AnalyzeWorkerErrorProjection;
    }>
    | Readonly<{ type: 'disposed'; }>;

export type AnalyzeWorkerEnvelope = Readonly<{
    message: AnalyzeWorkerResponse;
    /** Absent when the response transfers no buffers, so it is posted by structured clone alone. */
    transfer?: readonly Transferable[];
}>;
