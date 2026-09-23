import { Either } from '../../../../shared/resilience/Either.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';

const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const RTC_LIFECYCLE_TOPIC = 'rallar.browser.rtc.lifecycle';
const STORAGE_COUNTERS_TOPIC = 'rallar.bb.storage.counters';
const COMMIT_PHASES_DIAGNOSTIC_KIND = 'commit-phases';
const READINESS_PROBE_DIAGNOSTIC_KIND = 'readiness-probe';
const ADMISSION_OUTCOME_DIAGNOSTIC_KIND = 'admission-outcome';
const EFFECT_DRAIN_DIAGNOSTIC_KIND = 'effect-drain';
const CLAIM_SETTLED_DIAGNOSTIC_KIND = 'claim-settled';
const WORK_PAGE_COUNTER_KIND = 'work-page';
const RECIPE_RUN_RESULT_KIND = 'recipe.run';
/** The ALM lane mints its agent ids with these prefixes (`full-stack-helpers.ts:838`). */
const SENDER_AGENT_ID_PREFIX = 'alm-sender-';
const RECEIVER_AGENT_ID_PREFIX = 'alm-receiver-';

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

/**
 * Which page an inbound event came from. The ALM lane mints its agent ids as `alm-sender-…` and
 * `alm-receiver-…` (`full-stack-helpers.ts:838`); any other id is `unattributed` rather than
 * guessed, so a snapshot from another lane still decodes.
 */
export type ALMObservationAgentRole = 'sender' | 'receiver' | 'unattributed';

export interface ALMObservationInboundOutcome {
    readonly atEpochMs: number;
    readonly role: ALMObservationAgentRole;
    readonly workerId: string;
    /** `committed`, `pending`, `unauthorized`, `rejected` or `not-handled`, as the topic emits it. */
    readonly outcome: string;
}

export interface ALMObservationInboundDrain {
    readonly atEpochMs: number;
    readonly role: ALMObservationAgentRole;
    readonly workerId: string;
    readonly durationMs: number;
    readonly selectionDurationMs: number;
    readonly claimDurationMs: number;
    readonly runDurationMs: number;
    readonly releaseDurationMs: number;
    readonly queueWaitMs: number;
}

/** One `claim-settled`: what the claim cost, and the three instants its wait splits at. */
export interface ALMObservationInboundClaim {
    readonly atEpochMs: number;
    readonly role: ALMObservationAgentRole;
    readonly workerId: string;
    /** `dispatch-local`, `send-control` or another effect kind, as the topic emits it. */
    readonly payloadKind: string;
    readonly durationMs: number;
    readonly dueAtMs: number;
    readonly batchStartedAtMs: number;
    readonly startedAtMs: number;
}

/** One outbound `readiness-probe`: a fixed-shape storage read, so its duration reads the page's storage queue. */
export interface ALMObservationReadinessProbe {
    readonly atEpochMs: number;
    readonly role: ALMObservationAgentRole;
    /** `age-bound`, `own-commit`, `batch`, `retained-release`, `external-wake` or `no-memory`, as the topic emits it. */
    readonly cause: string;
    readonly durationMs: number;
}

export function resolveALMObservationAgentRole(agentId: string): ALMObservationAgentRole {
    if (agentId.startsWith(SENDER_AGENT_ID_PREFIX)) {
        return 'sender';
    }
    if (agentId.startsWith(RECEIVER_AGENT_ID_PREFIX)) {
        return 'receiver';
    }
    return 'unattributed';
}

export interface ALMObservationSnapshot {
    readonly runId: string;
    readonly firstEventAtEpochMs: number;
    readonly commitPhases: readonly ALMObservationCommitPhase[];
    readonly rtcLifecycles: readonly ALMObservationRtcLifecycle[];
    readonly storageCounters: readonly ALMObservationStorageCounters[];
    readonly commandResults: readonly ALMObservationCommandResult[];
    readonly inboundOutcomes: readonly ALMObservationInboundOutcome[];
    readonly inboundDrains: readonly ALMObservationInboundDrain[];
    readonly inboundClaims: readonly ALMObservationInboundClaim[];
    readonly readinessProbes: readonly ALMObservationReadinessProbe[];
}

interface ALMObservationDiagnostic {
    readonly atEpochMs: number;
    readonly agentId: string;
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
        commandResults: results.map(toCommandResult).filter(isPresent),
        inboundOutcomes: toTopicDiagnostics(diagnostics, INBOUND_DIAGNOSTICS_TOPIC).map(toInboundOutcome).filter(
            isPresent
        ),
        inboundDrains: toTopicDiagnostics(diagnostics, INBOUND_DIAGNOSTICS_TOPIC).map(toInboundDrain).filter(
            isPresent
        ),
        inboundClaims: toTopicDiagnostics(diagnostics, INBOUND_DIAGNOSTICS_TOPIC).map(toInboundClaim).filter(
            isPresent
        ),
        readinessProbes: toTopicDiagnostics(diagnostics, OUTBOUND_DIAGNOSTICS_TOPIC).map(toReadinessProbe).filter(
            isPresent
        )
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

function toInboundOutcome(
    diagnostic: ALMObservationDiagnostic
): ALMObservationInboundOutcome | undefined {
    const workerId = decodeText(diagnostic.detail.workerId);
    const outcome = decodeText(diagnostic.detail.outcome);
    return diagnostic.detail.kind !== ADMISSION_OUTCOME_DIAGNOSTIC_KIND || workerId === undefined ||
            outcome === undefined
        ? undefined
        : {
            atEpochMs: diagnostic.atEpochMs,
            role: resolveALMObservationAgentRole(diagnostic.agentId),
            workerId,
            outcome
        };
}

function toInboundDrain(
    diagnostic: ALMObservationDiagnostic
): ALMObservationInboundDrain | undefined {
    const workerId = decodeText(diagnostic.detail.workerId);
    const durationMs = decodeFiniteNumber(diagnostic.detail.durationMs);
    const selectionDurationMs = decodeFiniteNumber(diagnostic.detail.selectionDurationMs);
    const claimDurationMs = decodeFiniteNumber(diagnostic.detail.claimDurationMs);
    const runDurationMs = decodeFiniteNumber(diagnostic.detail.runDurationMs);
    const releaseDurationMs = decodeFiniteNumber(diagnostic.detail.releaseDurationMs);
    const queueWaitMs = decodeFiniteNumber(diagnostic.detail.queueWaitMs);
    if (
        diagnostic.detail.kind !== EFFECT_DRAIN_DIAGNOSTIC_KIND || workerId === undefined ||
        durationMs === undefined || selectionDurationMs === undefined || claimDurationMs === undefined ||
        runDurationMs === undefined || releaseDurationMs === undefined || queueWaitMs === undefined
    ) {
        return undefined;
    }
    return {
        atEpochMs: diagnostic.atEpochMs,
        role: resolveALMObservationAgentRole(diagnostic.agentId),
        workerId,
        durationMs,
        selectionDurationMs,
        claimDurationMs,
        runDurationMs,
        releaseDurationMs,
        queueWaitMs
    };
}

function toInboundClaim(
    diagnostic: ALMObservationDiagnostic
): ALMObservationInboundClaim | undefined {
    const workerId = decodeText(diagnostic.detail.workerId);
    const payloadKind = decodeText(diagnostic.detail.payloadKind);
    const durationMs = decodeFiniteNumber(diagnostic.detail.durationMs);
    const dueAtMs = decodeFiniteNumber(diagnostic.detail.dueAtMs);
    const batchStartedAtMs = decodeFiniteNumber(diagnostic.detail.batchStartedAtMs);
    const startedAtMs = decodeFiniteNumber(diagnostic.detail.startedAtMs);
    if (
        diagnostic.detail.kind !== CLAIM_SETTLED_DIAGNOSTIC_KIND || workerId === undefined ||
        payloadKind === undefined || durationMs === undefined || dueAtMs === undefined ||
        batchStartedAtMs === undefined || startedAtMs === undefined
    ) {
        return undefined;
    }
    return {
        atEpochMs: diagnostic.atEpochMs,
        role: resolveALMObservationAgentRole(diagnostic.agentId),
        workerId,
        payloadKind,
        durationMs,
        dueAtMs,
        batchStartedAtMs,
        startedAtMs
    };
}

function toReadinessProbe(
    diagnostic: ALMObservationDiagnostic
): ALMObservationReadinessProbe | undefined {
    const cause = decodeText(diagnostic.detail.cause);
    const durationMs = decodeFiniteNumber(diagnostic.detail.durationMs);
    return diagnostic.detail.kind !== READINESS_PROBE_DIAGNOSTIC_KIND || cause === undefined ||
            durationMs === undefined
        ? undefined
        : {
            atEpochMs: diagnostic.atEpochMs,
            role: resolveALMObservationAgentRole(diagnostic.agentId),
            cause,
            durationMs
        };
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
    const agentId = decodeText(event.agentId);
    const topic = decodeText(envelope?.topic);
    const detail = decodeRecord(decodeRecord(envelope?.payload)?.data);
    return atEpochMs === undefined || agentId === undefined || topic === undefined || detail === undefined
        ? undefined
        : { atEpochMs, agentId, topic, detail };
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
