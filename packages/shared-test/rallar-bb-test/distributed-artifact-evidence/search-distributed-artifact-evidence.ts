import {
    DEFAULT_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
    MAX_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
    type DistributedArtifactEvidenceIndex,
    type DistributedArtifactEvidenceSearchQuery,
    type DistributedArtifactEvidenceSearchResult
} from '../distributed-artifact-evidence-contracts.ts';
import {
    isDistributedArtifactEvidenceQueryMatch,
    toCompiledDistributedArtifactEvidenceQuery,
    toDistributedArtifactEvidenceSearchHaystack
} from '../distributed-artifact-evidence-query.ts';
import { resolveEvidenceLimit } from './distributed-artifact-evidence-bounds.ts';

export function searchDistributedArtifactEvidence(
    index: DistributedArtifactEvidenceIndex,
    query: DistributedArtifactEvidenceSearchQuery
): DistributedArtifactEvidenceSearchResult {
    const compiled = toCompiledDistributedArtifactEvidenceQuery(query);
    const matches = index.entries.filter((entry) =>
        isDistributedArtifactEvidenceQueryMatch(entry, compiled, toDistributedArtifactEvidenceSearchHaystack(entry))
    );
    const limit = resolveEvidenceLimit(
        query.limit,
        DEFAULT_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT,
        MAX_DISTRIBUTED_ARTIFACT_SEARCH_LIMIT
    );
    const entries = matches.slice(0, limit);
    return {
        entries,
        totalMatches: matches.length,
        omittedMatchCount: matches.length - entries.length,
        upstreamOmittedEntryCount: index.omittedEntryCount,
        totalMatchesIsComplete: index.omittedEntryCount === 0,
        limit
    };
}
