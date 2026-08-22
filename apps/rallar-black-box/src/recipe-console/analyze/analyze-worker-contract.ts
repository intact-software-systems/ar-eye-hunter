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
    AnalyzeWorkerAnalysisProjection
} from './analyze-worker-projection-contract.ts';

export const ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE = 64;

export type AnalyzeWorkerTransferFile = Readonly<{
    name: string;
    bytes: ArrayBuffer;
}>;

export type AnalyzeWorkerArtifactOffer = Readonly<{
    source: AnalyzeArtifactSource;
    label: string;
    generatedAtEpochMs?: number;
    artifactSchemaVersion?: number;
    files: readonly AnalyzeWorkerTransferFile[];
    controlEnvelope?: ArrayBuffer;
    expectedControlIdentity?: AnalyzeControlIdentityDigest;
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
        evidenceId?: string;
    }>
    | Readonly<{
        type: 'tune';
        modelGeneration: number;
        tuneGeneration: number;
        requestId: number;
        focusRunId?: string;
        compareLeft?: string;
        compareRight?: string;
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
        selected?: DistributedArtifactEvidenceEntry;
        exportBytes: ArrayBuffer;
        telemetry: AnalyzeWorkerTelemetry;
        controlIdentityValidated?: true;
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
        operationGeneration?: number;
        requestId?: number;
        error: AnalyzeWorkerErrorProjection;
    }>
    | Readonly<{ type: 'disposed'; }>;

export type AnalyzeWorkerEnvelope = Readonly<{
    message: AnalyzeWorkerResponse;
    transfer?: readonly Transferable[];
}>;
