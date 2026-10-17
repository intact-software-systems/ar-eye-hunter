import { Either } from '@shared/resilience/Either.ts';

import { decodeResultReleaseArtifact } from '../../../shared-test/rallar-bb-test/result-release/decode-result-release-artifact.ts';
import type { RallarBlackBoxEventHistory } from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';
import type { RtcBaselineJson } from '../contracts/rtc-baseline-contracts.ts';
import { toRtcB06EventHistory } from './to-rtc-b06-event-history.ts';
import type { RtcB06BrowserRecordingReading } from './validate-rtc-b06-browser-recording.ts';

export interface RtcB06JournalRuntimeRow {
    readonly agentId: string;
    readonly kind: keyof RallarBlackBoxEventHistory['countsByKind'];
    readonly runtimeId: string;
    readonly generation: number;
    readonly ordinal: number;
}

export const RTC_B06_JOURNAL_EVENT_KINDS = [
    'event',
    'diagnostic',
    'message',
    'stats',
    'report',
    'result',
    'state'
] as const;

export function toRtcB06JournalRow(line: string): Either<string, Readonly<Record<string, RtcBaselineJson>>> {
    try {
        const row = toRecord(JSON.parse(line));
        return row === undefined ? Either.ofLeft('journal-malformed-row') : Either.ofRight(row);
    }
    catch {
        return Either.ofLeft('journal-malformed-json');
    }
}

export function toRtcB06JournalRuntimeRow(
    row: Readonly<Record<string, RtcBaselineJson>>,
    boundary: RtcB06BrowserRecordingReading
): Either<string, RtcB06JournalRuntimeRow | null> {
    const release = decodeResultReleaseArtifact(row, { runId: boundary.runId, agentIds: new Set([boundary.agentId]) });
    if (release.left !== undefined) {
        return Either.ofLeft(`journal-malformed-release-acknowledgement: ${release.left}`);
    }
    if (release.right !== null) {
        return Either.ofRight(null);
    }
    const value = toRecord(row.value);
    if (
        (row.kind !== 'rtc-diagnostic' && row.kind !== 'crdt-diagnostic') || value === undefined ||
        typeof value.eventId !== 'string' || value.eventId.length === 0 ||
        typeof value.topic !== 'string' || value.topic.length === 0 ||
        typeof value.atEpochMs !== 'number' || !Number.isFinite(value.atEpochMs) ||
        !RTC_B06_JOURNAL_EVENT_KINDS.includes(value.kind as typeof RTC_B06_JOURNAL_EVENT_KINDS[number]) ||
        row.status !== (['diagnostic', 'stats', 'report'].includes(String(value.kind)) ? value.kind : 'event')
    ) {
        return Either.ofLeft('journal-malformed-runtime-event');
    }
    const control = toRecord(value.control);
    if (
        value.control !== undefined && (control?.runId !== boundary.runId || control.agentId !== boundary.agentId ||
            typeof control.rootCommandId !== 'string' || control.rootCommandId.length === 0)
    ) {
        return Either.ofLeft('journal-wrong-command-attribution');
    }
    const history = toRecord(value.history);
    if (value.history === undefined && isGeneratedControlRow(value, boundary)) {
        return Either.ofRight(null);
    }
    if (
        history === undefined || typeof history.runtimeId !== 'string' || !Number.isSafeInteger(history.generation) ||
        !Number.isSafeInteger(history.ordinal) || Number(history.ordinal) < 1
    ) {
        return Either.ofLeft('journal-missing-runtime-sequence');
    }
    return Either.ofRight({
        agentId: boundary.agentId,
        kind: value.kind as RtcB06JournalRuntimeRow['kind'],
        runtimeId: history.runtimeId,
        generation: history.generation as number,
        ordinal: history.ordinal as number
    });
}

export function toRtcB06JournalHealth(
    row: Readonly<Record<string, RtcBaselineJson>>
): RallarBlackBoxEventHistory | undefined {
    return toRtcB06EventHistory(toRecord(toRecord(row.actual)?.stats)?.eventHistory);
}

function isGeneratedControlRow(
    value: Readonly<Record<string, RtcBaselineJson>>,
    boundary: RtcB06BrowserRecordingReading
): boolean {
    if (
        value.kind === 'stats' && value.topic === 'rallar.bb.stats' &&
        /^control-stats-[0-9]+$/.test(String(value.eventId))
    ) {
        const stats = toRecord(value.payload);
        const counters = toRecord(stats?.counters);
        const history = toRecord(stats?.eventHistory);
        return typeof stats?.atEpochMs === 'number' && Number.isFinite(stats.atEpochMs) &&
            typeof stats.status === 'string' &&
            counters !== undefined && ['commands', 'events', 'failures', 'messages', 'diagnostics'].every((kind) =>
                typeof counters[kind] === 'number' && Number.isSafeInteger(counters[kind]) &&
                Number(counters[kind]) >= 0
            ) &&
            history?.runtimeId === boundary.currentHistory.runtimeId &&
            history.generation === boundary.currentHistory.generation;
    }
    const report = toRecord(value.payload);
    return value.kind === 'report' && value.topic === 'rallar.bb.report.final' &&
        typeof report?.reportId === 'string' && value.eventId === `control-report-event-${report.reportId}` &&
        report.runId === boundary.runId && report.agentId === boundary.agentId &&
        toRecord(report.summary) !== undefined && toRecord(report.stats) !== undefined;
}

function toRecord(value: RtcBaselineJson | undefined): Readonly<Record<string, RtcBaselineJson>> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
