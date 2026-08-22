import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowQuery
} from './distributed-artifact-evidence-contracts.ts';
import { normalizedEvidenceText } from './distributed-artifact-evidence-utils.ts';

export type CompiledDistributedArtifactEvidenceQuery = Readonly<{
    query: DistributedArtifactEvidenceWindowQuery;
    tokens: readonly string[];
}>;

export function compileDistributedArtifactEvidenceQuery(
    query: DistributedArtifactEvidenceWindowQuery = {}
): CompiledDistributedArtifactEvidenceQuery {
    const tokens = normalizedEvidenceText(query.query).split(/\s+/).filter(Boolean);
    return { query, tokens };
}

export function distributedArtifactEvidenceQueryFingerprintValue(
    compiled: CompiledDistributedArtifactEvidenceQuery
): readonly unknown[] {
    const query = compiled.query;
    return [
        [...new Set(compiled.tokens)].sort(),
        optionalTextFingerprint(query.agentId),
        optionalTextFingerprint(query.recipeId),
        optionalTextFingerprint(query.commandId),
        query.status === undefined
            ? ['absent']
            : ['present', normalizedStatus(query.status)],
        optionalTextFingerprint(query.severity),
        optionalTextFingerprint(query.transport),
        optionalTextFingerprint(query.category),
        optionalNumberFingerprint(query.fromEpochMs),
        optionalNumberFingerprint(query.toEpochMs)
    ];
}

function optionalTextFingerprint(value: string | undefined): readonly unknown[] {
    return value === undefined
        ? ['absent']
        : ['present', normalizedEvidenceText(value)];
}

function optionalNumberFingerprint(value: number | undefined): readonly unknown[] {
    if (value === undefined) {
        return ['absent'];
    }
    if (Number.isNaN(value)) {
        return ['present', 'nan'];
    }
    if (value === Number.POSITIVE_INFINITY) {
        return ['present', 'positive-infinity'];
    }
    if (value === Number.NEGATIVE_INFINITY) {
        return ['present', 'negative-infinity'];
    }
    return ['present', 'finite', value];
}

export function distributedArtifactEvidenceSearchHaystack(
    entry: DistributedArtifactEvidenceEntry
): string {
    return normalizedEvidenceText(
        [
            entry.agentId,
            ...(entry.agentIds ?? []),
            entry.recipeId,
            entry.commandId,
            entry.topic,
            entry.diagnosticType,
            entry.failureDetails?.code,
            entry.failureDetails?.name,
            entry.failureDetails?.message,
            entry.failureDetails?.stack,
            entry.payloadSummary,
            entry.summary,
            entry.category,
            entry.status,
            entry.severity,
            entry.transport,
            entry.kind,
            entry.sourceFile
        ].filter(Boolean).join(' ')
    );
}

export function distributedArtifactEvidenceEntryMatches(
    entry: DistributedArtifactEvidenceEntry,
    compiled: CompiledDistributedArtifactEvidenceQuery,
    haystack = distributedArtifactEvidenceSearchHaystack(entry)
): boolean {
    const query = compiled.query;
    return compiled.tokens.every((token) => haystack.includes(token)) &&
        relatedMatch(entry.agentId, entry.agentIds, query.agentId) &&
        exactMatch(entry.recipeId, query.recipeId) &&
        exactMatch(entry.commandId, query.commandId) &&
        statusMatch(entry.status, query.status) &&
        exactMatch(entry.severity, query.severity) &&
        exactMatch(entry.transport, query.transport) &&
        exactMatch(entry.category, query.category) &&
        (query.fromEpochMs === undefined ||
            (entry.atEpochMs !== undefined && entry.atEpochMs >= query.fromEpochMs)) &&
        (query.toEpochMs === undefined ||
            (entry.atEpochMs !== undefined && entry.atEpochMs <= query.toEpochMs));
}

function exactMatch(value: string | undefined, expected: string | undefined): boolean {
    return expected === undefined ||
        normalizedEvidenceText(value) === normalizedEvidenceText(expected);
}

function relatedMatch(
    value: string | undefined,
    values: readonly string[] | undefined,
    expected: string | undefined
): boolean {
    return expected === undefined || exactMatch(value, expected) ||
        (values ?? []).some((candidate) => exactMatch(candidate, expected));
}

function statusMatch(value: string | undefined, expected: string | undefined): boolean {
    return expected === undefined || normalizedStatus(value) === normalizedStatus(expected);
}

function normalizedStatus(value: string | undefined): string {
    const status = normalizedEvidenceText(value);
    if (status === 'ok' || status === 'pass' || status === 'success') {
        return 'passed';
    }
    if (status === 'failure' || status === 'error') {
        return 'failed';
    }
    return status;
}
