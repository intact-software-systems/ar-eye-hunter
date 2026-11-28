import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { STREAM_SENDS, toSequences } from '../fault-streams/ordered-stream.ts';
import { toLossDroppedAssertion, toSeededLossCommand } from '../fault-streams/seeded-loss-stream.ts';
import { toEdgeOrderGapWait, toEdgeOrderSendWait } from './edge-order-commands.ts';

/**
 * The runs of sends the seeded loss of `seeded-loss-stream` takes over `ws`. A lost frame is gone there, so each send
 * is one frame and one draw, and the seed fixes which of sends 2 to 19 are lost, whatever the timing of a run. Sends 1
 * and 20 leave outside the loss.
 */
const WS_LOST_SEND_RUNS: ReadonlyArray<readonly [from: number, to: number]> = [[2, 3], [9, 9], [13, 13], [16, 16]];

const WS_ARRIVING_SENDS = STREAM_SENDS - WS_LOST_SEND_RUNS.reduce((lost, [from, to]) => lost + to - from + 1, 0);

/** Sends 1 and 20 leave outside the loss, so they arrive whatever the loss takes. */
const SENDS_OUTSIDE_THE_LOSS = 2;

/**
 * An edge-ordered stream of sends nothing retries, under the seeded loss of `seeded-loss-stream`: newest wins. The
 * receiver never waits for a lost send and hands what arrives over in send order. Send 1 leaves before the loss is
 * armed and send 20 after it is released, so the receiver enters the stream at its start and the last send always
 * arrives and closes the stream's last gap. The release must read at least one dropped frame.
 *
 * The cell runs on every carrier, with the loss on the strategy's first carrier: no receipt notices a lost frame, so
 * `rtc-with-ws-fallback` hands nothing over to the socket.
 *
 * Over `ws` a lost frame is gone, so the lost sends are the seed's: the receiver records exactly the fifteen that
 * arrive and states each of the four lost runs as a gap, so what it was handed and what it gave up add up to the
 * stream.
 *
 * Over the RTC carriers the page submits a dropped frame again (`AL_SUBMISSION_NOT_READY_RETRY_MS` later), and every
 * attempt is a draw. Which sends are lost, and whether a frame taken up again arrives after later sends (and is dropped
 * as late) or before them, then depends on how fast the sends follow each other, so the cell claims there only what
 * holds at any pace: everything the receiver was handed is in send order, none twice.
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
 * The last send arrived, so everything before it has arrived or was given up. The count is read after it, and judges
 * every copy the page recorded.
 */
function toNewestWinsReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toEdgeOrderSendWait(receiver, 'received-last-send', STREAM_SENDS),
        ...(receiver.input.carrier === 'ws' ? toSeedLostSendCommands(receiver) : [
            toReceivedCommand({
                ...receiver,
                index: SENDS_OUTSIDE_THE_LOSS,
                count: SENDS_OUTSIDE_THE_LOSS,
                absent: false,
                ascendingBy: 'seq'
            })
        ])
    ];
}

/**
 * The page recorded exactly the sends the seed let through, in send order and none twice, and stated each lost run as
 * a gap its sender told it not to wait for.
 */
function toSeedLostSendCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({
            ...receiver,
            index: WS_ARRIVING_SENDS,
            count: WS_ARRIVING_SENDS,
            absent: false,
            ascendingBy: 'seq'
        }),
        toReceivedCommand({ ...receiver, index: WS_ARRIVING_SENDS + 1, count: WS_ARRIVING_SENDS + 1, absent: true }),
        ...WS_LOST_SEND_RUNS.map(([from, to]) =>
            toEdgeOrderGapWait(receiver, `gap-${from}-${to}`, {
                fromPosition: from,
                toPosition: to,
                reason: 'ended-at-sender'
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
