import type { RallarBlackBoxSharedTestParsedArtifactBundle } from '../../../shared-test-handoff-fixtures.ts';
export const SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE = 24;
type SharedTestArtifactIndex = NonNullable<
    RallarBlackBoxSharedTestParsedArtifactBundle[
        'views'
    ]['artifactIndex']
>;
export type SharedTestCompactionSummary = Readonly<{
    sourceOrdinal: number;
    name: string;
    transport: string;
    action: string;
    connection?: string;
    count: number;
    firstSequence: number;
    lastSequence: number;
}>;
export type SharedTestArtifactIndexPresentation = Readonly<{
    status: 'coherent' | 'inconsistent';
    truncation: Readonly<{
        totalEvents?: number;
        emittedEvents?: number;
        omittedEvents?: number;
        truncated?: boolean;
    }>;
    compaction: Readonly<{
        status:
            | 'metadata-unavailable'
            | 'flag-invalid'
            | 'incoherent'
            | 'not-compacted'
            | 'summaries-unavailable'
            | 'summaries-invalid'
            | 'index-inconsistent'
            | 'compacted';
        summariesAvailable: boolean;
        summaryCount?: number;
        summaries: readonly SharedTestCompactionSummary[];
    }>;
}>;
export type SharedTestCompactionSummaryWindow = Readonly<{
    total: number;
    startIndex: number;
    endIndexExclusive: number;
    displayStart: number;
    displayEnd: number;
    canPrevious: boolean;
    canNext: boolean;
    rows: readonly SharedTestCompactionSummary[];
}>;
export function deriveSharedTestArtifactIndexPresentation(
    artifactIndex: SharedTestArtifactIndex
): SharedTestArtifactIndexPresentation {
    const source = artifactIndex.truncation;
    const totalEvents = integerValue(source.totalEvents, 0);
    const emittedEvents = integerValue(source.emittedEvents, 0);
    const omittedEvents = integerValue(source.omittedEvents, 0);
    const truncated = source.truncated;
    const compacted = recordValue(artifactIndex.compaction)?.compacted;
    const hasOmissions = omittedEvents !== undefined && omittedEvents > 0;
    if (
        totalEvents === undefined || emittedEvents === undefined ||
        omittedEvents === undefined || typeof truncated !== 'boolean' ||
        totalEvents !== emittedEvents + omittedEvents ||
        truncated !== hasOmissions ||
        (typeof compacted === 'boolean' && compacted !== hasOmissions)
    ) {
        return inconsistentPresentation();
    }
    const compaction = compactionPresentation(
        artifactIndex.compaction,
        totalEvents,
        omittedEvents
    );
    if (compaction.status === 'index-inconsistent') {
        return inconsistentPresentation();
    }
    return {
        status: 'coherent',
        truncation: { totalEvents, emittedEvents, omittedEvents, truncated },
        compaction
    };
}
function compactionPresentation(
    value: unknown,
    totalEvents: number,
    omittedEvents: number
): SharedTestArtifactIndexPresentation['compaction'] {
    const compaction = recordValue(value);
    if (!compaction) {
        return unavailableCompaction('metadata-unavailable');
    }
    const flag = compaction.compacted;
    const rawSummaries = compaction.repeatedSuccessSummaries;
    if (typeof flag !== 'boolean') {
        return unavailableCompaction('flag-invalid');
    }
    if (!flag) {
        return Array.isArray(rawSummaries) && rawSummaries.length > 0
            ? unavailableCompaction('incoherent')
            : unavailableCompaction('not-compacted');
    }
    if (!Array.isArray(rawSummaries)) {
        return unavailableCompaction('summaries-unavailable');
    }
    const summaries: SharedTestCompactionSummary[] = [];
    const groups = new Set<string>();
    let summaryEventCount = 0;
    for (const [index, value] of rawSummaries.entries()) {
        const summary = compactionSummary(value, index);
        if (!summary) {
            return unavailableCompaction('summaries-invalid');
        }
        const group = JSON.stringify([
            summary.name,
            summary.transport,
            summary.action,
            summary.connection ?? 'unknown'
        ]);
        summaryEventCount += summary.count;
        if (
            summary.firstSequence < 1 || summary.lastSequence > totalEvents ||
            summary.count > summary.lastSequence - summary.firstSequence + 1 ||
            !Number.isSafeInteger(summaryEventCount) ||
            summaryEventCount > omittedEvents || groups.has(group)
        ) {
            return unavailableCompaction('index-inconsistent');
        }
        groups.add(group);
        summaries.push(summary);
    }
    return {
        status: 'compacted',
        summariesAvailable: true,
        summaryCount: summaries.length,
        summaries
    };
}
function inconsistentPresentation(): SharedTestArtifactIndexPresentation {
    return { status: 'inconsistent', truncation: {}, compaction: unavailableCompaction('index-inconsistent') };
}
function unavailableCompaction(
    status: Exclude<
        SharedTestArtifactIndexPresentation['compaction'][
            'status'
        ],
        'compacted'
    >
): SharedTestArtifactIndexPresentation['compaction'] {
    return { status, summariesAvailable: false, summaries: [] };
}
function compactionSummary(value: unknown, index: number): SharedTestCompactionSummary | undefined {
    const summary = recordValue(value);
    const name = stringValue(summary?.name);
    const transport = stringValue(summary?.transport);
    const action = stringValue(summary?.action);
    const connection = summary?.connection === undefined
        ? undefined
        : stringValue(summary.connection);
    const count = integerValue(summary?.count, 1);
    const firstSequence = integerValue(summary?.firstSequence, 0);
    const lastSequence = integerValue(summary?.lastSequence, 0);
    if (
        summary?.status !== 'SUCCESS' || !name || !transport || !action ||
        (summary.connection !== undefined && !connection) ||
        count === undefined || firstSequence === undefined ||
        lastSequence === undefined || firstSequence > lastSequence
    ) {
        return undefined;
    }
    return {
        sourceOrdinal: index + 1,
        name,
        transport,
        action,
        connection,
        count,
        firstSequence,
        lastSequence
    };
}
export function deriveSharedTestCompactionSummaryWindow(
    summaries: readonly SharedTestCompactionSummary[],
    requestedStartIndex: number
): SharedTestCompactionSummaryWindow {
    const size = SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE;
    const total = summaries.length;
    const lastStartIndex = Math.floor(Math.max(0, total - 1) / size) * size;
    const requested = Math.floor(nonNegativeNumber(requestedStartIndex) ?? 0);
    const startIndex = Math.min(Math.floor(requested / size) * size, lastStartIndex);
    const endIndexExclusive = Math.min(startIndex + size, total);
    return {
        total,
        startIndex,
        endIndexExclusive,
        displayStart: total === 0 ? 0 : startIndex + 1,
        displayEnd: endIndexExclusive,
        canPrevious: startIndex > 0,
        canNext: endIndexExclusive < total,
        rows: summaries.slice(startIndex, endIndexExclusive)
    };
}
export function moveSharedTestCompactionSummaryWindow(
    window: SharedTestCompactionSummaryWindow,
    direction: 'previous' | 'next'
): number {
    return direction === 'previous'
        ? Math.max(0, window.startIndex - SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE)
        : window.canNext
        ? window.endIndexExclusive
        : window.startIndex;
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function integerValue(value: unknown, minimum: number): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
        ? value
        : undefined;
}
function nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
