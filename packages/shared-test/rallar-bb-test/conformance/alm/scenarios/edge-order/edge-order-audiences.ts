import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES, type AlmConformanceRole } from '../../alm-conformance-roles.ts';
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

/** A narrowed audience one recipient is inside and the other outside, and the two sends to it. */
interface NarrowedStream {
    readonly facts: EdgeOrderSendFacts;
    readonly sends: readonly [first: number, second: number];
}

/** The recipient roles of the cell: each is inside one narrowed stream. */
type NarrowedStreamRole = 'receiver' | 'sibling';

/** The fixed list names the receiver alone; the sender's principal reaches its other session, the sibling, alone. */
const NARROWED_STREAMS: Readonly<Record<NarrowedStreamRole, NarrowedStream>> = {
    receiver: { facts: { audience: { recipientPeers: ['receiver'] } }, sends: [2, 6] },
    sibling: { facts: { audience: { scope: 'principal', principalId: '{auth.clientId}' } }, sends: [3, 7] }
};

const NARROWED_STREAM_LIST: readonly NarrowedStream[] = Object.values(NARROWED_STREAMS);

/**
 * One sender's sends on an `order: 'edge'` channel to three audiences: the room, a fixed list of the receiver alone,
 * and the sender's own principal, its sibling. Each audience is a stream of its own, numbered from 1. Room send 4 is
 * held at the sender while room send 5 and the narrowed sends 6 and 7 are acknowledged, so each recipient holds send 5
 * for its turn and hands its narrowed send over meanwhile: one stream does not wait for another. Each recipient is
 * handed both of its streams in send order, five arrivals in all, and states no gap: the stream it is outside leaves
 * no hole in the room's. The order is judged pairwise, since nothing orders two streams against each other. A peer
 * (`toPeer`) or `exceptPeerIds` audience is left to the unit tests, because the lane cannot address one.
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
    const beforeHold = [1, ...NARROWED_STREAM_LIST.map((stream) => stream.sends[0])];
    const whileHeld = [OVERTAKING_SEND, ...NARROWED_STREAM_LIST.map((stream) => stream.sends[1])];
    return [
        ...beforeHold.flatMap((seq) => toAudienceSendCommands(sender, seq)),
        ...beforeHold.flatMap((seq) => toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')),
        ...toHeldSendCommands(held, toAudienceSendCommands(sender, HELD_SEND)),
        ...whileHeld.flatMap((seq) => [
            ...toAudienceSendCommands(sender, seq),
            ...toSettledStateCommands({ ...sender, index: seq }, 'acknowledged')
        ]),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_SEND}`, 0),
        ...toSettledStateCommands(held, 'acknowledged')
    ];
}

/** A send to no narrowed stream goes to the room. */
function toAudienceSendCommands(sender: AlmConformanceStepInput, seq: number): readonly RallarBlackBoxTestCommand[] {
    const stream = NARROWED_STREAM_LIST.find((candidate) => candidate.sends.includes(seq));
    return toEdgeOrderSendCommands(sender, seq, stream?.facts);
}

/** Each recipient is handed the room's stream and the narrowed stream it is inside. */
function toAudienceStreamRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const { role } = recipient;
    assertNarrowedStreamRole(role);
    const [first, second] = NARROWED_STREAMS[role].sends;
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

/** The cell declares the sender and the two recipient roles, so a recipient's recipe is never written for another role. */
function assertNarrowedStreamRole(role: AlmConformanceRole): asserts role is NarrowedStreamRole {
    if (!Object.hasOwn(NARROWED_STREAMS, role)) {
        throw new Error(`edge-order-audiences has no narrowed stream for the ${role} role.`);
    }
}
