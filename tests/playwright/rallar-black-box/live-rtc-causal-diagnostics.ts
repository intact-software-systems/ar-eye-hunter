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
}

export interface LiveRtcCausalEventsInput {
    readonly events: readonly LiveRtcControlClient.Event[];
    readonly agentIds: readonly string[];
    readonly peerIds: readonly string[];
}

const MAX_CAUSAL_EVENTS = 200;
const MAX_CAUSAL_PEERS = 100;
const RTC_LIFECYCLE_KINDS = ['peer-created', 'peer-established', 'peer-timeout', 'peer-deleted'];
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

interface LiveRtcCausalEventProjection extends LiveRtcJsonRecord {
    readonly agentId: string;
}

/** Ordinals count observed opens/creations within this retained tail, never a runtime generation. */
export function toLiveRtcCausalEvents(input: LiveRtcCausalEventsInput): readonly LiveRtcJsonRecord[] {
    const relevant = input.events.flatMap<LiveRtcCausalEventProjection>((event) => {
        if (!event.agentId || !input.agentIds.includes(event.agentId)) {
            return [];
        }
        const runtimeEvent = toLiveRtcRuntimeEvent(event.payload);
        const projected = toCausalEvent(runtimeEvent, input.peerIds);
        return projected ? [{ agentId: event.agentId, ...projected }] : [];
    }).slice(-MAX_CAUSAL_EVENTS);
    const wsGenerations = new Map<string, number>();
    const peerLifetimes = new Map<string, Map<string, number>>();
    return relevant.map((event): LiveRtcJsonRecord => {
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

export function toLiveRtcReadinessHealth(
    result: LiveRtcControlClient.Result | undefined
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
        rtcCausalState: causalState ? toCausalState(causalState) : null
    };
}

export function toCausalPeerIds(value: RtcBaselineJson | undefined): string[] {
    return [...new Set(stringArrayValue(value).filter((peerId) => toCausalIdentity(peerId) !== null))]
        .sort().slice(0, MAX_CAUSAL_PEERS);
}

function toCausalEvent(
    runtimeEvent: LiveRtcJsonRecord,
    peerIds: readonly string[]
): LiveRtcJsonRecord | null {
    if (runtimeEvent.kind !== 'diagnostic') {
        return null;
    }
    const data = jsonRecord(runtimeEvent.data) ?? {};
    const topic = runtimeEvent.topic;
    const atEpochMs = numberValue(runtimeEvent.atEpochMs) ?? null;
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
    const signaling = toCausalSignaling(topic, data);
    return signaling ? { ...signaling, atEpochMs } : null;
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

function toCausalIdentity(value: RtcBaselineJson | undefined): string | null {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function toAllowedValue(value: RtcBaselineJson | undefined, allowed: readonly string[]): string | null {
    return typeof value === 'string' && allowed.includes(value) ? value : null;
}
