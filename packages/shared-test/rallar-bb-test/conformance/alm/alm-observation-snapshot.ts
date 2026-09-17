import { Either } from '../../../../shared/resilience/Either.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const RTC_LIFECYCLE_TOPIC = 'rallar.browser.rtc.lifecycle';
const STORAGE_COUNTERS_TOPIC = 'rallar.bb.storage.counters';
const COMMIT_PHASES_DIAGNOSTIC_KIND = 'commit-phases';
const WORK_PAGE_COUNTER_KIND = 'work-page';
const RECIPE_RUN_RESULT_KIND = 'recipe.run';

export interface ALMObservationCommitPhase {
    readonly atEpochMs: number;
    readonly origin: string;
    readonly readDurationMs: number;
    readonly readOperationCount: number;
}

export interface ALMObservationRtcLifecycle {
    readonly atEpochMs: number;
    readonly sessionId: string;
    readonly knownPeerIds: readonly string[];
    readonly readyPeerIds: readonly string[];
}

export interface ALMObservationStorageCounters {
    readonly atEpochMs: number;
    readonly workPageCount: number;
}

export type ALMObservationCommandResult =
    | Readonly<{ outcome: 'completed'; commandId: string; recipeId: string; durationMs: number; }>
    | Readonly<{ outcome: 'failed'; commandId: string; failureCode: string; }>;

export interface ALMObservationSnapshot {
    readonly runId: string;
    readonly firstEventAtEpochMs: number;
    readonly commitPhases: readonly ALMObservationCommitPhase[];
    readonly rtcLifecycles: readonly ALMObservationRtcLifecycle[];
    readonly storageCounters: readonly ALMObservationStorageCounters[];
    readonly commandResults: readonly ALMObservationCommandResult[];
}

interface ALMObservationDiagnostic {
    readonly atEpochMs: number;
    readonly topic: string;
    readonly detail: RallarBlackBoxTestRecord;
}

/**
 * Rejects only a value that carries no usable control run at all. An entry that does not match one of
 * the narrow shapes above is skipped rather than reported: a lane snapshot legitimately carries
 * hundreds of events this contract does not read.
 */
export function decodeALMObservationSnapshot(
    value: unknown
): Either<readonly string[], ALMObservationSnapshot> {
    if (!isRecord(value)) {
        return Either.ofLeft(['snapshot is not an object']);
    }
    const runId = decodeText(value.runId);
    const events = decodeRecordArray(value.events);
    const results = decodeRecordArray(value.results);
    const firstEventAtEpochMs = toFirstEventAtEpochMs(events ?? []);
    if (runId === undefined || events === undefined || results === undefined || firstEventAtEpochMs === undefined) {
        return Either.ofLeft(toSnapshotIssues({ runId, events, results, firstEventAtEpochMs }));
    }
    const diagnostics = events.map(toDiagnostic).filter(isPresent);
    return Either.ofRight({
        runId,
        firstEventAtEpochMs,
        commitPhases: toTopicDiagnostics(diagnostics, OUTBOUND_DIAGNOSTICS_TOPIC).map(toCommitPhase).filter(isPresent),
        rtcLifecycles: toTopicDiagnostics(diagnostics, RTC_LIFECYCLE_TOPIC).map(toRtcLifecycle).filter(isPresent),
        storageCounters: toTopicDiagnostics(diagnostics, STORAGE_COUNTERS_TOPIC).map(toStorageCounter).filter(
            isPresent
        ),
        commandResults: results.map(toCommandResult).filter(isPresent)
    });
}

function toSnapshotIssues(
    parts: Readonly<{
        runId: string | undefined;
        events: readonly RallarBlackBoxTestRecord[] | undefined;
        results: readonly RallarBlackBoxTestRecord[] | undefined;
        firstEventAtEpochMs: number | undefined;
    }>
): readonly string[] {
    return [
        ...(parts.runId === undefined ? ['snapshot.runId is not a string'] : []),
        ...(parts.events === undefined ? ['snapshot.events is not an array'] : []),
        ...(parts.results === undefined ? ['snapshot.results is not an array'] : []),
        ...(parts.events !== undefined && parts.firstEventAtEpochMs === undefined
            ? ['snapshot.events carries no timestamped event']
            : [])
    ];
}

function toFirstEventAtEpochMs(events: readonly RallarBlackBoxTestRecord[]): number | undefined {
    return events
        .map((event) => decodeFiniteNumber(event.atEpochMs))
        .filter(isPresent)
        .reduce<number | undefined>(
            (earliest, atEpochMs) => earliest !== undefined && earliest < atEpochMs ? earliest : atEpochMs,
            undefined
        );
}

function toTopicDiagnostics(
    diagnostics: readonly ALMObservationDiagnostic[],
    topic: string
): readonly ALMObservationDiagnostic[] {
    return diagnostics.filter((diagnostic) => diagnostic.topic === topic);
}

function toCommitPhase(
    diagnostic: ALMObservationDiagnostic
): ALMObservationCommitPhase | undefined {
    const origin = decodeText(diagnostic.detail.origin);
    const readDurationMs = decodeFiniteNumber(diagnostic.detail.readDurationMs);
    const readOperationCount = decodeFiniteNumber(diagnostic.detail.readOperationCount);
    return diagnostic.detail.kind !== COMMIT_PHASES_DIAGNOSTIC_KIND || origin === undefined ||
            readDurationMs === undefined || readOperationCount === undefined || readOperationCount <= 0
        ? undefined
        : { atEpochMs: diagnostic.atEpochMs, origin, readDurationMs, readOperationCount };
}

function toRtcLifecycle(
    diagnostic: ALMObservationDiagnostic
): ALMObservationRtcLifecycle | undefined {
    const status = decodeRecord(diagnostic.detail.status);
    const sessionId = decodeText(status?.sessionId);
    return status === undefined || sessionId === undefined ? undefined : {
        atEpochMs: diagnostic.atEpochMs,
        sessionId,
        knownPeerIds: decodeTextArray(status.knownPeerIds),
        readyPeerIds: decodeTextArray(status.readyPeerIds)
    };
}

function toStorageCounter(
    diagnostic: ALMObservationDiagnostic
): ALMObservationStorageCounters | undefined {
    const workPageCount = decodeFiniteNumber(decodeRecord(diagnostic.detail.byKind)?.[WORK_PAGE_COUNTER_KIND]);
    return workPageCount === undefined
        ? undefined
        : { atEpochMs: diagnostic.atEpochMs, workPageCount };
}

/**
 * A recipe run that failed carries no result object at all, only an error, so its wall clock is not
 * recorded anywhere. The wrapping code is the same `RALLAR_BLACK_BOX_RECIPE_FAILED` on every failure;
 * the failing step's own code is the one that discriminates, so it is preferred when present.
 */
function toCommandResult(entry: RallarBlackBoxTestRecord): ALMObservationCommandResult | undefined {
    const commandId = decodeText(entry.commandId);
    const result = decodeRecord(entry.result);
    const error = decodeRecord(entry.error);
    const recipeId = decodeText(decodeRecord(result?.value)?.recipeId);
    const durationMs = decodeFiniteNumber(result?.durationMs);
    const failureCode = decodeText(decodeRecord(error?.details)?.code) ?? decodeText(error?.code);
    if (commandId === undefined) {
        return undefined;
    }
    if (result?.kind === RECIPE_RUN_RESULT_KIND && recipeId !== undefined && durationMs !== undefined) {
        return { outcome: 'completed', commandId, recipeId, durationMs };
    }
    return failureCode === undefined ? undefined : { outcome: 'failed', commandId, failureCode };
}

function toDiagnostic(event: RallarBlackBoxTestRecord): ALMObservationDiagnostic | undefined {
    const envelope = decodeRecord(event.payload);
    const atEpochMs = decodeFiniteNumber(event.atEpochMs);
    const topic = decodeText(envelope?.topic);
    const detail = decodeRecord(decodeRecord(envelope?.payload)?.data);
    return atEpochMs === undefined || topic === undefined || detail === undefined
        ? undefined
        : { atEpochMs, topic, detail };
}

function isRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent<TValue>(value: TValue | undefined): value is TValue {
    return value !== undefined;
}

function decodeRecord(value: unknown): RallarBlackBoxTestRecord | undefined {
    return isRecord(value) ? value : undefined;
}

function decodeRecordArray(value: unknown): readonly RallarBlackBoxTestRecord[] | undefined {
    return Array.isArray(value) ? value.map(decodeRecord).filter(isPresent) : undefined;
}

function decodeTextArray(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.map(decodeText).filter(isPresent) : [];
}

function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function decodeFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
