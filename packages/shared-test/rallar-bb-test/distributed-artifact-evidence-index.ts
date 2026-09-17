import { Either } from '@shared/resilience/Either.ts';

import type { DistributedRunArtifactRejection } from './distributed-artifact-analysis.ts';
import {
    computeDistributedRunArtifactPipelineAnalysis,
    resolveArtifactSchemaVersion
} from './distributed-artifact-analysis/compute-distributed-run-artifact-pipeline-analysis.ts';
import { toDistributedRunBundleContent } from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
import type {
    ComputeDistributedArtifactEvidenceIndexInput,
    ComputeDistributedArtifactEvidenceInput,
    DistributedArtifactEvidenceIndex
} from './distributed-artifact-evidence-contracts.ts';
import {
    computeDistributedArtifactEvidenceIndexFromSource,
    computeDistributedArtifactEvidenceSource
} from './distributed-artifact-evidence/compute-distributed-artifact-evidence-source.ts';
import { parseDistributedArtifactPipeline } from './distributed-artifact-pipeline.ts';

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
