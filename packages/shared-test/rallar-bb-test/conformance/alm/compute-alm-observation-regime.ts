import type { ALCongestionCounters } from '../../../../shared/alm/outbound/al-outbound-message-runtime.ts';
import type {
    ALMObservationPageDiagnosticRecord,
    ALMObservationPageDiagnosticsFile
} from './alm-observation-page-diagnostics.ts';
import type {
    ALMObservationAgentRole,
    ALMObservationCommandResult,
    ALMObservationCongestionReading,
    ALMObservationInboundClaim,
    ALMObservationInboundDrain,
    ALMObservationInboundOutcome,
    ALMObservationLedgerReading,
    ALMObservationRtcLifecycle,
    ALMObservationSnapshot,
    ALMObservationStorageCounters
} from './alm-observation-snapshot.ts';
import {
    computeMedian,
    computePageRegime,
    toTwoDecimals,
    type ALMObservationPageRegime
} from './compute-alm-observation-page-regime.ts';

/**
 * Seven hosted observation runs (2026-09-10/11) separate a runner that completes the lane from one
 * that cannot: every head whose rtc cell opened at or below 24 ms per admission read operation went
 * 6 ready / 0 timeout, and every head at or above 36 ms went 0 ready / 6 timeout — including a
 * same-day re-execution of a green head, which failed identically. The band between the two
 * constants stays unclassified rather than guessed. Only `send`-origin commits count, because a
 * drain's commit measures a different read chain than a caller's own admission. The calibration read
 * the cell's opening window; since S3a's volatile default a cell's first durable send comes from
 * `durable-opt-in`, well past it, so the measurement spans the durable send commits of the whole cell
 * (R-S3a-16). A cell with none leaves the verdict to the page regime.
 */
export const ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION = 30;
export const ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION = 35;
export const ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT = 5;
export const ALM_OBSERVATION_WINDOW_MS = 20_000;
export const ALM_OBSERVATION_COMMIT_ORIGIN = 'send';

const ALM_OBSERVATION_AGENT_ROLES: readonly ALMObservationAgentRole[] = ['sender', 'receiver', 'unattributed'];
const PENDING_INBOUND_OUTCOME = 'pending';
const DISPATCH_LOCAL_PAYLOAD_KIND = 'dispatch-local';
const SEND_CONTROL_PAYLOAD_KIND = 'send-control';
/** Task 7b: bounds the cell JSON, not the raw file — the raw file already caps at 200 per page. */
const ALM_OBSERVATION_PAGE_DIAGNOSTICS_FIRST_LIMIT = 20;

export type ALMObservationRegimeName = 'normal' | 'slow' | 'unclassified';

export type ALMObservationCellOutcome = 'passed' | 'failed';

/** Which instrument decided `regime`: the durable send commits, or the page's probes when there were none. */
export type ALMObservationRegimeSource = 'per-operation' | 'page';

export type ALMObservationPerOperation =
    | Readonly<{ outcome: 'measured'; medianMs: number; sampleCount: number; }>
    | Readonly<{ outcome: 'too-few-samples'; sampleCount: number; }>;

export type ALMObservationPeerReadiness =
    | Readonly<{ outcome: 'ready'; sessionId: string; peerId: string; readinessMs: number; }>
    | Readonly<{ outcome: 'never-ready'; sessionId: string; peerId: string; observedMs: number; }>;

export type ALMObservationWorkPageRate =
    | Readonly<{ outcome: 'measured'; perSecond: number; readingCount: number; spanMs: number; }>
    | Readonly<{ outcome: 'too-few-readings'; readingCount: number; }>;

export interface ALMObservationInboundPhases {
    readonly selectionMedianMs: number;
    readonly claimMedianMs: number;
    readonly runMedianMs: number;
    readonly releaseMedianMs: number;
    readonly queueWaitMedianMs: number;
    readonly drainMedianMs: number;
    readonly drainCount: number;
}

export interface ALMObservationInboundClaimWaits {
    /**
     * Median `batchStartedAtMs − dueAtMs` over this role's `dispatch-local` claims: from due to the run
     * loop of the batch that ran the claim -- the wait for a round, plus that batch's selection and
     * reservation.
     */
    readonly reservationWaitMedianMs: number;
    /** Median `startedAtMs − batchStartedAtMs` over the same claims: the serialization behind earlier claims of the run loop. */
    readonly intraBatchWaitMedianMs: number;
    readonly dispatchClaimCount: number;
    /** Median `durationMs` over this role's `send-control` claims. */
    readonly sendControlClaimMedianMs: number;
    readonly sendControlClaimCount: number;
}

/** A `pendingSharePercent` over zero `admission-outcome` events is not a measurement. */
export type ALMObservationInboundPendingShare =
    | Readonly<{ outcome: 'measured'; pendingSharePercent: number; outcomeCount: number; }>
    | Readonly<{ outcome: 'unmeasured'; }>;

export type ALMObservationInboundDirection =
    | Readonly<{
        role: ALMObservationAgentRole;
        outcome: 'measured';
        pendingShare: ALMObservationInboundPendingShare;
        phases: ALMObservationInboundPhases;
        claimWaits: ALMObservationInboundClaimWaits;
    }>
    | Readonly<{ role: ALMObservationAgentRole; outcome: 'no-events'; }>;

/**
 * The lane's raw `pageerror`/console capture, folded into the cell. `not-captured` means the lane
 * did not supply the file at all (an older artifact), not that the page raised nothing.
 */
export type ALMObservationPageDiagnostics =
    | Readonly<{
        outcome: 'captured';
        counts: Readonly<{ pageerror: number; consoleError: number; consoleWarning: number; }>;
        dropped: number;
        first: readonly ALMObservationPageDiagnosticRecord[];
    }>
    | Readonly<{ outcome: 'not-captured'; }>;

/**
 * The cell's session ledgers at their fullest (D180): each maximum is over every `stats` reading of every
 * agent, so it reads the most any one page held, not a sum across pages. `no-readings` is a cell whose
 * agents read no ledger at all, not an idle one.
 */
export type ALMObservationLedger =
    | Readonly<{
        outcome: 'measured';
        readingCount: number;
        maxAdmissions: number;
        maxBytes: number;
        maxOldestAgeMs: number;
        maxTracks: number;
        /** The most arrivals and arrival bytes one page's inbound pool held (D189). */
        maxInboundAdmissions: number;
        maxInboundBytes: number;
        overloadedReadings: number;
    }>
    | Readonly<{ outcome: 'no-readings'; }>;

/**
 * The congestion decisions the cell's pages counted (D186). A page's counters only grow between its closes, so each
 * page contributes its largest reading of each count and the cell sums its pages. The sum is a lower bound when a page
 * reconnects inside the cell: the counts of its earlier connection are lost at that close. `no-readings` is a cell
 * whose agents read no counters at all, not an uncongested one.
 */
export type ALMObservationCongestion =
    | Readonly<{ outcome: 'measured'; readingCount: number; dropped: number; deferred: number; handedOver: number; }>
    | Readonly<{ outcome: 'no-readings'; }>;

export interface ALMObservationRegime {
    readonly runId: string;
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly regime: ALMObservationRegimeName;
    readonly regimeSource: ALMObservationRegimeSource;
    readonly windowMs: number;
    readonly perOperation: ALMObservationPerOperation;
    readonly peerReadiness: readonly ALMObservationPeerReadiness[];
    readonly scenarioSends: readonly ALMObservationCommandResult[];
    readonly workPageRate: ALMObservationWorkPageRate;
    readonly inbound: readonly ALMObservationInboundDirection[];
    readonly pageDiagnostics: ALMObservationPageDiagnostics;
    readonly pageRegime: ALMObservationPageRegime;
    readonly ledger: ALMObservationLedger;
    readonly congestion: ALMObservationCongestion;
    readonly snapshotIssues: readonly string[];
}

export interface ALMObservationRegimeInput {
    readonly snapshot: ALMObservationSnapshot;
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly pageDiagnosticsFile?: ALMObservationPageDiagnosticsFile;
}

export interface UnreadableALMObservationRegimeInput {
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly snapshotIssues: readonly string[];
    readonly pageDiagnosticsFile?: ALMObservationPageDiagnosticsFile;
}

interface ALMObservationPeerObservation {
    readonly sessionId: string;
    readonly peerId: string;
    knownAtEpochMs: number;
    readyAtEpochMs: number | undefined;
}

export function computeALMObservationRegime(input: ALMObservationRegimeInput): ALMObservationRegime {
    const perOperation = computePerOperationCost(input.snapshot);
    const pageRegime = computePageRegime(
        input.snapshot,
        input.snapshot.firstEventAtEpochMs + ALM_OBSERVATION_WINDOW_MS
    );
    const measured = perOperation.outcome === 'measured';
    return {
        runId: input.snapshot.runId,
        carrier: input.carrier,
        scope: input.scope,
        cellOutcome: input.cellOutcome,
        regime: measured ? resolveRegimeName(perOperation) : pageRegime.regime,
        regimeSource: measured ? 'per-operation' : 'page',
        windowMs: ALM_OBSERVATION_WINDOW_MS,
        perOperation,
        peerReadiness: computePeerReadiness(input.snapshot.rtcLifecycles),
        scenarioSends: input.snapshot.commandResults,
        workPageRate: computeWorkPageRate(input.snapshot.storageCounters),
        inbound: computeInboundDirections(input.snapshot),
        pageDiagnostics: computePageDiagnostics(input.pageDiagnosticsFile),
        pageRegime,
        ledger: computeLedger(input.snapshot.ledgerReadings),
        congestion: computeCongestion(input.snapshot.congestionReadings),
        snapshotIssues: []
    };
}

/** The regime a cell whose snapshot could not be read still records, so every cell leaves a file. */
export function createUnreadableALMObservationRegime(
    input: UnreadableALMObservationRegimeInput
): ALMObservationRegime {
    return {
        runId: '',
        carrier: input.carrier,
        scope: input.scope,
        cellOutcome: input.cellOutcome,
        regime: 'unclassified',
        regimeSource: 'page',
        windowMs: ALM_OBSERVATION_WINDOW_MS,
        perOperation: { outcome: 'too-few-samples', sampleCount: 0 },
        peerReadiness: [],
        scenarioSends: [],
        workPageRate: { outcome: 'too-few-readings', readingCount: 0 },
        inbound: [],
        pageDiagnostics: computePageDiagnostics(input.pageDiagnosticsFile),
        pageRegime: { outcome: 'unmeasured', sampleCount: 0, regime: 'unclassified' },
        ledger: { outcome: 'no-readings' },
        congestion: { outcome: 'no-readings' },
        snapshotIssues: input.snapshotIssues
    };
}

/** `outcome: 'not-captured'` only when the lane supplied no file; a file with zero records is still `captured`. */
function computePageDiagnostics(
    file: ALMObservationPageDiagnosticsFile | undefined
): ALMObservationPageDiagnostics {
    if (file === undefined) {
        return { outcome: 'not-captured' };
    }
    const ordered = [...file.records].sort((left, right) => left.atMs - right.atMs);
    return {
        outcome: 'captured',
        counts: {
            pageerror: countPageDiagnosticKind(ordered, 'pageerror'),
            consoleError: countPageDiagnosticKind(ordered, 'console-error'),
            consoleWarning: countPageDiagnosticKind(ordered, 'console-warning')
        },
        dropped: file.droppedCount,
        first: ordered.slice(0, ALM_OBSERVATION_PAGE_DIAGNOSTICS_FIRST_LIMIT)
    };
}

function countPageDiagnosticKind(
    records: readonly ALMObservationPageDiagnosticRecord[],
    kind: ALMObservationPageDiagnosticRecord['kind']
): number {
    return records.filter((record) => record.kind === kind).length;
}

export function toALMObservationRegimeSummary(regime: ALMObservationRegime): string {
    const perOperation = regime.perOperation.outcome === 'measured'
        ? `${regime.perOperation.medianMs} ms/op over ${regime.perOperation.sampleCount} commits`
        : `unmeasured (${regime.perOperation.sampleCount} commits)`;
    const source = regime.regimeSource === 'page' ? ' (page)' : '';
    return `ALM observation ${regime.carrier}-${regime.scope}: regime=${regime.regime}${source} ` +
        `perOperation=${perOperation} outcome=${regime.cellOutcome} ${toPageRegimeSummary(regime.pageRegime)}`;
}

function toPageRegimeSummary(pageRegime: ALMObservationPageRegime): string {
    return pageRegime.outcome === 'measured'
        ? `page=${pageRegime.regime} (${pageRegime.storageProbeMedianMs} ms/probe over ${pageRegime.sampleCount})`
        : `page=unclassified (unmeasured, ${pageRegime.sampleCount} probes)`;
}

function computePerOperationCost(snapshot: ALMObservationSnapshot): ALMObservationPerOperation {
    const costs = snapshot.commitPhases
        .filter((phase) => phase.lane === 'durable' && phase.origin === ALM_OBSERVATION_COMMIT_ORIGIN)
        .map((phase) => phase.readDurationMs / phase.readOperationCount);
    return costs.length < ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT
        ? { outcome: 'too-few-samples', sampleCount: costs.length }
        : { outcome: 'measured', medianMs: toTwoDecimals(computeMedian(costs)), sampleCount: costs.length };
}

function resolveRegimeName(perOperation: ALMObservationPerOperation): ALMObservationRegimeName {
    if (perOperation.outcome === 'too-few-samples') {
        return 'unclassified';
    }
    if (perOperation.medianMs < ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION) {
        return 'normal';
    }
    return perOperation.medianMs >= ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION
        ? 'slow'
        : 'unclassified';
}

function computePeerReadiness(
    lifecycles: readonly ALMObservationRtcLifecycle[]
): readonly ALMObservationPeerReadiness[] {
    const ordered = [...lifecycles].sort((left, right) => left.atEpochMs - right.atEpochMs);
    const observations = new Map<string, ALMObservationPeerObservation>();
    let lastAtEpochMs = 0;
    for (const lifecycle of ordered) {
        lastAtEpochMs = lifecycle.atEpochMs;
        for (const peerId of lifecycle.knownPeerIds) {
            rememberPeerKnown(observations, lifecycle, peerId);
        }
        for (const peerId of lifecycle.readyPeerIds) {
            rememberPeerReady(observations, lifecycle, peerId);
        }
    }
    return [...observations.values()].map((observation) => toPeerReadiness(observation, lastAtEpochMs));
}

function rememberPeerKnown(
    observations: Map<string, ALMObservationPeerObservation>,
    lifecycle: ALMObservationRtcLifecycle,
    peerId: string
): void {
    const key = toPeerKey(lifecycle.sessionId, peerId);
    if (!observations.has(key)) {
        observations.set(key, {
            sessionId: lifecycle.sessionId,
            peerId,
            knownAtEpochMs: lifecycle.atEpochMs,
            readyAtEpochMs: undefined
        });
    }
}

function rememberPeerReady(
    observations: Map<string, ALMObservationPeerObservation>,
    lifecycle: ALMObservationRtcLifecycle,
    peerId: string
): void {
    rememberPeerKnown(observations, lifecycle, peerId);
    const observation = observations.get(toPeerKey(lifecycle.sessionId, peerId));
    if (observation !== undefined && observation.readyAtEpochMs === undefined) {
        observation.readyAtEpochMs = lifecycle.atEpochMs;
    }
}

/** Both halves are opaque `session-` tokens, so a space cannot collide across the pair. */
function toPeerKey(sessionId: string, peerId: string): string {
    return `${sessionId} ${peerId}`;
}

function toPeerReadiness(
    observation: ALMObservationPeerObservation,
    lastAtEpochMs: number
): ALMObservationPeerReadiness {
    const { sessionId, peerId, knownAtEpochMs, readyAtEpochMs } = observation;
    return readyAtEpochMs === undefined
        ? { outcome: 'never-ready', sessionId, peerId, observedMs: lastAtEpochMs - knownAtEpochMs }
        : { outcome: 'ready', sessionId, peerId, readinessMs: readyAtEpochMs - knownAtEpochMs };
}

function computeLedger(readings: readonly ALMObservationLedgerReading[]): ALMObservationLedger {
    if (readings.length === 0) {
        return { outcome: 'no-readings' };
    }
    const usages = readings.map((reading) => reading.usage);
    return {
        outcome: 'measured',
        readingCount: readings.length,
        maxAdmissions: usages.reduce((max, usage) => Math.max(max, usage.admissions), 0),
        maxBytes: usages.reduce((max, usage) => Math.max(max, usage.bytes), 0),
        maxOldestAgeMs: usages.reduce((max, usage) => Math.max(max, usage.oldestAgeMs), 0),
        maxTracks: usages.reduce((max, usage) => Math.max(max, usage.tracks), 0),
        maxInboundAdmissions: readings.reduce((max, reading) => Math.max(max, reading.inbound.admissions), 0),
        maxInboundBytes: readings.reduce((max, reading) => Math.max(max, reading.inbound.bytes), 0),
        overloadedReadings: readings.filter((reading) => reading.overloaded).length
    };
}

function computeCongestion(readings: readonly ALMObservationCongestionReading[]): ALMObservationCongestion {
    if (readings.length === 0) {
        return { outcome: 'no-readings' };
    }
    const largestByAgent = readings.reduce<Readonly<Record<string, ALCongestionCounters>>>(
        (largest, reading) => ({
            ...largest,
            [reading.agentId]: computeLargestCounters(largest[reading.agentId], reading.counters)
        }),
        {}
    );
    const pages = Object.values(largestByAgent);
    return {
        outcome: 'measured',
        readingCount: readings.length,
        dropped: pages.reduce((total, page) => total + page.dropped, 0),
        deferred: pages.reduce((total, page) => total + page.deferred, 0),
        handedOver: pages.reduce((total, page) => total + page.handedOver, 0)
    };
}

function computeLargestCounters(
    largest: ALCongestionCounters | undefined,
    reading: ALCongestionCounters
): ALCongestionCounters {
    return largest === undefined ? reading : {
        dropped: Math.max(largest.dropped, reading.dropped),
        deferred: Math.max(largest.deferred, reading.deferred),
        handedOver: Math.max(largest.handedOver, reading.handedOver)
    };
}

function computeWorkPageRate(
    readings: readonly ALMObservationStorageCounters[]
): ALMObservationWorkPageRate {
    const ordered = [...readings].sort((left, right) => left.atEpochMs - right.atEpochMs);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined || last.atEpochMs <= first.atEpochMs) {
        return { outcome: 'too-few-readings', readingCount: ordered.length };
    }
    const spanMs = last.atEpochMs - first.atEpochMs;
    return {
        outcome: 'measured',
        perSecond: toTwoDecimals(computeWorkPageIncrements(ordered) / (spanMs / 1000)),
        readingCount: ordered.length,
        spanMs
    };
}

/**
 * Each agent counts from its own previous reading, or from zero after a reading that reset the counter or
 * after a reload: a reading below the previous one comes from a new page whose counter started at zero.
 */
function computeWorkPageIncrements(ordered: readonly ALMObservationStorageCounters[]): number {
    const previousByAgent = new Map<string, ALMObservationStorageCounters>();
    let increments = 0;
    for (const reading of ordered) {
        const previous = previousByAgent.get(reading.agentId);
        if (previous !== undefined) {
            increments += reading.workPageCount - computeWorkPageBaseline(previous, reading);
        }
        previousByAgent.set(reading.agentId, reading);
    }
    return increments;
}

function computeWorkPageBaseline(
    previous: ALMObservationStorageCounters,
    reading: ALMObservationStorageCounters
): number {
    return previous.reset || reading.workPageCount < previous.workPageCount ? 0 : previous.workPageCount;
}

/**
 * `[]` when the whole snapshot carries no inbound event at all, so a cell that never enabled the
 * inbound sink leaves no placeholder rows. Otherwise every one of the three roles is reported, in a
 * fixed order, because the block reads the receiver whether or not the sender happened to emit too.
 */
function computeInboundDirections(snapshot: ALMObservationSnapshot): readonly ALMObservationInboundDirection[] {
    if (
        snapshot.inboundOutcomes.length === 0 && snapshot.inboundDrains.length === 0 &&
        snapshot.inboundClaims.length === 0
    ) {
        return [];
    }
    return ALM_OBSERVATION_AGENT_ROLES.map((role) =>
        toInboundDirection(role, {
            outcomes: snapshot.inboundOutcomes.filter((outcome) => outcome.role === role),
            drains: snapshot.inboundDrains.filter((drain) => drain.role === role),
            claims: snapshot.inboundClaims.filter((claim) => claim.role === role)
        })
    );
}

/** One role's share of the inbound events. */
interface ALMObservationInboundRoleEvents {
    readonly outcomes: readonly ALMObservationInboundOutcome[];
    readonly drains: readonly ALMObservationInboundDrain[];
    readonly claims: readonly ALMObservationInboundClaim[];
}

/**
 * The drain phases and claim waits read the IndexedDB lane only, as the runner regime does (R-S3a-15):
 * F2c's acceptance figures were measured when every inbound owner was IndexedDB, and a memory lane's
 * single-digit drains would pull a slow receiver's medians into the normal band.
 */
function toInboundDirection(
    role: ALMObservationAgentRole,
    events: ALMObservationInboundRoleEvents
): ALMObservationInboundDirection {
    const { outcomes, drains, claims } = events;
    return outcomes.length === 0 && drains.length === 0 && claims.length === 0
        ? { role, outcome: 'no-events' }
        : {
            role,
            outcome: 'measured',
            pendingShare: computeInboundPendingShare(outcomes),
            phases: computeInboundPhases(drains.filter((drain) => drain.lane === 'durable')),
            claimWaits: computeInboundClaimWaits(claims.filter((claim) => claim.lane === 'durable'))
        };
}

function computeInboundPendingShare(
    outcomes: readonly ALMObservationInboundOutcome[]
): ALMObservationInboundPendingShare {
    if (outcomes.length === 0) {
        return { outcome: 'unmeasured' };
    }
    const pendingCount = outcomes.filter((outcome) => outcome.outcome === PENDING_INBOUND_OUTCOME).length;
    return {
        outcome: 'measured',
        pendingSharePercent: toTwoDecimals(100 * pendingCount / outcomes.length),
        outcomeCount: outcomes.length
    };
}

function computeInboundPhases(drains: readonly ALMObservationInboundDrain[]): ALMObservationInboundPhases {
    return {
        selectionMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.selectionDurationMs))),
        claimMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.claimDurationMs))),
        runMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.runDurationMs))),
        releaseMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.releaseDurationMs))),
        queueWaitMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.queueWaitMs))),
        drainMedianMs: toTwoDecimals(computeMedian(drains.map((drain) => drain.durationMs))),
        drainCount: drains.length
    };
}

function computeInboundClaimWaits(claims: readonly ALMObservationInboundClaim[]): ALMObservationInboundClaimWaits {
    const dispatches = claims.filter((claim) => claim.payloadKind === DISPATCH_LOCAL_PAYLOAD_KIND);
    const sendControls = claims.filter((claim) => claim.payloadKind === SEND_CONTROL_PAYLOAD_KIND);
    return {
        reservationWaitMedianMs: toTwoDecimals(
            computeMedian(dispatches.map((claim) => claim.batchStartedAtMs - claim.dueAtMs))
        ),
        intraBatchWaitMedianMs: toTwoDecimals(
            computeMedian(dispatches.map((claim) => claim.startedAtMs - claim.batchStartedAtMs))
        ),
        dispatchClaimCount: dispatches.length,
        sendControlClaimMedianMs: toTwoDecimals(computeMedian(sendControls.map((claim) => claim.durationMs))),
        sendControlClaimCount: sendControls.length
    };
}
