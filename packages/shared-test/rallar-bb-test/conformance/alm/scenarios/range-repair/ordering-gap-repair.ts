import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldMessageFaultCommands } from '../../alm-conformance-fault-commands.ts';
import { toHeldSecondSendCommands } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

/**
 * An in-window gap is repaired by range: the sender's second frame is held, the third reveals the gap, the hop
 * NACKs the range `2-2`, which the sender admits and answers with a retransmission once the hold lifts, and the
 * receiver's ordered delivery hands the channel seq 1, 2, 3 in order and nothing more. The cell runs where one hop
 * carries the track: a hand-over to WS would show the relay a lone second frame it gates as its own gap.
 */
export const orderingGapRepair: AlmConformanceScenarioDefinition = {
    scenarioId: 'ordering-gap-repair',
    scenarioKey: 'ordering-gap-repair',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toOrderingGapRepairSenderCommands,
    toRecipientCommands: toOrderingGapRepairReceiverCommands
};

/** The release follows the admitted NACK, so the frame that then reaches the receiver is the repair's. */
function toOrderingGapRepairSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldSecondSendCommands(sender),
        ...toHeldMessageFaultCommands({ ...sender, index: 2 }, 'release-message-2', 0)
    ];
}

/**
 * The first arrival starts the observation; all three must arrive within the send budget after the sender's
 * release; a fourth never does. The typed channel hands them over in sequence by construction: the third is
 * buffered until the second arrives.
 */
function toOrderingGapRepairReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: false }),
        toReceivedCommand({ ...receiver, index: 4, count: 4, absent: true })
    ];
}
