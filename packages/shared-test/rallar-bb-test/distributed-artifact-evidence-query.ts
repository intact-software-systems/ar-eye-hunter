import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowQuery
} from './distributed-artifact-evidence-contracts.ts';
import { toNormalizedEvidenceText } from './distributed-artifact-evidence/to-normalized-evidence-text.ts';

export interface CompiledDistributedArtifactEvidenceQuery {
    readonly query: DistributedArtifactEvidenceWindowQuery;
    readonly tokens: readonly string[];
}

export function toCompiledDistributedArtifactEvidenceQuery(
    query: DistributedArtifactEvidenceWindowQuery
): CompiledDistributedArtifactEvidenceQuery {
    const tokens = toNormalizedEvidenceText(query.query).split(/\s+/).filter(Boolean);
    return { query, tokens };
}

export function toDistributedArtifactEvidenceQueryFingerprint(
    compiled: CompiledDistributedArtifactEvidenceQuery
): readonly ApiJsonValue[] {
    const query = compiled.query;
    return [
        [...new Set(compiled.tokens)].sort(),
        toOptionalTextFingerprint(query.agentId),
        toOptionalTextFingerprint(query.recipeId),
        toOptionalTextFingerprint(query.commandId),
        query.status === undefined
            ? ['absent']
            : ['present', toNormalizedStatus(query.status)],
        toOptionalTextFingerprint(query.severity),
        toOptionalTextFingerprint(query.transport),
        toOptionalTextFingerprint(query.category),
        toOptionalNumberFingerprint(query.fromEpochMs),
        toOptionalNumberFingerprint(query.toEpochMs)
    ];
}

export function toDistributedArtifactEvidenceSearchHaystack(
    entry: DistributedArtifactEvidenceEntry
): string {
    return toNormalizedEvidenceText(
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

/** The haystack is normalized search text that holds at least the entry's own search haystack. */
export function isDistributedArtifactEvidenceQueryMatch(
    entry: DistributedArtifactEvidenceEntry,
    compiled: CompiledDistributedArtifactEvidenceQuery,
    haystack: string
): boolean {
    const query = compiled.query;
    return compiled.tokens.every((token) => haystack.includes(token)) &&
        isRelatedMatch(entry.agentId, entry.agentIds, query.agentId) &&
        isExactMatch(entry.recipeId, query.recipeId) &&
        isExactMatch(entry.commandId, query.commandId) &&
        isStatusMatch(entry.status, query.status) &&
        isExactMatch(entry.severity, query.severity) &&
        isExactMatch(entry.transport, query.transport) &&
        isExactMatch(entry.category, query.category) &&
        (query.fromEpochMs === undefined ||
            (entry.atEpochMs !== undefined && entry.atEpochMs >= query.fromEpochMs)) &&
        (query.toEpochMs === undefined ||
            (entry.atEpochMs !== undefined && entry.atEpochMs <= query.toEpochMs));
}

function toOptionalTextFingerprint(value: string | undefined): readonly ApiJsonValue[] {
    return value === undefined
        ? ['absent']
        : ['present', toNormalizedEvidenceText(value)];
}

function toOptionalNumberFingerprint(value: number | undefined): readonly ApiJsonValue[] {
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

function isExactMatch(value: string | undefined, expected: string | undefined): boolean {
    return expected === undefined ||
        toNormalizedEvidenceText(value) === toNormalizedEvidenceText(expected);
}

function isRelatedMatch(
    value: string | undefined,
    values: readonly string[] | undefined,
    expected: string | undefined
): boolean {
    return expected === undefined || isExactMatch(value, expected) ||
        (values ?? []).some((candidate) => isExactMatch(candidate, expected));
}

function isStatusMatch(value: string | undefined, expected: string | undefined): boolean {
    return expected === undefined || toNormalizedStatus(value) === toNormalizedStatus(expected);
}

function toNormalizedStatus(value: string | undefined): string {
    const status = toNormalizedEvidenceText(value);
    if (status === 'ok' || status === 'pass' || status === 'success') {
        return 'passed';
    }
    if (status === 'failure' || status === 'error') {
        return 'failed';
    }
    return status;
}
