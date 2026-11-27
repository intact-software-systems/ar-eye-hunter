import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import { STREAM_SENDS, toSequences } from '../fault-streams/ordered-stream.ts';
import { toLossDroppedAssertion, toSeededLossCommand } from '../fault-streams/seeded-loss-stream.ts';
import {
    toEdgeOrderArrivalWait,
    toEdgeOrderedArrivalCommands,
    toEdgeOrderSendCommands
} from './edge-order-commands.ts';

/**
 * An edge-ordered receipted stream keeps every send under the seeded loss of `seeded-loss-stream`: the receiver records
 * all twenty in send order and nothing twice, gives up no position, and every handle ends `acknowledged`. A lost frame
 * comes back with its send's retry, after later sends arrived, so the receiver states that it held one of them: the
 * loss's seed drops the first two frames it meets and passes the third, so send 4 arrives while sends 2 and 3 are lost.
 *
 * Send 1 is sent and acknowledged before the loss is armed, so the receiver has entered the stream at its start: a
 * receiver that first hears a later position starts there once its 500 ms entry window has passed, and would drop the
 * earlier ones as late. The loss is held while the sends are admitted and released after the last one, which must read
 * at least one dropped frame.
 *
 * The cell runs on every carrier. The loss stands on the strategy's first carrier, ws or rtc, as in
 * `seeded-loss-stream`. That cell keeps off `rtc-with-ws-fallback` because a send handed over to WS is gated as a gap
 * on its ordering track; an edge-ordered send rides no track, so a hand-over only changes the hop that carries it, and a
 * copy handed over escapes the loss. Every send is receipted, so a lost frame is retried over `rtc` alone as well,
 * which is what keeps `seeded-loss-unreceipted-stream` on `ws`.
 */
export const edgeOrderLossStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-loss-stream',
    scenarioKey: 'edge-order-loss-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toEdgeOrderLossStreamSenderCommands,
    toRecipientCommands: (receiver) => [
        toEdgeOrderArrivalWait(receiver, 'held-after-lost-send', 'held'),
        ...toEdgeOrderedArrivalCommands(receiver, STREAM_SENDS)
    ]
};

function toEdgeOrderLossStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const lossySends = toSequences(2, STREAM_SENDS);
    return [
        ...toEdgeOrderSendCommands(sender, 1),
        ...toSettledStateCommands({ ...sender, index: 1 }, 'acknowledged'),
        toSeededLossCommand(sender, 'arm'),
        ...lossySends.flatMap((seq) => toEdgeOrderSendCommands(sender, seq)),
        toSeededLossCommand(sender, 'release'),
        toLossDroppedAssertion(sender),
        ...lossySends.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged'))
    ];
}
