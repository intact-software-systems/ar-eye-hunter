import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import {
    parseDistributedArtifactPipeline,
    type ParsedDistributedArtifactPipeline
} from './distributed-artifact-pipeline.ts';
import type { DistributedArtifactEnvelopeProjection } from './distributed-artifact-workspace-contracts.ts';

export function projectDistributedArtifactEnvelope(
    files: DistributedRunArtifactFiles
): DistributedArtifactEnvelopeProjection {
    return projectDistributedArtifactEnvelopeFromParsed(
        parseDistributedArtifactPipeline(files)
    );
}

export function projectDistributedArtifactEnvelopeFromParsed(
    parsed: ParsedDistributedArtifactPipeline
): DistributedArtifactEnvelopeProjection {
    return parsed.projection;
}
