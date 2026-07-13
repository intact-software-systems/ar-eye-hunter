import {
    deriveDistributedRunArtifactPipelineAnalysis,
    distributedArtifactSnapshotsFromPipeline,
    parseDistributedRunArtifactPipeline,
} from './distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineJsonRecord,
    parseDistributedArtifactPipeline,
} from './distributed-artifact-pipeline.ts';
import {
    DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT,
    DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
    type DeriveDistributedArtifactEvidenceIndexInput,
    type DeriveDistributedArtifactEvidenceInput,
    type DistributedArtifactEvidenceIndex,
} from './distributed-artifact-evidence-contracts.ts';
import { distributedArtifactEvidenceRows } from './distributed-artifact-evidence-rows.ts';
import {
    boundedEvidenceLimit,
    boundedEvidenceTextLimit,
    compareEvidenceEntries,
} from './distributed-artifact-evidence-utils.ts';
import { deriveDistributedRunMonitor } from './distributed-run-monitor.ts';

export function deriveDistributedArtifactEvidence(
    input: DeriveDistributedArtifactEvidenceInput,
): DistributedArtifactEvidenceIndex {
    const generatedAtEpochMs = input.generatedAtEpochMs ?? Date.now();
    const parsed = parseDistributedArtifactPipeline(input.files, {
        projection: 'literal-loose-files',
    });
    const parsedFiles = parseDistributedRunArtifactPipeline(parsed);
    const snapshots = distributedArtifactSnapshotsFromPipeline(
        parsed,
        generatedAtEpochMs,
        undefined,
        parsedFiles,
    );
    const analysisResult = deriveDistributedRunArtifactPipelineAnalysis({
        parsed,
        parsedFiles,
        snapshots,
        generatedAtEpochMs,
    });
    return deriveDistributedArtifactEvidenceIndex({
        analysis: analysisResult.analysis,
        snapshots,
        monitor: analysisResult.monitor,
        parsedControlRun: distributedArtifactPipelineJsonRecord(
            parsed,
            'control-run.json',
        ),
        sourceFileNames: Object.keys(parsed.projectedFiles).filter(
            fileName => parsed.projectedFiles[fileName] !== undefined,
        ),
        sourceFiles: parsed.projectedFiles,
        indexLimit: input.indexLimit,
        summaryLimit: input.summaryLimit,
        payloadSummaryLimit: input.payloadSummaryLimit,
    });
}

export function deriveDistributedArtifactEvidenceIndex(
    input: DeriveDistributedArtifactEvidenceIndexInput,
): DistributedArtifactEvidenceIndex {
    const monitor = input.monitor ?? deriveDistributedRunMonitor({
        distributedRun: input.snapshots.distributedRun,
        controlRun: input.snapshots.controlRun,
        artifactBundle: input.snapshots.artifactBundle,
    });
    const entries = distributedArtifactEvidenceRows({
        analysis: input.analysis,
        snapshots: input.snapshots,
        monitor,
        sourceFileNames: new Set(input.sourceFileNames ?? []),
        sourceFiles: input.sourceFiles,
        parsedControlRun: input.parsedControlRun,
        summaryLimit: boundedEvidenceTextLimit(
            input.summaryLimit,
            DEFAULT_DISTRIBUTED_ARTIFACT_SUMMARY_LIMIT,
            MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
        ),
        payloadSummaryLimit: boundedEvidenceTextLimit(
            input.payloadSummaryLimit,
            DEFAULT_DISTRIBUTED_ARTIFACT_PAYLOAD_SUMMARY_LIMIT,
            MAX_DISTRIBUTED_ARTIFACT_TEXT_LIMIT,
        ),
    }).sort(compareEvidenceEntries);
    const limit = boundedEvidenceLimit(
        input.indexLimit,
        DEFAULT_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
        MAX_DISTRIBUTED_ARTIFACT_INDEX_LIMIT,
    );
    const bounded = retainActionableEvidence(entries, limit)
        .sort(compareEvidenceEntries);
    return {
        analysis: input.analysis,
        monitor,
        entries: bounded,
        totalEntries: entries.length,
        omittedEntryCount: entries.length - bounded.length,
        limit,
    };
}

function retainActionableEvidence<
    Entry extends DistributedArtifactEvidenceIndex['entries'][number],
>(entries: readonly Entry[], limit: number): Entry[] {
    if (entries.length <= limit) return [...entries];
    if (limit === 0) return [];
    const retained: Entry[] = [];
    const primaryFailure = entries.find(entry =>
        entry.id.startsWith('failure:analysis:')
    ) ?? latest(entries.filter(entry => entry.kind === 'failure'));
    if (primaryFailure) retained.push(primaryFailure);
    const latestDiagnostic = latest(
        entries.filter(entry => entry.kind === 'diagnostic'),
    );
    if (latestDiagnostic && retained.length < limit) {
        retained.push(latestDiagnostic);
    }
    const retainedIds = new Set(retained.map(entry => entry.id));
    retained.push(...[...entries]
        .filter(entry => !retainedIds.has(entry.id))
        .sort((left, right) =>
            retentionRank(left) - retentionRank(right) ||
            (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) -
                (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
            left.id.localeCompare(right.id)
        )
        .slice(0, Math.max(0, limit - retained.length)));
    return retained;
}

function latest<Entry extends DistributedArtifactEvidenceIndex['entries'][number]>(
    entries: readonly Entry[],
): Entry | undefined {
    return [...entries].sort((left, right) =>
        (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) -
            (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
    )[0];
}

function retentionRank(
    entry: DistributedArtifactEvidenceIndex['entries'][number],
): number {
    if (entry.id.startsWith('failure:analysis:')) return 0;
    if (entry.kind === 'failure') return 1;
    if (entry.kind === 'diagnostic') return 2;
    if (entry.kind === 'result') return 3;
    return 4;
}
