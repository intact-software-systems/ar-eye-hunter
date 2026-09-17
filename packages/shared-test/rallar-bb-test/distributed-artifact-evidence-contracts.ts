import type {
    DistributedRunAnalysis,
    DistributedRunArtifactFiles,
    DistributedRunArtifactSnapshots
} from './distributed-artifact-analysis.ts';
import type { ParsedDistributedArtifactPipeline } from './distributed-artifact-pipeline.ts';
import type { DistributedRunMonitor } from './distributed-run-monitor.ts';

export type DistributedArtifactEvidenceKind =
    | 'failure'
    | 'result'
    | 'event'
    | 'diagnostic';

export type DistributedArtifactEvidenceFailureDetails = Readonly<{
    code?: string;
    name?: string;
    message?: string;
    stack?: string;
}>;

export type DistributedArtifactEvidenceEntry = Readonly<{
    id: string;
    kind: DistributedArtifactEvidenceKind;
    sourceFile: string;
    atEpochMs?: number;
    agentId?: string;
    agentIds?: readonly string[];
    recipeId?: string;
    commandId?: string;
    topic?: string;
    diagnosticType?: string;
    severity?: string;
    transport?: string;
    status?: string;
    category?: string;
    summary: string;
    payloadSummary: string;
    failureDetails?: DistributedArtifactEvidenceFailureDetails;
}>;

export type DistributedArtifactEvidenceIndex = Readonly<{
    analysis: DistributedRunAnalysis;
    monitor: DistributedRunMonitor;
    entries: readonly DistributedArtifactEvidenceEntry[];
    totalEntries: number;
    omittedEntryCount: number;
    limit: number;
}>;

export type DistributedArtifactEvidenceSearchQuery = Readonly<{
    query?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    status?: string;
    severity?: string;
    transport?: string;
    category?: string;
    fromEpochMs?: number;
    toEpochMs?: number;
    limit?: number;
}>;

export type DistributedArtifactEvidenceSearchResult = Readonly<{
    entries: readonly DistributedArtifactEvidenceEntry[];
    totalMatches: number;
    omittedMatchCount: number;
    upstreamOmittedEntryCount: number;
    totalMatchesIsComplete: boolean;
    limit: number;
}>;

declare const DISTRIBUTED_ARTIFACT_EVIDENCE_CURSOR: unique symbol;

export type DistributedArtifactEvidenceCursor =
    & string
    & Readonly<{
        [DISTRIBUTED_ARTIFACT_EVIDENCE_CURSOR]: true;
    }>;

export type DistributedArtifactEvidenceCatalog = Readonly<{
    entries: readonly DistributedArtifactEvidenceEntry[];
    totalEntries: number;
    retainedEntryCount: number;
    indexOmittedEntryCount: number;
    limit: number;
    primaryFailureId?: string;
    latestDiagnosticId?: string;
    producerCompaction: Readonly<{
        status: 'unavailable';
        reason: 'no-distributed-producer-compaction-contract';
    }>;
}>;

export type DistributedArtifactEvidenceCollections = Readonly<{
    index: DistributedArtifactEvidenceIndex;
    catalog: DistributedArtifactEvidenceCatalog;
}>;

export type DistributedArtifactEvidenceWindowQuery = Omit<DistributedArtifactEvidenceSearchQuery, 'limit'>;

export type DistributedArtifactEvidenceWindowRequest = Readonly<{
    query?: DistributedArtifactEvidenceWindowQuery;
    cursor?: string;
    windowSize?: number;
}>;

export type DistributedArtifactEvidenceWindowCounts = Readonly<{
    totalEntries: number;
    indexedEntries: number;
    indexOmittedEntries: number;
    retainedMatches: number;
    queryExcludedEntries: number;
    renderedMatches: number;
    renderOmittedMatches: number;
}>;

export type DistributedArtifactEvidenceWindow = Readonly<{
    entries: readonly DistributedArtifactEvidenceEntry[];
    rangeStart: number;
    rangeEnd: number;
    previousCursor?: DistributedArtifactEvidenceCursor;
    nextCursor?: DistributedArtifactEvidenceCursor;
    counts: DistributedArtifactEvidenceWindowCounts;
    totalMatchesIsComplete: boolean;
    windowSize: number;
}>;

export type DistributedArtifactEvidenceCursorRejectionCode =
    | 'cursor-malformed'
    | 'cursor-tampered'
    | 'cursor-foreign-artifact'
    | 'cursor-stale-model'
    | 'cursor-query-mismatch'
    | 'cursor-out-of-range';

export type DistributedArtifactEvidenceWindowResult =
    | Readonly<{ ok: true; window: DistributedArtifactEvidenceWindow; }>
    | Readonly<{
        ok: false;
        rejection: Readonly<{
            code: DistributedArtifactEvidenceCursorRejectionCode;
            message: string;
        }>;
    }>;

/** Bounds of an evidence index: entries kept, and characters of each summary and payload summary; each is clamped to its maximum. */
export interface DistributedArtifactEvidenceLimits {
    readonly index: number;
    readonly summary: number;
    readonly payloadSummary: number;
}

export interface ComputeDistributedArtifactEvidenceInput {
    readonly files: DistributedRunArtifactFiles;
    readonly generatedAtEpochMs: number;
    readonly limits: DistributedArtifactEvidenceLimits;
}

export interface ComputeDistributedArtifactEvidenceIndexInput {
    readonly analysis: DistributedRunAnalysis;
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly monitor: DistributedRunMonitor;
    /** The parsed artifact files the analysis, snapshots and monitor were computed from. */
    readonly parsed: ParsedDistributedArtifactPipeline;
    /** The artifact files an entry may name as its source. */
    readonly sourceFileNames: readonly string[];
    readonly limits: DistributedArtifactEvidenceLimits;
}

export type ComposeDistributedArtifactIssueMarkdownInput = Readonly<{
    analysis: DistributedRunAnalysis;
    index?: DistributedArtifactEvidenceIndex;
    searchResult?: DistributedArtifactEvidenceSearchResult;
    maxCausalTrailItems?: number;
    maxSourceEvidenceItems?: number;
}>;

export const DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT = 500;
export const MAX_DISTRIBUTED_ARTIFACT_INDEX_LIMIT = 2_000;
export const DEFAULT_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT = 100;
export const MAX_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT = 500;
export const DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT = 240;
export const DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT = 600;
export const MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT = 2_000;
export const MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_CATALOG_ENTRIES = 20_000;
export const DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE = 64;
export const MAX_DISTRIBUTED_ARTIFACT_EVIDENCE_WINDOW_SIZE = 100;

export const DEFAULT_DISTRIBUTED_ARTIFACT_EVIDENCE_LIMITS: DistributedArtifactEvidenceLimits = {
    index: DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    summary: DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT,
    payloadSummary: DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT
};
