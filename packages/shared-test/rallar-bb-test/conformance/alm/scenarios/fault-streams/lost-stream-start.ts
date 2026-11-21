import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toOrderingPositionWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toOrderedSendCommands,
    toOrderingKey,
    toReachedCommands
} from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { toGapNackWait } from '../../alm-conformance-repair-waits.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

/**
 * The first send of a new ordered track is not lost when later sends reach the track's ordering hop before it: the hop
 * opens the track at its start, holds the later sends, and asks the sender for the first with a gap NACK. Once the
 * first arrives, all three are delivered in sequence order and every handle ends `acknowledged`. The first send is
 * held by its message id, so no draw decides which frame comes late.
 */
export const lostStreamStart: AlmConformanceScenarioDefinition = {
    scenarioId: 'lost-stream-start',
    scenarioKey: 'lost-stream-start',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_SINGLE_HOP_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toLostStreamStartSenderCommands,
    toRecipientCommands: toLostStreamStartReceiverCommands
};

/**
 * The hold is released only once the sender admitted a gap NACK about its track: a later send then reached the hop
 * before the first. Sends 2 and 3 are not awaited before the release: a copy the hop holds may already be acknowledged.
 */
function toLostStreamStartSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const first = { ...sender, index: 1 };
    return [
        ...toHeldSendCommands(first, toOrderedSendCommands(sender, 1, { ack: 'receiver' })),
        ...toOrderedSendCommands(sender, 2, { ack: 'receiver' }),
        ...toOrderedSendCommands(sender, 3, { ack: 'receiver' }),
        toGapNackWait({ step: sender, name: 'gap-nack', orderingKey: toOrderingKey(sender), absent: false }),
        ...toHeldMessageFaultCommands(first, 'release-message-1', 0),
        ...[1, 2, 3].flatMap((seq) => toReachedCommands({ ...sender, index: seq }))
    ];
}

/** One sender holds the cell's track, so the ordering key alone names it. */
function toLostStreamStartReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: false, ascendingBy: 'seq' }),
        toOrderingPositionWait(receiver, {
            name: 'no-before-entry',
            status: 'before-entry',
            track: toOrderingKey(receiver),
            absent: true
        })
    ];
}
