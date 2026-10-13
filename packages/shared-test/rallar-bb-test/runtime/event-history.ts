import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { ControlClientIdentity } from '../control-protocol.ts';
import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { decodeJsonValue } from './decode-runtime-result-values.ts';

export type RallarBlackBoxEventHistoryPolicy =
    | Readonly<{ mode: 'full'; }>
    | Readonly<{ mode: 'recent'; maxEvents: number; }>;

/** Local publication continuity; a complete value still requires independent durable journal verification. */
export type RallarBlackBoxEventCapture =
    | Readonly<{ status: 'unattached'; }>
    | Readonly<{ status: 'continuous'; identity: ControlClientIdentity; start: RallarBlackBoxEventHistorySequence; }>
    | Readonly<
        { status: 'gap'; identity: ControlClientIdentity; start: RallarBlackBoxEventHistorySequence; reason: string; }
    >;

export interface RallarBlackBoxEventHistorySequence {
    readonly runtimeId: string;
    readonly generation: number;
    readonly ordinal: number;
}

export interface RallarBlackBoxEventHistory {
    readonly runtimeId: string;
    readonly policy: RallarBlackBoxEventHistoryPolicy;
    readonly generation: number;
    readonly totalEvents: number;
    readonly retainedEvents: number;
    readonly evictedEvents: number;
    /** Absent until eviction; a time cursor must be strictly later to prove complete coverage. */
    readonly evictedThroughEpochMs: number | undefined;
    readonly countsByKind: Readonly<Record<RallarBlackBoxTestEventKind, number>>;
    readonly reconnects: number;
    readonly capture: RallarBlackBoxEventCapture;
}

export interface RallarBlackBoxTestConnectionFacts {
    readonly connected: boolean;
    readonly peerCount: number | undefined;
    readonly laneHealth: ApiJsonValue | undefined;
}

export const RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE = 'RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE';

export function createEventHistory(
    policy: RallarBlackBoxEventHistoryPolicy,
    lifecycle: Readonly<{ runtimeId: string; generation: number; }>,
    capture: RallarBlackBoxEventCapture
): RallarBlackBoxEventHistory {
    if (validateEventHistoryPolicy(policy).length > 0) {
        throw new TypeError('Event history requires full mode or a positive finite integer recent-event limit.');
    }
    return {
        policy: Object.freeze({ ...policy }),
        ...lifecycle,
        totalEvents: 0,
        retainedEvents: 0,
        evictedEvents: 0,
        evictedThroughEpochMs: undefined,
        countsByKind: { event: 0, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
        reconnects: 0,
        capture
    };
}

export function computeAppendedEventHistory(
    state: RallarBlackBoxTestState,
    event: RallarBlackBoxTestEvent
): Pick<RallarBlackBoxTestState, 'events' | 'eventHistory' | 'connection'> {
    return {
        ...computeRetainedEventHistory(
            computeCountedEventHistory(state.eventHistory, event),
            [...state.events, event],
            state.eventHistory.policy
        ),
        connection: computeConnectionFacts(state.connection, event)
    };
}

export function computeCountedEventHistory(
    history: RallarBlackBoxEventHistory,
    event: RallarBlackBoxTestEvent
): RallarBlackBoxEventHistory {
    return {
        ...history,
        totalEvents: history.totalEvents + 1,
        countsByKind: { ...history.countsByKind, [event.kind]: history.countsByKind[event.kind] + 1 },
        reconnects: history.reconnects + Number(event.topic.toLowerCase().includes('reconnect'))
    };
}

export function computeRetainedEventHistory(
    history: RallarBlackBoxEventHistory,
    all: readonly RallarBlackBoxTestEvent[],
    policy: RallarBlackBoxEventHistoryPolicy
): Pick<RallarBlackBoxTestState, 'events' | 'eventHistory'> {
    const events = policy.mode === 'full' ? all : all.slice(-policy.maxEvents);
    const evicted = all.slice(0, all.length - events.length);
    return {
        events,
        eventHistory: {
            ...history,
            policy: Object.freeze({ ...policy }),
            retainedEvents: events.length,
            evictedEvents: history.evictedEvents + evicted.length,
            evictedThroughEpochMs: evicted.reduce(
                (latest, row) => Math.max(latest ?? row.atEpochMs, row.atEpochMs),
                history.evictedThroughEpochMs
            )
        }
    };
}

export function validateEventHistoryPolicy(policy: unknown): readonly string[] {
    if (typeof policy !== 'object' || policy === null || !('mode' in policy)) {
        return ['Event history requires full or recent mode.'];
    }
    if (policy.mode === 'full' && Object.keys(policy).every((key) => key === 'mode')) {
        return [];
    }
    return policy.mode === 'recent' && 'maxEvents' in policy && typeof policy.maxEvents === 'number' &&
            Number.isSafeInteger(policy.maxEvents) && policy.maxEvents > 0 &&
            Object.keys(policy).every((key) => key === 'mode' || key === 'maxEvents')
        ? []
        : ['Recent event history requires a positive finite integer maxEvents.'];
}

export function resolveEventHistoryPolicyFailure(
    command: RallarBlackBoxTestState['activeCommand'],
    history: RallarBlackBoxEventHistory,
    activeTopLevelCount: number
): RallarBlackBoxTestCommandOutcome | undefined {
    const policy = command?.kind === 'configure' ? command.config.eventHistory : undefined;
    if (policy === undefined) {
        return undefined;
    }
    const issues = validateEventHistoryPolicy(policy);
    if (issues.length > 0) {
        return {
            status: 'failed',
            nextStatus: 'failed',
            error: {
                code: 'RALLAR_BLACK_BOX_HISTORY_POLICY_INVALID',
                message: issues.join('; ')
            }
        };
    }
    const changed = policy.mode !== history.policy.mode ||
        (policy.mode === 'recent' && history.policy.mode === 'recent' && policy.maxEvents !== history.policy.maxEvents);
    if (!changed || activeTopLevelCount === 0) {
        return undefined;
    }
    return {
        status: 'failed',
        nextStatus: 'failed',
        error: {
            code: 'RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE',
            message: 'Event history policy cannot change while another operation is active.'
        }
    };
}

export function isEventHistoryCovered(history: RallarBlackBoxEventHistory, sinceEpochMs: number | undefined): boolean {
    return history.evictedThroughEpochMs === undefined ||
        (sinceEpochMs !== undefined && sinceEpochMs > history.evictedThroughEpochMs);
}

export function toEventHistoryUnavailableOutcome(
    history: RallarBlackBoxEventHistory
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        error: {
            code: RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE,
            message: 'The requested event history extends outside the retained window.',
            details: { eventHistory: history }
        },
        nextStatus: 'failed'
    };
}

function computeConnectionFacts(
    connection: RallarBlackBoxTestConnectionFacts,
    event: RallarBlackBoxTestEvent
): RallarBlackBoxTestConnectionFacts {
    if (event.topic === 'rallar.bb.closed' || event.topic === 'rallar.bb.cleanup.resources_closed') {
        return { connected: false, peerCount: undefined, laneHealth: undefined };
    }
    if (event.topic.includes('rtc.connected') || event.topic.includes('rallar.browser.connect_completed')) {
        const payload = event.payload;
        const peerCount = typeof payload === 'object' && payload !== null && 'peerCount' in payload &&
                typeof payload.peerCount === 'number'
            ? payload.peerCount
            : undefined;
        const laneHealth = typeof payload === 'object' && payload !== null && 'laneHealth' in payload
            ? decodeJsonValue(payload.laneHealth)
            : undefined;
        return { connected: true, peerCount, laneHealth };
    }
    return connection;
}
