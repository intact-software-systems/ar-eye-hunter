import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toScenarioTypeId } from '../../alm-conformance-step-identities.ts';

/** What a cell states of one edge-ordered send beyond its number. */
export interface EdgeOrderSendFacts {
    /**
     * The turn in which the receiver hands the send over, stated in the payload where that is not the send's number;
     * absent, the payload states only the number.
     */
    readonly turn?: number;
    /** Absent, the browser's lifetime of 30 s. */
    readonly ttlMs?: number;
}

/** An arrival the receiver did not hand over at once, as its `edge-order-arrival` states it. */
export type EdgeOrderArrivalOutcome = 'held' | 'late';

/** One whole-room, at-least-once, receipted send with no ordering key; its number names it and its payload. */
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
                ...(facts.ttlMs === undefined ? {} : { ttlMs: facts.ttlMs })
            }
        }),
        ...toAdmissionCommands({ ...sender, index: seq })
    ];
}

/** The page stated an arrival of the cell's type with `outcome`, at any point of the cell. */
export function toEdgeOrderArrivalWait(
    receiver: AlmConformanceStepInput,
    name: string,
    outcome: EdgeOrderArrivalOutcome
): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step: receiver,
        name,
        topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
        payloadFields: {
            'data.kind': 'edge-order-arrival',
            'data.outcome': outcome,
            'data.typeId': toScenarioTypeId(receiver)
        },
        historyFrom: 'cell'
    });
}

/** The page gave up no position of a stream of the cell's type. */
export function toNoOrderGapWait(receiver: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return toDiagnosticWait({
        step: receiver,
        name: 'no-order-gap',
        topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
        payloadFields: { 'data.kind': 'edge-order-gap', 'data.typeId': toScenarioTypeId(receiver) },
        absent: true,
        historyFrom: 'cell'
    });
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
