import {
    DEFAULT_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
    type DistributedArtifactEvidenceEntry,
    type DistributedArtifactEvidenceIndex,
    type DistributedArtifactEvidenceSearchQuery,
    type DistributedArtifactEvidenceSearchResult,
} from './distributed-artifact-evidence-contracts.ts';
import {
    boundedEvidenceLimit,
} from './distributed-artifact-evidence-utils.ts';
import {
    compileDistributedArtifactEvidenceQuery,
    distributedArtifactEvidenceEntryMatches,
} from './distributed-artifact-evidence-query.ts';

export function searchDistributedArtifactEvidence(
    index: DistributedArtifactEvidenceIndex,
    query: DistributedArtifactEvidenceSearchQuery = {},
): DistributedArtifactEvidenceSearchResult {
    const compiled = compileDistributedArtifactEvidenceQuery(query);
    const matches = index.entries.filter(entry =>
        distributedArtifactEvidenceEntryMatches(entry, compiled)
    );
    const limit = boundedEvidenceLimit(
        query.limit,
        DEFAULT_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
        MAX_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
    );
    const entries = matches.slice(0, limit);
    return {
        entries,
        totalMatches: matches.length,
        omittedMatchCount: matches.length - entries.length,
        upstreamOmittedEntryCount: index.omittedEntryCount,
        totalMatchesIsComplete: index.omittedEntryCount === 0,
        limit,
    };
}
