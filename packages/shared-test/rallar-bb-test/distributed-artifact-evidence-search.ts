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
    normalizedEvidenceText,
} from './distributed-artifact-evidence-utils.ts';

export function searchDistributedArtifactEvidence(
    index: DistributedArtifactEvidenceIndex,
    query: DistributedArtifactEvidenceSearchQuery = {},
): DistributedArtifactEvidenceSearchResult {
    const queryTokens = normalizedEvidenceText(query.query)
        .split(/\s+/)
        .filter(Boolean);
    const matches = index.entries.filter(entry =>
        matchesText(entry, queryTokens) &&
        relatedMatch(entry.agentId, entry.agentIds, query.agentId) &&
        exactMatch(entry.recipeId, query.recipeId) &&
        exactMatch(entry.commandId, query.commandId) &&
        statusMatch(entry.status, query.status) &&
        exactMatch(entry.severity, query.severity) &&
        exactMatch(entry.transport, query.transport) &&
        exactMatch(entry.category, query.category) &&
        (query.fromEpochMs === undefined ||
            (entry.atEpochMs !== undefined &&
                entry.atEpochMs >= query.fromEpochMs)) &&
        (query.toEpochMs === undefined ||
            (entry.atEpochMs !== undefined &&
                entry.atEpochMs <= query.toEpochMs))
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

function matchesText(
    entry: DistributedArtifactEvidenceEntry,
    tokens: readonly string[],
): boolean {
    if (tokens.length === 0) return true;
    const haystack = normalizedEvidenceText([
        entry.agentId,
        ...(entry.agentIds ?? []),
        entry.recipeId,
        entry.commandId,
        entry.topic,
        entry.diagnosticType,
        entry.payloadSummary,
        entry.summary,
        entry.category,
        entry.status,
        entry.severity,
        entry.transport,
        entry.kind,
        entry.sourceFile,
    ].filter(Boolean).join(' '));
    return tokens.every(token => haystack.includes(token));
}

function exactMatch(
    value: string | undefined,
    expected: string | undefined,
): boolean {
    return expected === undefined ||
        normalizedEvidenceText(value) === normalizedEvidenceText(expected);
}

function relatedMatch(
    value: string | undefined,
    values: readonly string[] | undefined,
    expected: string | undefined,
): boolean {
    return expected === undefined || exactMatch(value, expected) ||
        (values ?? []).some(candidate => exactMatch(candidate, expected));
}

function statusMatch(
    value: string | undefined,
    expected: string | undefined,
): boolean {
    return expected === undefined ||
        normalizedStatus(value) === normalizedStatus(expected);
}

function normalizedStatus(value: string | undefined): string {
    const status = normalizedEvidenceText(value);
    if (status === 'ok' || status === 'pass' || status === 'success') {
        return 'passed';
    }
    if (status === 'failure' || status === 'error') return 'failed';
    return status;
}
