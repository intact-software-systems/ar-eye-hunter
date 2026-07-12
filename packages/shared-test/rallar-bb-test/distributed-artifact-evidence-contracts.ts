import type {
    DistributedRunAnalysis,
    DistributedRunArtifactFiles,
    DistributedRunArtifactSnapshots,
} from './distributed-artifact-analysis.ts';
import type { DistributedRunMonitor } from './distributed-run-monitor.ts';

export type DistributedArtifactEvidenceKind =
    | 'failure'
    | 'result'
    | 'event'
    | 'diagnostic';

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

export type DeriveDistributedArtifactEvidenceInput = Readonly<{
    files: DistributedRunArtifactFiles;
    generatedAtEpochMs?: number;
    indexLimit?: number;
    summaryLimit?: number;
    payloadSummaryLimit?: number;
}>;

export type DeriveDistributedArtifactEvidenceIndexInput = Readonly<{
    analysis: DistributedRunAnalysis;
    snapshots: DistributedRunArtifactSnapshots;
    sourceFileNames?: readonly string[];
    sourceFiles?: DistributedRunArtifactFiles;
    indexLimit?: number;
    summaryLimit?: number;
    payloadSummaryLimit?: number;
}>;

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
