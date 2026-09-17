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

/** The error facts of a failed result, read from its error and the error's nested details. */
export interface DistributedArtifactEvidenceFailureDetails {
    /** Absent when the recorded error carries no code. */
    readonly code?: string;
    /** Absent when the recorded error carries no error name. */
    readonly name?: string;
    /** Absent when the recorded error carries no message. */
    readonly message?: string;
    /** Absent when the recorded error carries no stack. */
    readonly stack?: string;
}

/**
 * One row of recorded evidence. A size-bounded projection of an entry may keep only its id, kind, source file,
 * summaries and failure details, so every other field can be absent there as well.
 */
export interface DistributedArtifactEvidenceEntry {
    readonly id: string;
    readonly kind: DistributedArtifactEvidenceKind;
    readonly sourceFile: string;
    /** Absent when the evidence records no time, such as a result that never ended. */
    readonly atEpochMs?: number;
    /** Absent when the evidence names no agent, such as a run-level failure. */
    readonly agentId?: string;
    /** Absent in a size-bounded projection; empty when the evidence names no agent. */
    readonly agentIds?: readonly string[];
    /** Absent when the evidence's command is linked to no recipe. */
    readonly recipeId?: string;
    /** Absent when the evidence belongs to no command. */
    readonly commandId?: string;
    /** Absent for evidence that is not an event or a diagnostic, or an event recorded without a topic. */
    readonly topic?: string;
    /** Absent for evidence that is not a diagnostic. */
    readonly diagnosticType?: string;
    /** Absent for evidence that is not a diagnostic, or a diagnostic recorded without a severity. */
    readonly severity?: string;
    /** Absent when neither the evidence nor its command kind names a transport. */
    readonly transport?: string;
    /** Absent in a size-bounded projection. */
    readonly status?: string;
    /** Absent in a size-bounded projection. */
    readonly category?: string;
    readonly summary: string;
    readonly payloadSummary: string;
    /** Absent for evidence that is not a failed result, or a failed result whose error carries no details. */
    readonly failureDetails?: DistributedArtifactEvidenceFailureDetails;
}

export interface DistributedArtifactEvidenceIndex {
    readonly analysis: DistributedRunAnalysis;
    readonly monitor: DistributedRunMonitor;
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly totalEntries: number;
    readonly omittedEntryCount: number;
    readonly limit: number;
}

/** A search over evidence; every filter is absent when the search does not narrow by it. */
export interface DistributedArtifactEvidenceSearchQuery {
    /** Absent when the search matches no free text. */
    readonly query?: string;
    /** Absent when the search does not filter by agent. */
    readonly agentId?: string;
    /** Absent when the search does not filter by recipe. */
    readonly recipeId?: string;
    /** Absent when the search does not filter by command. */
    readonly commandId?: string;
    /** Absent when the search does not filter by status. */
    readonly status?: string;
    /** Absent when the search does not filter by severity. */
    readonly severity?: string;
    /** Absent when the search does not filter by transport. */
    readonly transport?: string;
    /** Absent when the search does not filter by category. */
    readonly category?: string;
    /** Absent when the search sets no earliest time. */
    readonly fromEpochMs?: number;
    /** Absent when the search sets no latest time. */
    readonly toEpochMs?: number;
    /** Absent when the search returns the default number of matches. */
    readonly limit?: number;
}

export interface DistributedArtifactEvidenceSearchResult {
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly totalMatches: number;
    readonly omittedMatchCount: number;
    readonly upstreamOmittedEntryCount: number;
    readonly totalMatchesIsComplete: boolean;
    readonly limit: number;
}

declare const DISTRIBUTED_ARTIFACT_EVIDENCE_CURSOR: unique symbol;

export type DistributedArtifactEvidenceCursor =
    & string
    & Readonly<{
        [DISTRIBUTED_ARTIFACT_EVIDENCE_CURSOR]: true;
    }>;

/** No distributed producer compacts evidence today, so the catalog states that no compaction applies. */
export interface DistributedArtifactEvidenceProducerCompaction {
    readonly status: 'unavailable';
    readonly reason: 'no-distributed-producer-compaction-contract';
}

export interface DistributedArtifactEvidenceCatalog {
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly totalEntries: number;
    readonly retainedEntryCount: number;
    readonly indexOmittedEntryCount: number;
    readonly limit: number;
    /** Absent when the artifact records no failure. */
    readonly primaryFailureId?: string;
    /** Absent when the artifact records no diagnostic. */
    readonly latestDiagnosticId?: string;
    readonly producerCompaction: DistributedArtifactEvidenceProducerCompaction;
}

export interface DistributedArtifactEvidenceCollections {
    readonly index: DistributedArtifactEvidenceIndex;
    readonly catalog: DistributedArtifactEvidenceCatalog;
}

export type DistributedArtifactEvidenceWindowQuery = Omit<DistributedArtifactEvidenceSearchQuery, 'limit'>;

export interface DistributedArtifactEvidenceWindowRequest {
    /** Absent when the window matches every catalog entry. */
    readonly query?: DistributedArtifactEvidenceWindowQuery;
    /** Absent for the first window of a query. */
    readonly cursor?: string;
    /** Absent when the window takes the cursor's size, or the default size without a cursor. */
    readonly windowSize?: number;
}

export interface DistributedArtifactEvidenceWindowCounts {
    readonly totalEntries: number;
    readonly indexedEntries: number;
    readonly indexOmittedEntries: number;
    readonly retainedMatches: number;
    readonly queryExcludedEntries: number;
    readonly renderedMatches: number;
    readonly renderOmittedMatches: number;
}

export interface DistributedArtifactEvidenceWindow {
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly rangeStart: number;
    readonly rangeEnd: number;
    /** Absent for the first window of the matches. */
    readonly previousCursor?: DistributedArtifactEvidenceCursor;
    /** Absent for the last window of the matches. */
    readonly nextCursor?: DistributedArtifactEvidenceCursor;
    readonly counts: DistributedArtifactEvidenceWindowCounts;
    readonly totalMatchesIsComplete: boolean;
    readonly windowSize: number;
}

export type DistributedArtifactEvidenceCursorRejectionCode =
    | 'cursor-malformed'
    | 'cursor-tampered'
    | 'cursor-foreign-artifact'
    | 'cursor-stale-model'
    | 'cursor-query-mismatch'
    | 'cursor-out-of-range';

export interface DistributedArtifactEvidenceCursorRejection {
    readonly code: DistributedArtifactEvidenceCursorRejectionCode;
    readonly message: string;
}

export interface DistributedArtifactEvidenceWindowAccepted {
    readonly ok: true;
    readonly window: DistributedArtifactEvidenceWindow;
}

export interface DistributedArtifactEvidenceWindowRejected {
    readonly ok: false;
    readonly rejection: DistributedArtifactEvidenceCursorRejection;
}

export type DistributedArtifactEvidenceWindowResult =
    | DistributedArtifactEvidenceWindowAccepted
    | DistributedArtifactEvidenceWindowRejected;

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
