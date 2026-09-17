import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceKind
} from '../distributed-artifact-evidence-contracts.ts';

/** Earlier evidence first; at the same time failures, diagnostics, results and events in that order; then by id. */
export function compareEvidenceEntries(
    left: DistributedArtifactEvidenceEntry,
    right: DistributedArtifactEvidenceEntry
): number {
    return (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) - (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        computeEvidenceKindRank(left.kind) - computeEvidenceKindRank(right.kind) ||
        left.id.localeCompare(right.id);
}

function computeEvidenceKindRank(kind: DistributedArtifactEvidenceKind): number {
    switch (kind) {
        case 'failure':
            return 0;
        case 'diagnostic':
            return 1;
        case 'result':
            return 2;
        case 'event':
            return 3;
    }
}
