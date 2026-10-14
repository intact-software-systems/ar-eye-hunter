import {
    isSameEventHistoryPolicy,
    validateEventHistoryPolicy,
    type RallarBlackBoxEventHistory,
    type RallarBlackBoxEventHistoryPolicy
} from '../../../shared-test/rallar-bb-test/runtime/event-history.ts';

import type { RtcBaselineJson } from '../contracts/rtc-baseline-contracts.ts';

interface RtcB06EventHistoryReading {
    readonly history: Readonly<Record<string, RtcBaselineJson>>;
    readonly counts: Readonly<Record<string, RtcBaselineJson>>;
    readonly identity: Readonly<Record<string, RtcBaselineJson>>;
    readonly start: Readonly<Record<string, RtcBaselineJson>>;
}

const eventKinds = ['event', 'diagnostic', 'message', 'stats', 'report', 'result', 'state'] as const;

/** An immutable local publication receipt; durable journal coverage is verified separately. */
export function toRtcB06EventHistory(value: RtcBaselineJson | undefined): RallarBlackBoxEventHistory | undefined {
    const history = toRecord(value);
    const capture = toRecord(history?.capture);
    const identity = toRecord(capture?.identity);
    const start = toRecord(capture?.start);
    const counts = toRecord(history?.countsByKind);
    if (
        !history || !capture || !identity || !start || !counts ||
        typeof history.runtimeId !== 'string' || history.runtimeId.length === 0 ||
        !['generation', 'totalEvents', 'retainedEvents', 'evictedEvents', 'reconnects'].every((field) =>
            isCount(history[field])
        ) ||
        validateEventHistoryPolicy(history.policy).length > 0 ||
        !eventKinds.every((kind) => isCount(counts[kind])) || Object.keys(counts).length !== eventKinds.length ||
        capture.status !== 'continuous' || typeof identity.runId !== 'string' || identity.runId.length === 0 ||
        typeof identity.agentId !== 'string' || identity.agentId.length === 0 ||
        start.runtimeId !== history.runtimeId || start.generation !== history.generation || !isCount(start.ordinal) ||
        start.ordinal < 1 || start.ordinal > Number(history.totalEvents) + 1
    ) {
        return undefined;
    }
    const receipt = toFrozenRtcB06EventHistory({ history, counts, identity, start });
    return hasRtcB06EventHistoryAccounting(receipt) ? receipt : undefined;
}

function toFrozenRtcB06EventHistory(reading: RtcB06EventHistoryReading): RallarBlackBoxEventHistory {
    const { history, counts, identity, start } = reading;
    return Object.freeze({
        runtimeId: history.runtimeId as string,
        generation: history.generation as number,
        totalEvents: history.totalEvents as number,
        retainedEvents: history.retainedEvents as number,
        evictedEvents: history.evictedEvents as number,
        reconnects: history.reconnects as number,
        evictedThroughEpochMs: history.evictedThroughEpochMs == null
            ? undefined
            : history.evictedThroughEpochMs as number,
        policy: Object.freeze({ ...history.policy as RallarBlackBoxEventHistoryPolicy }),
        countsByKind: Object.freeze({
            event: counts.event as number,
            diagnostic: counts.diagnostic as number,
            message: counts.message as number,
            stats: counts.stats as number,
            report: counts.report as number,
            result: counts.result as number,
            state: counts.state as number
        }),
        capture: Object.freeze({
            status: 'continuous' as const,
            identity: Object.freeze({ runId: identity.runId as string, agentId: identity.agentId as string }),
            start: Object.freeze({
                runtimeId: history.runtimeId as string,
                generation: history.generation as number,
                ordinal: start.ordinal as number
            })
        })
    });
}

function hasRtcB06EventHistoryAccounting(receipt: RallarBlackBoxEventHistory): boolean {
    const retained = receipt.policy.mode === 'full'
        ? receipt.totalEvents
        : Math.min(receipt.totalEvents, receipt.policy.maxEvents);
    return receipt.retainedEvents === retained && receipt.evictedEvents === receipt.totalEvents - retained &&
        eventKinds.reduce((total, kind) => total + receipt.countsByKind[kind], 0) === receipt.totalEvents &&
        receipt.reconnects <= receipt.totalEvents &&
        (receipt.evictedEvents > 0
            ? isCount(receipt.evictedThroughEpochMs)
            : receipt.evictedThroughEpochMs === undefined);
}

export function isRtcB06EventHistoryContinuous(
    previous: RallarBlackBoxEventHistory,
    current: RallarBlackBoxEventHistory
): boolean {
    return previous.runtimeId === current.runtimeId && previous.generation === current.generation &&
        isSameEventHistoryPolicy(previous.policy, current.policy) &&
        previous.capture.status === 'continuous' && current.capture.status === 'continuous' &&
        previous.capture.identity.runId === current.capture.identity.runId &&
        previous.capture.identity.agentId === current.capture.identity.agentId &&
        previous.capture.start.ordinal === current.capture.start.ordinal &&
        current.totalEvents > previous.totalEvents && current.evictedEvents >= previous.evictedEvents &&
        current.reconnects >= previous.reconnects &&
        (previous.evictedThroughEpochMs === undefined ||
            (current.evictedThroughEpochMs ?? -1) >= previous.evictedThroughEpochMs) &&
        eventKinds.every((kind) => current.countsByKind[kind] >= previous.countsByKind[kind]);
}

function toRecord(value: RtcBaselineJson | undefined): Readonly<Record<string, RtcBaselineJson>> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, RtcBaselineJson>>
        : undefined;
}

function isCount(value: RtcBaselineJson | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
