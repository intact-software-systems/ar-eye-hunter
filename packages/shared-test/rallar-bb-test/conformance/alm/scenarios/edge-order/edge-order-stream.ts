import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestTransportFaultInjectCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { FAULT_TIMEOUT_MS, toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toSentCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';

/** The sends of an edge-ordered stream cell: enough for one swap and a run on either side of it. */
export const EDGE_ORDER_STREAM_SENDS = 8;

/** The send the cell holds, and the later one that leaves the page first. */
const HELD_SEND = 2;
const OVERTAKING_SEND = 3;

/** An RTC channel applies no delay, so a jitter has one carrier. */
const JITTER_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];
const JITTER = { jitter: { minDelayMs: 0, maxDelayMs: 80, seed: 11 } } as const;

/**
 * A room channel both pages declare `order: 'edge'` hands one sender's sends over in the order it called `send`, though
 * no hop orders them. The sends carry no ordering key, so the server and a relay treat them as unordered. Send 2 is
 * held at the sender until every recipient has acknowledged send 3, so send 3 arrives first and the receiver states
 * that it holds it: the receiver then records all eight in send order, nothing twice, and states no gap, and every
 * handle ends `acknowledged`.
 */
export const edgeOrderStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-stream',
    scenarioKey: 'edge-order-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toSwappedEdgeOrderSendCommands,
    toRecipientCommands: toEdgeOrderStreamReceiverCommands
};

/**
 * The same stream when every data frame also leaves after a seeded delay of 0 to 80 ms: the order the receiver records
 * is still the sender's, and the release proves that every send met a delay.
 */
export const edgeOrderJitterStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-jitter-stream',
    scenarioKey: 'edge-order-jitter-stream',
    tags: FULL_TAGS,
    carriers: JITTER_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: (sender) => [
        toJitterCommand(sender, 'arm'),
        ...toSwappedEdgeOrderSendCommands(sender),
        toJitterCommand(sender, 'release'),
        toResultAssertion({
            step: sender,
            name: 'assert-jitter-delayed',
            resultName: 'jitter-release',
            field: 'acted.delay',
            operator: 'gte',
            expected: EDGE_ORDER_STREAM_SENDS
        })
    ],
    toRecipientCommands: toEdgeOrderStreamReceiverCommands
};

/** One whole-room, at-least-once, receipted send with no ordering key; its number names it and its payload. */
function toEdgeOrderSendCommands(sender: AlmConformanceStepInput, seq: number): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: seq,
            payload: { marker: sender.scenarioId, seq },
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: seq })
    ];
}

/**
 * The stream's sends, of which send 2 leaves the page after send 3 reached every recipient. The hold arms once send 1
 * has left, so it meets send 2 alone, and keeps it by its message id until send 3 is acknowledged: a recipient
 * acknowledges at admission, before its sorter, so send 3 is then held at the receiver. Every send ends acknowledged.
 */
function toSwappedEdgeOrderSendCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: HELD_SEND };
    return [
        ...toEdgeOrderSendCommands(sender, 1),
        ...toSentCommands({ ...sender, index: 1 }),
        ...toHeldSendCommands(held, toEdgeOrderSendCommands(sender, HELD_SEND)),
        ...toEdgeOrderSendCommands(sender, OVERTAKING_SEND),
        ...toSettledStateCommands({ ...sender, index: OVERTAKING_SEND }, 'acknowledged'),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_SEND}`, 0),
        ...toSendNumbers(OVERTAKING_SEND + 1).flatMap((seq) => toEdgeOrderSendCommands(sender, seq)),
        ...toSendNumbers(1)
            .filter((seq) => seq !== OVERTAKING_SEND)
            .flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged'))
    ];
}

/**
 * Send 3 arrived before send 2 and was held for its turn; every send then arrives in send order, nothing arrives
 * twice, and the page gave up no position of the stream.
 */
function toEdgeOrderStreamReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toDiagnosticWait({
            step: receiver,
            name: 'held-overtaking-send',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: {
                'data.kind': 'edge-order-arrival',
                'data.outcome': 'held',
                'data.typeId': toScenarioTypeId(receiver)
            },
            historyFrom: 'cell'
        }),
        toReceivedCommand({
            ...receiver,
            index: EDGE_ORDER_STREAM_SENDS,
            count: EDGE_ORDER_STREAM_SENDS,
            absent: false,
            ascendingBy: 'seq'
        }),
        toReceivedCommand({
            ...receiver,
            index: EDGE_ORDER_STREAM_SENDS + 1,
            count: EDGE_ORDER_STREAM_SENDS + 1,
            absent: true
        }),
        toDiagnosticWait({
            step: receiver,
            name: 'no-order-gap',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            payloadFields: { 'data.kind': 'edge-order-gap' },
            absent: true,
            historyFrom: 'cell'
        })
    ];
}

function toSendNumbers(from: number): readonly number[] {
    return Array.from({ length: EDGE_ORDER_STREAM_SENDS - from + 1 }, (_, offset) => from + offset);
}

/** Held on the data frames of the cell's type until its release. A control frame carries another type and passes. */
function toJitterCommand(
    sender: AlmConformanceStepInput,
    phase: 'arm' | 'release'
): RallarBlackBoxTestTransportFaultInjectCommand {
    const typeId = toScenarioTypeId(sender);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(sender, `jitter-${phase}`),
        faultId: `jitter-ws-${typeId}`,
        carrier: 'ws',
        match: { typeId },
        action: JITTER,
        remaining: phase === 'arm' ? 'until-cleared' : 0,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, sender.input.deadlineMs)
    };
}
