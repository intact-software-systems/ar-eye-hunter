import { Either } from '@shared/resilience/Either.ts';

import type { ControlDistributedRunArtifactBundle } from '../control-snapshots.ts';
import type { DistributedRunArtifactRejection } from '../distributed-artifact-analysis.ts';
import type { ParsedDistributedArtifactPipeline } from '../distributed-artifact-pipeline.ts';

export interface PipelineArtifactBundleInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly distributedRunId: string;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
}

const DISTRIBUTED_ARTIFACT_FILE_NAMES: ReadonlySet<string> = new Set([
    'distributed-run.json',
    'manifest.json',
    'target-resolution.json',
    'runner-summary.json',
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
    'control-post-error-metadata.json',
    'control-run.json',
    'fleet-report.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json'
]);

const BUNDLE_CORE_FILE_NAMES = ['distributed-run.json', 'control-run.json', 'manifest.json'] as const;

const DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES = ['report.json', 'failures.json', 'metadata.json'] as const;

/** A bundle needs the run snapshot, the control run and the manifest; other known artifact files ride along. */
export function toPipelineArtifactBundle(
    input: PipelineArtifactBundleInput
): Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle> {
    const files = input.parsed.projectedFiles;
    const missingFileName = BUNDLE_CORE_FILE_NAMES.find((fileName) => files[fileName] === undefined);
    if (missingFileName !== undefined) {
        return Either.ofLeft({
            fileName: missingFileName,
            message: `${missingFileName} is required to form a distributed-run artifact bundle.`
        });
    }
    const bundleFiles: Record<string, string> = {};
    for (const [fileName, text] of Object.entries(files)) {
        if (text !== undefined && DISTRIBUTED_ARTIFACT_FILE_NAMES.has(fileName)) {
            bundleFiles[fileName] = text;
        }
    }
    return Either.ofRight({
        artifactSchemaVersion: input.artifactSchemaVersion,
        distributedRunId: input.distributedRunId,
        generatedAtEpochMs: input.generatedAtEpochMs,
        files: bundleFiles as ControlDistributedRunArtifactBundle['files']
    });
}

/** Artifacts carrying the report, failures and metadata files are schema v2; the rest are v1. */
export function resolveArtifactSchemaVersion(parsed: ParsedDistributedArtifactPipeline): number {
    return DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES.every((fileName) =>
            parsed.projectedFiles[fileName] !== undefined
        )
        ? 2
        : 1;
}
