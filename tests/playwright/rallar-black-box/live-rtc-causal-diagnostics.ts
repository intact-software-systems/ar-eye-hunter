import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import {
    jsonRecord,
    numberValue,
    stringArrayValue,
    toLiveRtcRuntimeEvent,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';

export interface LiveRtcReadinessAgentHealth {
    readonly captureSucceeded: boolean;
    readonly commandOk: boolean | null;
    readonly failure: 'health-capture-failed' | null;
    readonly localSessionId: string | null;
    readonly readyPeerIds: readonly string[];
    readonly knownPeerIds: readonly string[];
    readonly rtcCausalState: LiveRtcJsonRecord | null;
    readonly rtcDiagnostics: LiveRtcJsonRecord | null;
}

export interface LiveRtcCausalEventsInput {
    readonly events: readonly LiveRtcControlClient.Event[];
    readonly agentReferences: ReadonlyMap<string, string>;
    readonly peerIds: readonly string[];
}

export interface LiveRtcCausalEventProjection {
    readonly coverage: Readonly<{
        runEventCount: number;
        relevantEventCount: number;
        retainedEventCount: number;
        retainedTimeBounds: Readonly<{
            firstAtEpochMs: number | null;
            lastAtEpochMs: number | null;
        }>;
        projectionTruncated: boolean;
        defaultRuntimeTailCapacityReached: boolean;
        upstreamCompleteness: 'unknown';
        runtimeTailLimit: 'unknown';
        eventCoverageThroughHealthCapture: 'unknown';
    }>;
    readonly events: readonly LiveRtcJsonRecord[];
}

const MAX_CAUSAL_EVENTS = 200;
const MAX_CAUSAL_PEERS = 100;
const MAX_CAUSAL_LANES = 100;
const DEFAULT_CONTROL_RUNTIME_EVENT_TAIL_SIZE = 2_000;
const RTC_LIFECYCLE_KINDS = ['peer-created', 'peer-established', 'peer-timeout', 'peer-deleted'];
const RTC_SESSION_STATES = ['Idle', 'Connecting', 'Open', 'Closed', 'Failed'];
const RTC_CONNECTION_STATES = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];
const RTC_ICE_CONNECTION_STATES = ['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'];
const RTC_ICE_GATHERING_STATES = ['new', 'gathering', 'complete'];
const RTC_SIGNALING_STATES = [
    'stable',
    'have-local-offer',
    'have-remote-offer',
    'have-local-pranswer',
    'have-remote-pranswer',
    'closed'
];
const RTC_SIGNAL_KINDS = ['offer', 'answer', 'candidate'];
const RTC_SIGNAL_ADMISSION_STATUSES = [
    'pending-admission',
    'enqueued',
    'accepted',
    'skipped',
    'duplicate',
    'superseded',
    'expired',
    'no-route',
    'rate-limited',
    'circuit-open',
    'failed'
];
const INBOUND_CLAIM_TYPE_BY_PAYLOAD_KIND = new Map<string, 'rtc-signaling' | null>([
    ['admit-message', 'rtc-signaling'],
    ['admit-control', 'rtc-signaling'],
    ['send-control', 'rtc-signaling'],
    ['dispatch-local', null],
    ['forward-message', null]
]);
const INBOUND_CLAIM_PAYLOAD_KINDS = [...INBOUND_CLAIM_TYPE_BY_PAYLOAD_KIND.keys()];
const INBOUND_CLAIM_OUTCOMES = ['completed', 'non-retryable', 'retry', 'not-ready'];
const MANAGER_DIAGNOSTIC_FIELDS = [
    'reconcileRunCount',
    'reconcileAwaitedInFlightCount',
    'reconcileCoalescedRerunCount',
    'lastDesiredPeerCount',
    'connectAttemptCount',
    'connectFailureCount',
    'connectDeferredBudgetCount',
    'connectDeferredPacingCount',
    'disconnectCount',
    'retainedCreatedCount',
    'retainedExpiredCount',
    'retainedEvictionCount'
];
const ATTEMPT_DIAGNOSTIC_FIELDS = [
    'attempts',
    'firstAttemptAtEpochMs',
    'lastAttemptAtEpochMs',
    'maxAttempts',
    'maxTotalDurationMs',
    'cooldownMs',
    'exhaustedAtEpochMs',
    'retryAfterEpochMs'
];
const RTC_SIGNALING_COUNT_FIELDS = [
    'outboundOfferCount',
    'outboundAnswerCount',
    'outboundIceCandidateCount',
    'inboundOfferCount',
    'inboundAnswerCount',
    'inboundIceCandidateCount',
    'outboundSignalingErrorCount',
    'inboundSignalingErrorCount'
];
const RTC_CONNECTION_DIAGNOSTIC_FIELDS = [
    'staleAnswerIgnoredCount',
    'offerCollisionCount',
    'ignoredOfferCollisionCount',
    'politeOfferRollbackCount',
    'queuedIceCandidateCount',
    'addedIceCandidateCount',
    'flushedIceCandidateCount',
    'ignoredIceCandidateForIgnoredOfferCount',
    'outboundSignalingErrorCount',
    'inboundSignalingErrorCount',
    'pendingIceCandidateQueueLength'
];
const INBOUND_DRAIN_DURATION_FIELDS = [
    'durationMs',
    'selectionDurationMs',
    'claimDurationMs',
    'runDurationMs',
    'releaseDurationMs',
    'queueWaitMs'
];
const INBOUND_DRAIN_COUNT_FIELDS = [
    'claimedCount',
    'completedCount',
    'rescheduledCount',
    'rejectedCount'
];

interface ProjectedCausalEvent extends LiveRtcJsonRecord {
    readonly agentId: string;
}

interface SelectedCausalEvent {
    readonly agentReference: string;
    readonly runtimeEvent: LiveRtcJsonRecord;
}

/** Raw IDs exclude '@'; generated aliases use that disjoint namespace and contain no input text. */
export function toCausalAgentReference(agentId: string, ordinal: number): string {
    return toCausalIdentity(agentId) ?? `@causal-agent-${ordinal}`;
}

/** Ordinals count observed opens/creations within this retained tail, never a runtime generation. */
export function toLiveRtcCausalEvents(input: LiveRtcCausalEventsInput): LiveRtcCausalEventProjection {
    const selectedEvents = toSelectedCausalEvents(input);
    const rtcSignalingMessageIds = toRtcSignalingMessageIds(selectedEvents);
    const relevantEvents = selectedEvents.flatMap<ProjectedCausalEvent>(({ agentReference, runtimeEvent }) => {
        const projected = toCausalEvent(runtimeEvent, input.peerIds, rtcSignalingMessageIds);
        return projected ? [{ agentId: agentReference, ...projected }] : [];
    });
    const events = toCausalEventsWithOrdinals(relevantEvents.slice(-MAX_CAUSAL_EVENTS));
    return {
        coverage: toCausalEventCoverage(input.events.length, relevantEvents.length, events),
        events
    };
}

function toSelectedCausalEvents(input: LiveRtcCausalEventsInput): SelectedCausalEvent[] {
    return input.events.flatMap((event) => {
        const agentReference = event.agentId === undefined ? undefined : input.agentReferences.get(event.agentId);
        return agentReference === undefined
            ? []
            : [{ agentReference, runtimeEvent: toLiveRtcRuntimeEvent(event.payload) }];
    });
}

function toRtcSignalingMessageIds(events: readonly SelectedCausalEvent[]): ReadonlySet<string> {
    return new Set(events.flatMap(({ runtimeEvent }) => {
        const data = jsonRecord(jsonRecord(runtimeEvent.payload)?.data) ?? {};
        const messageId = toCausalIdentity(data.msgId);
        return data.typeId === 'rtc-signaling' &&
                (data.kind === 'commit-phases' || data.kind === 'admission-outcome') &&
                messageId
            ? [messageId]
            : [];
    }));
}

function toCausalEventsWithOrdinals(
    retainedEvents: readonly ProjectedCausalEvent[]
): LiveRtcJsonRecord[] {
    const wsGenerations = new Map<string, number>();
    const peerLifetimes = new Map<string, Map<string, number>>();
    return retainedEvents.map((event): LiveRtcJsonRecord => {
        if (event.topic === 'rallar.browser.ws.lifecycle' && event.kind === 'open') {
            wsGenerations.set(event.agentId, (wsGenerations.get(event.agentId) ?? 0) + 1);
        }
        const wsGeneration = wsGenerations.get(event.agentId) ?? null;
        if (event.topic !== 'rallar.browser.rtc.lifecycle' || typeof event.peerId !== 'string') {
            return { ...event, wsGeneration };
        }
        const lifetimes = peerLifetimes.get(event.agentId) ?? new Map<string, number>();
        peerLifetimes.set(event.agentId, lifetimes);
        if (event.kind === 'peer-created') {
            lifetimes.set(event.peerId, (lifetimes.get(event.peerId) ?? 0) + 1);
        }
        return { ...event, wsGeneration, peerLifetime: lifetimes.get(event.peerId) ?? null };
    });
}

function toCausalEventCoverage(
    runEventCount: number,
    relevantEventCount: number,
    events: readonly LiveRtcJsonRecord[]
): LiveRtcCausalEventProjection['coverage'] {
    const retainedTimes = events.flatMap((event) => {
        const atEpochMs = numberValue(event.atEpochMs);
        return atEpochMs !== undefined && atEpochMs >= 0 ? [atEpochMs] : [];
    });
    return {
        runEventCount,
        relevantEventCount,
        retainedEventCount: events.length,
        retainedTimeBounds: {
            firstAtEpochMs: retainedTimes.length > 0 ? Math.min(...retainedTimes) : null,
            lastAtEpochMs: retainedTimes.length > 0 ? Math.max(...retainedTimes) : null
        },
        projectionTruncated: relevantEventCount > events.length,
        defaultRuntimeTailCapacityReached: runEventCount === DEFAULT_CONTROL_RUNTIME_EVENT_TAIL_SIZE,
        upstreamCompleteness: 'unknown',
        runtimeTailLimit: 'unknown',
        eventCoverageThroughHealthCapture: 'unknown'
    };
}

export function toLiveRtcReadinessHealth(
    result: LiveRtcControlClient.Result | undefined,
    peerIds: readonly string[]
): LiveRtcReadinessAgentHealth {
    const rallar = result?.ok ? jsonRecord(jsonRecord(result.result?.value)?.rallar) : null;
    const status = jsonRecord(rallar?.rtcStatus);
    const causalState = jsonRecord(rallar?.rtcCausalState);
    return {
        captureSucceeded: result !== undefined,
        commandOk: result?.ok ?? null,
        failure: result?.ok ? null : 'health-capture-failed',
        localSessionId: toCausalIdentity(causalState?.localSessionId ?? jsonRecord(rallar?.session)?.sessionId),
        readyPeerIds: toCausalPeerIds(status?.readyPeerIds),
        knownPeerIds: toCausalPeerIds(status?.knownPeerIds),
        rtcCausalState: causalState ? toCausalState(causalState) : null,
        rtcDiagnostics: toCausalRtcDiagnostics(jsonRecord(rallar?.rtcDiagnostics), peerIds)
    };
}

export function toCausalPeerIds(value: RtcBaselineJson | undefined): string[] {
    return [...new Set(stringArrayValue(value).filter((peerId) => toCausalIdentity(peerId) !== null))]
        .sort().slice(0, MAX_CAUSAL_PEERS);
}

function toCausalEvent(
    runtimeEvent: LiveRtcJsonRecord,
    peerIds: readonly string[],
    rtcSignalingMessageIds: ReadonlySet<string>
): LiveRtcJsonRecord | null {
    if (runtimeEvent.kind !== 'diagnostic') {
        return null;
    }
    const data = jsonRecord(jsonRecord(runtimeEvent.payload)?.data) ?? {};
    const topic = runtimeEvent.topic;
    const observedAtEpochMs = numberValue(runtimeEvent.atEpochMs);
    const atEpochMs = observedAtEpochMs !== undefined && observedAtEpochMs >= 0 ? observedAtEpochMs : null;
    if (topic === 'rallar.browser.ws.lifecycle' && (data.kind === 'open' || data.kind === 'close')) {
        return { topic, kind: data.kind, atEpochMs };
    }
    if (
        topic === 'rallar.browser.rtc.lifecycle' && typeof data.kind === 'string' &&
        RTC_LIFECYCLE_KINDS.includes(data.kind)
    ) {
        const peerId = toCausalIdentity(data.peerId);
        return peerId && peerIds.includes(peerId) ? { topic, kind: data.kind, atEpochMs, peerId } : null;
    }
    if (topic === 'rallar.browser.rtc.lifecycle' && data.kind === 'signaling-failed') {
        const failure = toCausalSignalingFailure(data, peerIds);
        return failure ? { topic, kind: data.kind, atEpochMs, ...failure } : null;
    }
    const signaling = toCausalSignaling(topic, data);
    if (signaling) {
        return { ...signaling, atEpochMs };
    }
    const inboundWork = toCausalInboundWork(topic, data, rtcSignalingMessageIds);
    return inboundWork ? { ...inboundWork, atEpochMs } : null;
}

function toCausalSignaling(topic: RtcBaselineJson | undefined, data: LiveRtcJsonRecord): LiveRtcJsonRecord | null {
    const msgId = toCausalIdentity(data.msgId);
    if (data.typeId !== 'rtc-signaling' || !msgId) {
        return null;
    }
    if (topic === 'rallar.browser.alm.outbound_diagnostics' && data.kind === 'commit-phases') {
        return {
            topic,
            kind: data.kind,
            typeId: 'rtc-signaling',
            msgId,
            senderId: toCausalIdentity(data.senderId),
            commitOutcome: toAllowedValue(data.commitOutcome, ['committed', 'conflict', 'expired', 'not-attempted']),
            ...toDiagnosticNumbers(data, ['readDurationMs', 'readOperationCount', 'commitDurationMs'])
        };
    }
    if (topic === 'rallar.browser.alm.inbound_diagnostics' && data.kind === 'admission-outcome') {
        return {
            topic,
            kind: data.kind,
            typeId: 'rtc-signaling',
            msgId,
            outcome: toAllowedValue(data.outcome, ['committed', 'not-handled', 'rejected', 'unauthorized', 'pending'])
        };
    }
    return null;
}

function toCausalInboundWork(
    topic: RtcBaselineJson | undefined,
    data: LiveRtcJsonRecord,
    rtcSignalingMessageIds: ReadonlySet<string>
): LiveRtcJsonRecord | null {
    if (topic !== 'rallar.browser.alm.inbound_diagnostics') {
        return null;
    }
    const workerId = toCausalIdentity(data.workerId);
    if (!workerId) {
        return null;
    }
    if (data.kind === 'claim-settled') {
        const msgId = toCausalIdentity(data.msgId);
        const payloadKind = toAllowedValue(data.payloadKind, INBOUND_CLAIM_PAYLOAD_KINDS);
        const expectedTypeId = INBOUND_CLAIM_TYPE_BY_PAYLOAD_KIND.get(String(payloadKind));
        const typeId = data.typeId === expectedTypeId ? expectedTypeId : undefined;
        const outcome = toAllowedValue(data.outcome, INBOUND_CLAIM_OUTCOMES);
        const attempts = toNonnegativeInteger(data.attempts);
        const durations = toRequiredDiagnosticNumbers(data, ['durationMs', 'queueWaitMs']);
        if (
            !msgId || !rtcSignalingMessageIds.has(msgId) || !payloadKind || typeId === undefined || !outcome ||
            attempts === null || !durations
        ) {
            return null;
        }
        return {
            topic,
            kind: data.kind,
            workerId,
            msgId,
            typeId,
            payloadKind,
            outcome,
            attempts,
            ...durations
        };
    }
    if (data.kind !== 'effect-drain') {
        return null;
    }
    const durations = toRequiredDiagnosticNumbers(data, INBOUND_DRAIN_DURATION_FIELDS);
    const counts = toRequiredDiagnosticIntegers(data, INBOUND_DRAIN_COUNT_FIELDS);
    return durations && counts
        ? {
            topic,
            kind: data.kind,
            evidenceScope: 'inbound-worker-batch-aggregate',
            workerId,
            ...durations,
            ...counts
        }
        : null;
}

function toCausalSignalingFailure(
    data: LiveRtcJsonRecord,
    peerIds: readonly string[]
): LiveRtcJsonRecord | null {
    const peerId = toCausalIdentity(data.peerId);
    const signaling = jsonRecord(data.signaling);
    const signalKind = toAllowedValue(signaling?.signalKind, RTC_SIGNAL_KINDS);
    const admission = jsonRecord(signaling?.admission);
    if (!peerId || !peerIds.includes(peerId) || !signalKind || !admission) {
        return null;
    }
    if (admission.outcome === 'never-admitted') {
        return { peerId, signaling: { signalKind, admission: { outcome: 'never-admitted' } } };
    }
    const status = toAllowedValue(admission.status, RTC_SIGNAL_ADMISSION_STATUSES);
    const messageId = toCausalIdentity(admission.messageId);
    return admission.outcome === 'rejected' && status && messageId
        ? { peerId, signaling: { signalKind, admission: { outcome: 'rejected', status, messageId } } }
        : null;
}

function toCausalRtcDiagnostics(
    diagnostics: LiveRtcJsonRecord | null,
    peerIds: readonly string[]
): LiveRtcJsonRecord | null {
    if (!diagnostics) {
        return null;
    }
    const allowedPeerIds = new Set(toCausalPeerIds([...peerIds]));
    const peers = Array.isArray(diagnostics.peers)
        ? diagnostics.peers.flatMap((entry) => {
            const peer = jsonRecord(entry);
            const peerId = toCausalIdentity(peer?.peerId);
            return peer && peerId && allowedPeerIds.has(peerId)
                ? [toCausalRtcPeerDiagnostics(peerId, peer)]
                : [];
        }).slice(0, MAX_CAUSAL_PEERS)
        : [];
    const generatedAtEpochMs = numberValue(diagnostics.generatedAtEpochMs);
    return {
        generatedAtEpochMs: generatedAtEpochMs !== undefined && generatedAtEpochMs >= 0
            ? generatedAtEpochMs
            : null,
        peerLifetimeCoverage: 'unknown',
        peerCounterTimeCoverage: 'unknown',
        peers
    };
}

function toCausalRtcPeerDiagnostics(
    peerId: string,
    peer: LiveRtcJsonRecord
): LiveRtcJsonRecord {
    const connection = jsonRecord(peer.connection) ?? {};
    const signaling = jsonRecord(connection.signaling) ?? {};
    const connectionDiagnostics = jsonRecord(peer.connectionDiagnostics) ?? {};
    const lanes = Array.isArray(peer.lanes)
        ? peer.lanes.flatMap((entry) => {
            const lane = jsonRecord(entry);
            const laneId = toCausalIdentity(lane?.laneId);
            return laneId && typeof lane?.isOpen === 'boolean'
                ? [{ laneId, isOpen: lane.isOpen }]
                : [];
        }).slice(0, MAX_CAUSAL_LANES)
        : [];
    return {
        peerId,
        connection: {
            state: toAllowedValue(connection.state, RTC_SESSION_STATES),
            connectionState: toAllowedValue(connection.connectionState, RTC_CONNECTION_STATES),
            iceConnectionState: toAllowedValue(connection.iceConnectionState, RTC_ICE_CONNECTION_STATES),
            iceGatheringState: toAllowedValue(connection.iceGatheringState, RTC_ICE_GATHERING_STATES),
            signalingState: toAllowedValue(connection.signalingState, RTC_SIGNALING_STATES),
            hasLocalDescription: toBooleanOrNull(connection.hasLocalDescription),
            hasRemoteDescription: toBooleanOrNull(connection.hasRemoteDescription),
            makingOffer: toBooleanOrNull(connection.makingOffer),
            ignoreOffer: toBooleanOrNull(connection.ignoreOffer),
            ...toDiagnosticNumbers(connection, ['iceCandidateQueueSize']),
            signaling: toDiagnosticNumbers(signaling, RTC_SIGNALING_COUNT_FIELDS)
        },
        connectionDiagnostics: toDiagnosticNumbers(
            connectionDiagnostics,
            RTC_CONNECTION_DIAGNOSTIC_FIELDS
        ),
        lanes
    };
}

function toCausalState(state: LiveRtcJsonRecord): LiveRtcJsonRecord {
    const desiredPeerIds = toCausalPeerIds(state.desiredPeerIds);
    const knownPeerIds = toCausalPeerIds(state.knownPeerIds);
    const attempts = Array.isArray(state.attempts) ? state.attempts : [];
    return {
        localSessionId: toCausalIdentity(state.localSessionId),
        desiredPeerIds,
        knownPeerIds,
        onlinePeerIds: toCausalPeerIds(state.onlinePeerIds),
        connectablePeerIds: toCausalPeerIds(state.connectablePeerIds),
        managerDiagnostics: toDiagnosticNumbers(jsonRecord(state.managerDiagnostics) ?? {}, MANAGER_DIAGNOSTIC_FIELDS),
        attempts: toCausalPeerIds([...desiredPeerIds, ...knownPeerIds]).map((peerId) => {
            const entry = attempts.find((attempt) => jsonRecord(attempt)?.peerId === peerId);
            const diagnostics = jsonRecord(jsonRecord(entry)?.diagnostics);
            return {
                peerId,
                diagnostics: diagnostics ? toDiagnosticNumbers(diagnostics, ATTEMPT_DIAGNOSTIC_FIELDS) : null
            };
        })
    };
}

function toDiagnosticNumbers(record: LiveRtcJsonRecord, fields: readonly string[]): LiveRtcJsonRecord {
    return Object.fromEntries(fields.flatMap((field) => {
        const value = numberValue(record[field]);
        return value !== undefined && value >= 0 ? [[field, value]] : [];
    }));
}

function toRequiredDiagnosticNumbers(
    record: LiveRtcJsonRecord,
    fields: readonly string[]
): LiveRtcJsonRecord | null {
    const projected = toDiagnosticNumbers(record, fields);
    return Object.keys(projected).length === fields.length ? projected : null;
}

function toRequiredDiagnosticIntegers(
    record: LiveRtcJsonRecord,
    fields: readonly string[]
): LiveRtcJsonRecord | null {
    const entries = fields.flatMap((field) => {
        const value = toNonnegativeInteger(record[field]);
        return value === null ? [] : [[field, value] as const];
    });
    return entries.length === fields.length ? Object.fromEntries(entries) : null;
}

function toNonnegativeInteger(value: RtcBaselineJson | undefined): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toBooleanOrNull(value: RtcBaselineJson | undefined): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function toCausalIdentity(value: RtcBaselineJson | undefined): string | null {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function toAllowedValue(value: RtcBaselineJson | undefined, allowed: readonly string[]): string | null {
    return typeof value === 'string' && allowed.includes(value) ? value : null;
}
