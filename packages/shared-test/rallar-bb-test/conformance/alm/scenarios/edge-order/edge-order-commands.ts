import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { ASSERT_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceRoomSendAudience } from '../../alm-conformance-receipt-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';

/** What a cell states of one edge-ordered send beyond its number. */
export interface EdgeOrderSendFacts {
    /**
     * The turn in which the receiver hands the send over, stated in the payload where that is not the send's number;
     * absent, the payload states only the number.
     */
    readonly turn?: number;
    /** Absent, the browser's lifetime of 30 s. */
    readonly ttlMs?: number;
    /** Absent, the room. */
    readonly audience?: AlmConformanceRoomSendAudience;
    /** Absent, the send replaces no earlier send and no later send replaces it. */
    readonly supersedenceKey?: string;
}

/** An arrival the receiver did not hand over at once, as its `edge-order-arrival` states it. */
export type EdgeOrderArrivalOutcome = 'held';

/** The positions of a stream the receiver gave up, as its `edge-order-gap` states them. */
export interface EdgeOrderGap {
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly reason: 'ended-at-sender' | 'cannot-arrive';
}

/** An `edge-order-*` event of the cell's type; `absent`, the page states none in the cell. */
type EdgeOrderEvent =
    | { readonly kind: 'edge-order-arrival'; readonly outcome: EdgeOrderArrivalOutcome; readonly absent: boolean; }
    | { readonly kind: 'edge-order-gap'; readonly gap: EdgeOrderGap | undefined; readonly absent: boolean; };

/**
 * One at-least-once, receipted send on the room channel with no ordering key, to the whole room unless
 * `facts.audience` narrows it; its number names it and its payload.
 */
export function toEdgeOrderSendCommands(
    sender: AlmConformanceStepInput,
    seq: number,
    facts: EdgeOrderSendFacts = {}
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: seq,
            payload: {
                marker: sender.scenarioId,
                seq,
                ...(facts.turn === undefined ? {} : { turn: facts.turn })
            },
            delivery: {
                reliability: 'at-least-once',
                ack: 'receiver',
                ...(facts.ttlMs === undefined ? {} : { ttlMs: facts.ttlMs }),
                ...(facts.supersedenceKey === undefined ? {} : { supersedenceKey: facts.supersedenceKey }),
                ...facts.audience
            }
        }),
        ...toAdmissionCommands({ ...sender, index: seq })
    ];
}

/** The page recorded the send numbered `seq` of the cell's type. */
export function toEdgeOrderSendWait(
    receiver: AlmConformanceStepInput,
    name: string,
    seq: number
): RallarBlackBoxTestWaitCommand {
    const wait = toPayloadWait({ step: receiver, name, payload: { marker: receiver.scenarioId, seq }, absent: false });
    return { ...wait, match: { ...wait.match, payloadFields: { 'data.typeId': toScenarioTypeId(receiver) } } };
}

/** The page stated an arrival of the cell's type with `outcome`, at any point of the cell. */
export function toEdgeOrderArrivalWait(
    receiver: AlmConformanceStepInput,
    name: string,
    outcome: EdgeOrderArrivalOutcome
): RallarBlackBoxTestWaitCommand {
    return toEdgeOrderEventWait(receiver, name, { kind: 'edge-order-arrival', outcome, absent: false });
}

/** The page gave up the positions `gap` names of a stream of the cell's type, for its reason. */
export function toEdgeOrderGapWait(
    receiver: AlmConformanceStepInput,
    name: string,
    gap: EdgeOrderGap
): RallarBlackBoxTestWaitCommand {
    return toEdgeOrderEventWait(receiver, name, { kind: 'edge-order-gap', gap, absent: false });
}

/** The page gave up no position of a stream of the cell's type. */
export function toNoOrderGapWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toEdgeOrderEventWait(receiver, 'no-order-gap', { kind: 'edge-order-gap', gap: undefined, absent: true });
}

/** The page held no arrival of the cell's type for its turn, at any point of the cell. */
export function toNoHeldArrivalWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toEdgeOrderEventWait(receiver, 'no-held-arrival', {
        kind: 'edge-order-arrival',
        outcome: 'held',
        absent: true
    });
}

/**
 * The handler was given the arrival `later` after `earlier`: the page records an arrival when its handler runs, and
 * numbers what it records in that order. `later` and `earlier` name the waits `received-<name>`, which
 * `toEdgeOrderSendWait` is given in full.
 */
export function toHandedOverAfterAssertion(
    receiver: AlmConformanceStepInput,
    later: string,
    earlier: string
): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(receiver, `assert-${later}-after-${earlier}`),
        source: toArrivalOrdinal(receiver, later),
        operator: 'gte',
        comparisonSource: toArrivalOrdinal(receiver, earlier),
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
    };
}

/**
 * The page recorded `sends` messages of the cell's type in the order of their `seq`, none of them twice, and gave up no
 * position of their stream.
 */
export function toEdgeOrderedArrivalCommands(
    receiver: AlmConformanceStepInput,
    sends: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: sends, count: sends, absent: false, ascendingBy: 'seq' }),
        toReceivedCommand({ ...receiver, index: sends + 1, count: sends + 1, absent: true }),
        toNoOrderGapWait(receiver)
    ];
}

function toEdgeOrderEventWait(
    receiver: AlmConformanceStepInput,
    name: string,
    event: EdgeOrderEvent
): RallarBlackBoxTestWaitCommand {
    const typeId = toScenarioTypeId(receiver);
    return toDiagnosticWait({
        step: receiver,
        name,
        topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
        payloadFields: event.kind === 'edge-order-arrival'
            ? { 'data.kind': event.kind, 'data.outcome': event.outcome, 'data.typeId': typeId }
            : {
                'data.kind': event.kind,
                'data.typeId': typeId,
                ...(event.gap === undefined ? {} : {
                    'data.fromPosition': event.gap.fromPosition,
                    'data.toPosition': event.gap.toPosition,
                    'data.reason': event.gap.reason
                })
            },
        absent: event.absent,
        historyFrom: 'cell'
    });
}

/** The ordinal the page numbered the arrival the wait `received-<name>` matched with. */
function toArrivalOrdinal(receiver: AlmConformanceStepInput, name: string): string {
    return `resultCache.${toCommandId(receiver, `received-${name}`)}.value.event.history.ordinal`;
}
