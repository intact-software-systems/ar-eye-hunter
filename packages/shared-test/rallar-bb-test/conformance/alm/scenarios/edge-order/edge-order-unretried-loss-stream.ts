import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { ALM_INBOUND_DIAGNOSTICS_TOPIC, toDiagnosticWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { STREAM_SENDS, toSequences } from '../fault-streams/ordered-stream.ts';
import { toLossDroppedAssertion, toSeededLossCommand } from '../fault-streams/seeded-loss-stream.ts';
import { toEdgeOrderArrivalWait } from './edge-order-commands.ts';

/**
 * The runs of sends the seeded loss of `seeded-loss-stream` takes: each send nothing retries is one frame and one
 * draw, so the seed fixes which of sends 2 to 19 are lost, whatever the carrier or the timing of a run. Sends 1 and
 * 20 leave outside the loss.
 */
const LOST_SEND_RUNS: ReadonlyArray<readonly [from: number, to: number]> = [[2, 3], [9, 9], [13, 13], [16, 16]];

const ARRIVING_SENDS = STREAM_SENDS - LOST_SEND_RUNS.reduce((lost, [from, to]) => lost + to - from + 1, 0);

/**
 * An edge-ordered stream of sends nothing retries, under the seeded loss of `seeded-loss-stream`: newest wins. The
 * receiver never waits for a lost send, hands the fifteen sends that arrive over in send order, and states each of the
 * four runs of lost positions as a gap, so what it was handed and what it gave up add up to the stream. Send 1 leaves before the loss is armed and send 20 after it is released, so the receiver enters
 * the stream at its start and the last send always arrives and closes the stream's last gap. The release must read at
 * least one dropped frame.
 *
 * The cell runs on every carrier, with the loss on the strategy's first carrier: no receipt notices a lost frame, so
 * `rtc-with-ws-fallback` hands nothing over and loses the same sends as `rtc`. Over `ws` a lost frame is gone. Over
 * the RTC carriers the page's own transport takes the frame up again once the loss is released, so it reaches the
 * receiver after later sends, and the receiver states that it dropped it as late.
 */
export const edgeOrderUnretriedLossStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-unretried-loss-stream',
    scenarioKey: 'edge-order-unretried-loss-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toUnretriedLossStreamSenderCommands,
    toRecipientCommands: toNewestWinsReceiverCommands
};

function toUnretriedLossStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toUnretriedSendCommands(sender, 1),
        toSeededLossCommand(sender, 'arm'),
        ...toSequences(2, STREAM_SENDS - 1).flatMap((seq) => toUnretriedSendCommands(sender, seq)),
        toSeededLossCommand(sender, 'release'),
        toLossDroppedAssertion(sender),
        ...toUnretriedSendCommands(sender, STREAM_SENDS)
    ];
}

/**
 * The last send arrived, so everything before it has arrived or was given up. The page recorded exactly the sends the
 * loss let through, in send order and none twice, and stated each lost run as a gap its sender told it not to wait
 * for.
 */
function toNewestWinsReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const lastSend = toPayloadWait({
        step: receiver,
        name: 'received-last-send',
        payload: { marker: receiver.scenarioId, seq: STREAM_SENDS },
        absent: false
    });
    return [
        { ...lastSend, match: { ...lastSend.match, payloadFields: { 'data.typeId': toScenarioTypeId(receiver) } } },
        toReceivedCommand({
            ...receiver,
            index: ARRIVING_SENDS,
            count: ARRIVING_SENDS,
            absent: false,
            ascendingBy: 'seq'
        }),
        toReceivedCommand({ ...receiver, index: ARRIVING_SENDS + 1, count: ARRIVING_SENDS + 1, absent: true }),
        ...(receiver.input.carrier === 'ws' ? [] : [toEdgeOrderArrivalWait(receiver, 'late-lost-send', 'late')]),
        ...LOST_SEND_RUNS.map(([from, to]) =>
            toDiagnosticWait({
                step: receiver,
                name: `gap-${from}-${to}`,
                topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
                payloadFields: {
                    'data.kind': 'edge-order-gap',
                    'data.typeId': toScenarioTypeId(receiver),
                    'data.fromPosition': from,
                    'data.toPosition': to,
                    'data.reason': 'ended-at-sender'
                },
                historyFrom: 'cell'
            })
        )
    ];
}

/** One whole-room, best-effort send that asks no receipt; its number names it and its payload. */
function toUnretriedSendCommands(sender: AlmConformanceStepInput, seq: number): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: seq,
            payload: { marker: sender.scenarioId, seq },
            delivery: { reliability: 'best-effort', ack: 'none' }
        }),
        ...toAdmissionCommands({ ...sender, index: seq })
    ];
}
