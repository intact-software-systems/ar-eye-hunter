import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceKind,
} from './distributed-artifact-evidence-contracts.ts';

export function boundedEvidenceEntry(
    entry: DistributedArtifactEvidenceEntry,
    summaryLimit: number,
    payloadSummaryLimit: number,
): DistributedArtifactEvidenceEntry {
    return {
        ...entry,
        summary: boundedEvidenceText(entry.summary, summaryLimit),
        payloadSummary: boundedEvidenceText(
            entry.payloadSummary,
            payloadSummaryLimit,
        ),
    };
}

export function compareEvidenceEntries(
    left: DistributedArtifactEvidenceEntry,
    right: DistributedArtifactEvidenceEntry,
): number {
    return (left.atEpochMs ?? Number.MIN_SAFE_INTEGER) -
            (right.atEpochMs ?? Number.MIN_SAFE_INTEGER) ||
        evidenceKindRank(left.kind) - evidenceKindRank(right.kind) ||
        left.id.localeCompare(right.id);
}

export function boundedEvidenceLimit(
    value: number | undefined,
    fallback: number,
    maximum: number,
): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(0, Math.floor(value)));
}

export function boundedEvidenceTextLimit(
    value: number | undefined,
    fallback: number,
    maximum: number,
): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(8, Math.floor(value)));
}

export function normalizedEvidenceText(value: string | undefined): string {
    return value?.trim().toLocaleLowerCase('en-US') ?? '';
}

export function stableEvidenceId(...parts: readonly unknown[]): string {
    return parts
        .filter(part => part !== undefined && part !== '')
        .map(part => encodeURIComponent(String(part)))
        .join(':');
}

export function diagnosticArtifactEventKey(event: Readonly<{
    eventId: string;
    agentId: string;
    commandId?: string;
}>): string {
    return stableEvidenceId(event.eventId, event.agentId, event.commandId);
}

export function deduplicateArtifactEvidenceEntries(
    entries: readonly DistributedArtifactEvidenceEntry[],
): DistributedArtifactEvidenceEntry[] {
    return [...new Map(entries.map(entry => [entry.id, entry])).values()];
}

export function summarizeEvidenceValue(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(sortJsonValue(value));
    } catch {
        return String(value);
    }
}

export function evidenceRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

export function evidenceStringField(
    value: Record<string, unknown>,
    key: string,
): string | undefined {
    return typeof value[key] === 'string' ? value[key] : undefined;
}

export function payloadReferencesDistributedRun(
    payload: unknown,
    distributedRunId: string,
): boolean {
    if (!distributedRunId) return false;
    try {
        return JSON.stringify(payload).includes(distributedRunId);
    } catch {
        return false;
    }
}

export function transportFromCommandKind(
    kind: string | undefined,
): string | undefined {
    if (kind?.startsWith('rtc.')) return 'rtc';
    if (kind?.startsWith('ws.')) return 'ws';
    if (kind?.startsWith('http.')) return 'http';
    return undefined;
}

function boundedEvidenceText(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function evidenceKindRank(kind: DistributedArtifactEvidenceKind): number {
    switch (kind) {
        case 'failure': return 0;
        case 'diagnostic': return 1;
        case 'result': return 2;
        case 'event': return 3;
    }
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJsonValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, sortJsonValue(nested)]),
        );
    }
    return value;
}
