import { Either } from '@shared/resilience/Either.ts';

import type { DistributedRunArtifactRejection } from './distributed-artifact-analysis.ts';
import {
    computeDistributedRunArtifactPipelineAnalysis,
    resolveArtifactSchemaVersion
} from './distributed-artifact-analysis/compute-distributed-run-artifact-pipeline-analysis.ts';
import { toDistributedRunBundleContent } from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
import {
    DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT,
    DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
    type ComputeDistributedArtifactEvidenceIndexInput,
    type ComputeDistributedArtifactEvidenceInput,
    type DistributedArtifactEvidenceEntry,
    type DistributedArtifactEvidenceIndex
} from './distributed-artifact-evidence-contracts.ts';
import {
    resolveEvidenceLimit,
    resolveEvidenceTextLimit
} from './distributed-artifact-evidence/distributed-artifact-evidence-bounds.ts';
import {
    compareEvidenceEntries,
    resolvePrimaryDistributedArtifactResultFailure
} from './distributed-artifact-evidence/distributed-artifact-evidence-order.ts';
import { toDistributedArtifactEvidenceRows } from './distributed-artifact-evidence/to-distributed-artifact-evidence-rows.ts';
import { parseDistributedArtifactPipeline } from './distributed-artifact-pipeline.ts';

/** Every evidence entry of an artifact before the index limit, deduplicated and ordered, and as the rows recorded them. */
export interface DistributedArtifactEvidenceSource {
    readonly entries: readonly DistributedArtifactEvidenceEntry[];
    readonly rawEntries: readonly DistributedArtifactEvidenceEntry[];
}

/** The pipeline analysis runs once; its snapshots, artifact bundle and monitor feed the index. */
export function computeDistributedArtifactEvidence(
    input: ComputeDistributedArtifactEvidenceInput
): Either<DistributedRunArtifactRejection, DistributedArtifactEvidenceIndex> {
    const parsed = parseDistributedArtifactPipeline(input.files, { projection: 'literal-loose-files' });
    return toDistributedRunBundleContent(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (content) => {
            const pipelineAnalysis = computeDistributedRunArtifactPipelineAnalysis({
                parsed,
                content,
                generatedAtEpochMs: input.generatedAtEpochMs,
                artifactSchemaVersion: resolveArtifactSchemaVersion(parsed)
            });
            if (pipelineAnalysis.controlRunStatus === 'unavailable') {
                return Either.ofLeft(pipelineAnalysis.reason);
            }
            return Either.ofRight(computeDistributedArtifactEvidenceIndex({
                analysis: pipelineAnalysis.analysis,
                snapshots: pipelineAnalysis.snapshots,
                monitor: pipelineAnalysis.monitor,
                parsed,
                sourceFileNames: Object.keys(parsed.projectedFiles).filter(
                    (fileName) => parsed.projectedFiles[fileName] !== undefined
                ),
                limits: input.limits
            }));
        }
    );
}

export function computeDistributedArtifactEvidenceIndex(
    input: ComputeDistributedArtifactEvidenceIndexInput
): DistributedArtifactEvidenceIndex {
    return computeDistributedArtifactEvidenceIndexFromSource(input, computeDistributedArtifactEvidenceSource(input));
}

export function computeDistributedArtifactEvidenceSource(
    input: ComputeDistributedArtifactEvidenceIndexInput
): DistributedArtifactEvidenceSource {
    const rawEntries = toDistributedArtifactEvidenceRows({
        analysis: input.analysis,
        snapshots: input.snapshots,
        monitor: input.monitor,
        parsed: input.parsed,
        sourceFileNames: new Set(input.sourceFileNames),
        summaryLimit: resolveEvidenceTextLimit(
            input.limits.summary,
            DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT,
            MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT
        ),
        payloadSummaryLimit: resolveEvidenceTextLimit(
            input.limits.payloadSummary,
            DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT,
            MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT
        )
    });
    const entries = deduplicateEvidenceEntries(rawEntries).sort(compareEvidenceEntries);
    return { entries, rawEntries };
}

/**
 * The limit keeps the primary failure, the latest diagnostic and the primary result failure before any other entry;
 * a limit that is not a finite number bounds the index by its default.
 */
export function computeDistributedArtifactEvidenceIndexFromSource(
    input: ComputeDistributedArtifactEvidenceIndexInput,
    source: DistributedArtifactEvidenceSource
): DistributedArtifactEvidenceIndex {
    const limit = resolveEvidenceLimit(
        input.limits.index,
        DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
        MAX_DISTRIBUTED_ARTIFACT_INDEX_LIMIT
    );
    const primaryResultFailure = resolvePrimaryDistributedArtifactResultFailure(
        source.entries,
        input.analysis.ok ? undefined : input.analysis.failure.commandId
    );
    const bounded = computeRetainedEvidence(source.entries, limit, primaryResultFailure).sort(compareEvidenceEntries);
    return {
        analysis: input.analysis,
        monitor: input.monitor,
        entries: bounded,
        totalEntries: source.entries.length,
        omittedEntryCount: source.entries.length - bounded.length,
        limit
    };
}

function computeRetainedEvidence<Entry extends DistributedArtifactEvidenceEntry>(
    entries: readonly Entry[],
    limit: number,
    primaryResultFailure: Entry | undefined
): Entry[] {
    if (entries.length <= limit) {
        return [...entries];
    }
    if (limit === 0) {
        return [];
    }
    const retained: Entry[] = [];
    const primaryFailure = entries.find((entry) => entry.id.startsWith('failure:analysis:')) ??
        resolveLatestEntry(entries.filter((entry) => entry.kind === 'failure'));
    if (primaryFailure) {
        retained.push(primaryFailure);
    }
    const latestDiagnostic = resolveLatestEntry(entries.filter((entry) => entry.kind === 'diagnostic'));
    if (latestDiagnostic && retained.length < limit) {
        retained.push(latestDiagnostic);
    }
    if (primaryResultFailure && retained.length < limit) {
        retained.push(primaryResultFailure);
    }
    const retainedIds = new Set(retained.map((entry) => entry.id));
    retained.push(
        ...[...entries]
            .filter((entry) => !retainedIds.has(entry.id))
            .sort((left, right) =>
                computeRetentionRank(left) - computeRetentionRank(right) ||
                (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) - (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
                left.id.localeCompare(right.id)
            )
            .slice(0, Math.max(0, limit - retained.length))
    );
    return retained;
}

/** The last row recorded for an id stands for it. */
function deduplicateEvidenceEntries(
    entries: readonly DistributedArtifactEvidenceEntry[]
): DistributedArtifactEvidenceEntry[] {
    return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function resolveLatestEntry<Entry extends DistributedArtifactEvidenceEntry>(
    entries: readonly Entry[]
): Entry | undefined {
    return [...entries].sort((left, right) =>
        (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) - (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
    )[0];
}

function computeRetentionRank(entry: DistributedArtifactEvidenceEntry): number {
    if (entry.id.startsWith('failure:analysis:')) {
        return 0;
    }
    if (entry.kind === 'failure') {
        return 1;
    }
    if (entry.kind === 'diagnostic') {
        return 2;
    }
    return entry.kind === 'result' ? 3 : 4;
}
