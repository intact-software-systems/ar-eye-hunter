import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    PUBLICATION_CADENCE_MS,
    PUBLICATION_DRAIN_BYTES,
    toPublicationLeadCommands,
    toPublicationSendCommand,
    toPublicationVerdictCommands
} from '../publication/publication-commands.ts';
import {
    toArrivalCountCommand,
    toNoFurtherArrivalCommand,
    toSeqArrivalWait
} from '../publication/publication-receiver-commands.ts';
import { toEdgeOrderGapWait } from './edge-order-commands.ts';

/** Two values retained, so the stage displaces neither the held value nor the one staged after it. */
const LIVE_STREAM_PUBLICATION: ALPublicationPolicy = {
    cadenceMs: PUBLICATION_CADENCE_MS,
    retainNewest: 2,
    drain: { messages: 8, bytes: PUBLICATION_DRAIN_BYTES }
};
const HELD_VALUE = 1;
const OVERTAKING_VALUE = 2;

/**
 * A `live` publication stream on an `order: 'edge'` channel is newest-wins: a value that left the stage and did not
 * arrive is a hole no receiver waits for, and nothing is handed over out of order. Value 0 leads on the idle lane and
 * takes position 1. Value 1 is held at the sender by its message id and value 2 is staged after it. A value takes its
 * position when an opportunity selects it, and the stage, which retains both, selects them in the order they were
 * staged: whether one opportunity selects both or two do, value 1 takes position 2 and stays unsent, value 2 takes
 * position 3 and its admission settles value 1 `superseded`, so the receiver is handed 0 then 2 and states position 2
 * as a gap its sender ended.
 *
 * The cell claims no late drop: ALM's own latest-wins drops the older value before the edge sorter sees it, at the
 * sender's admission or at the receiver's inbound admission, so `lateDrops` does not move and no `late` arrival is
 * stated.
 */
export const edgeOrderLiveStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'edge-order-live-stream',
    scenarioKey: 'edge-order-live-stream',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    order: 'edge',
    toSenderCommands: toLiveStreamSenderCommands,
    toRecipientCommands: toLiveStreamReceiverCommands
};

function toLiveStreamSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: HELD_VALUE };
    const toLiveSend = (index: number) =>
        toPublicationSendCommand({
            step: sender,
            index,
            publication: LIVE_STREAM_PUBLICATION,
            ttlMs: NON_EXPIRING_TTL_MS,
            stream: undefined,
            recipientPeers: undefined
        });
    return [
        ...toPublicationLeadCommands(sender, LIVE_STREAM_PUBLICATION, undefined),
        ...toHeldSendCommands(held, [toLiveSend(HELD_VALUE)]),
        toLiveSend(OVERTAKING_VALUE),
        ...toPublicationVerdictCommands({
            step: sender,
            index: OVERTAKING_VALUE,
            state: 'transport-accepted',
            facts: []
        }),
        ...toPublicationVerdictCommands({ step: sender, index: HELD_VALUE, state: 'superseded', facts: [] }),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_VALUE}`, 0)
    ];
}

function toLiveStreamReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toArrivalCountCommand(receiver, 1, 0),
        toSeqArrivalWait(receiver, 0),
        { ...toArrivalCountCommand(receiver, 2, 2), ascendingBy: 'seq' },
        toSeqArrivalWait(receiver, OVERTAKING_VALUE),
        toEdgeOrderGapWait(receiver, 'gap-2-2', { fromPosition: 2, toPosition: 2, reason: 'ended-at-sender' }),
        toNoFurtherArrivalCommand(receiver, 3)
    ];
}
