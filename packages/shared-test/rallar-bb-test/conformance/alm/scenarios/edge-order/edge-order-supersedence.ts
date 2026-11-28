import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import {
    toEdgeOrderGapWait,
    toEdgeOrderSendCommands,
    toNoHeldArrivalWait,
    type EdgeOrderSendFacts
} from './edge-order-commands.ts';

/** Sends 2 and 3 share it, so send 3 replaces send 2. */
const KEYED: EdgeOrderSendFacts = { supersedenceKey: 'cursor' };

/** Sends 1, 3 and 4 arrive; send 2 is replaced. */
const ARRIVALS = 3;

/**
 * A latest-wins send on an `order: 'edge'` channel leaves the position of the send it replaces as a hole no receiver
 * waits for. Send 1 is acknowledged, so the receiver enters the stream at its start. Send 2 is held at the sender, and
 * send 3, with the same supersedence key, settles it `superseded` and is acknowledged; send 4 follows the release. Send
 * 2 is a hole to send 3's stamp whether it is still open, as an earlier send of the same key, or already settled
 * `superseded`: the receiver hands send 3 over at once, holds no arrival in the cell, and states position 2 as a gap its
 * sender ended.
 *
 * The superseded send never leaves the page: a superseded copy that arrives after its replacement is dropped by ALM's
 * inbound admission before the sorter, which no hold at the sender can bring about.
 */
export const edgeOrderSupersedence: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-supersedence',
    scenarioKey: 'edge-order-supersedence',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toSupersedenceSenderCommands,
    toRecipientCommands: toSupersedenceReceiverCommands
};

function toSupersedenceSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const replaced = { ...sender, index: 2 };
    return [
        ...toEdgeOrderSendCommands(sender, 1),
        ...toSettledStateCommands({ ...sender, index: 1 }, 'acknowledged'),
        ...toHeldSendCommands(replaced, toEdgeOrderSendCommands(sender, 2, KEYED)),
        ...toEdgeOrderSendCommands(sender, 3, KEYED),
        ...toSettledStateCommands(replaced, 'superseded'),
        ...toSettledStateCommands({ ...sender, index: 3 }, 'acknowledged'),
        ...toHeldMessageFaultCommands(replaced, 'release-message-2', 0),
        ...toEdgeOrderSendCommands(sender, 4),
        ...toSettledStateCommands({ ...sender, index: 4 }, 'acknowledged')
    ];
}

function toSupersedenceReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: ARRIVALS, count: ARRIVALS, absent: false, ascendingBy: 'seq' }),
        toEdgeOrderGapWait(receiver, 'gap-2-2', { fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }),
        toNoHeldArrivalWait(receiver),
        toReceivedCommand({ ...receiver, index: ARRIVALS + 1, count: ARRIVALS + 1, absent: true })
    ];
}
