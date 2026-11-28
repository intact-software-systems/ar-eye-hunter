import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSettledStateCommands } from '../../to-settled-state-commands.ts';
import {
    toEdgeOrderArrivalWait,
    toEdgeOrderSendCommands,
    toEdgeOrderSendWait,
    toHandedOverAfterAssertion,
    toNoOrderGapWait,
    type EdgeOrderSendFacts
} from './edge-order-commands.ts';

/** The room send the cell holds, and the room send that overtakes it. */
const HELD_SEND = 4;
const OVERTAKING_SEND = 5;

/** Every arrival a recipient is handed: three room sends and the two of its narrowed audience. */
const ARRIVALS = 5;

const LIST: EdgeOrderSendFacts = { audience: { recipientPeers: ['receiver'] } };
const PRINCIPAL: EdgeOrderSendFacts = { audience: { scope: 'principal', principalId: '{auth.clientId}' } };

/** Sends 2 and 6 list the receiver alone; sends 3 and 7 go to the sender's principal, its sibling. */
const FACTS_BY_SEQ: ReadonlyMap<number, EdgeOrderSendFacts> = new Map([
    [2, LIST],
    [3, PRINCIPAL],
    [6, LIST],
    [7, PRINCIPAL]
]);

/**
 * One sender's sends on an `order: 'edge'` channel to three audiences: the room, a fixed list of the receiver alone,
 * and the sender's own principal, its sibling. Each audience is a stream of its own, numbered from 1. Room send 4 is
 * held at the sender while room send 5 and the narrowed sends 6 and 7 are acknowledged, so each recipient holds send 5
 * for its turn and hands its narrowed send over meanwhile: one stream does not wait for another. Each recipient is
 * handed both of its streams in send order, five arrivals in all, and states no gap: the stream it is outside leaves
 * no hole in the room's. The order is judged pairwise, since nothing orders two streams against each other.
 */
export const edgeOrderAudiences: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-audiences',
    scenarioKey: 'edge-order-audiences',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    order: 'edge',
    toSenderCommands: toAudienceStreamSenderCommands,
    toRecipientCommands: toAudienceStreamRecipientCommands
};

function toAudienceStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: HELD_SEND };
    return [
        ...[1, 2, 3].flatMap((seq) => toAudienceSendCommands(sender, seq)),
        ...[1, 2, 3].flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        ...toHeldSendCommands(held, toAudienceSendCommands(sender, HELD_SEND)),
        ...[OVERTAKING_SEND, 6, 7].flatMap((seq) => [
            ...toAudienceSendCommands(sender, seq),
            ...toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')
        ]),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_SEND}`, 0),
        ...toSettledStateCommands(held, 'acknowledged')
    ];
}

function toAudienceSendCommands(sender: AlmConformanceStepInput, seq: number): readonly RallarBlackBoxTestCommand[] {
    return toEdgeOrderSendCommands(sender, seq, FACTS_BY_SEQ.get(seq));
}

/** The receiver is handed sends 2 and 6 of the fixed list, the sibling sends 3 and 7 of the principal. */
function toAudienceStreamRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const [first, second] = recipient.role === 'receiver' ? [2, 6] : [3, 7];
    const handedOver: ReadonlyArray<readonly [later: number, earlier: number]> = [
        [HELD_SEND, 1],
        [OVERTAKING_SEND, HELD_SEND],
        [second, first],
        [OVERTAKING_SEND, second]
    ];
    return [
        toEdgeOrderArrivalWait(recipient, 'held-overtaking-send', 'held'),
        ...[1, HELD_SEND, OVERTAKING_SEND, first, second].map((seq) =>
            toEdgeOrderSendWait(recipient, `received-seq-${seq}`, seq)
        ),
        ...handedOver.map(([later, earlier]) =>
            toHandedOverAfterAssertion(recipient, `seq-${later}`, `seq-${earlier}`)
        ),
        toReceivedCommand({ ...recipient, index: ARRIVALS, count: ARRIVALS, absent: false }),
        toReceivedCommand({ ...recipient, index: ARRIVALS + 1, count: ARRIVALS + 1, absent: true }),
        toNoOrderGapWait(recipient)
    ];
}
