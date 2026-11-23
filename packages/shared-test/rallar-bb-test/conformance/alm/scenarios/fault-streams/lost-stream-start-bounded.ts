import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_RTC_ALONE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toOrderingPositionWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toObserveCommand } from '../../alm-conformance-message-commands.ts';
import { toOrderedSendCommands, toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { toGapNackWait } from '../../alm-conformance-repair-waits.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCueStep } from '../receipted-audience.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait
} from '../topic-subscription/topic-subscription-publications.ts';

/**
 * The bounded hold: a fresh receiver that opened a track at its start, because the copy's record owed it the start,
 * does not hold it for ever when the first send never comes. Send 1 is held at the sender until the receiver has
 * entered: the receiver asks the gap and renews it, and when its last renewal falls due unanswered (7 to 10.5 s after
 * the gap) it enters at 2, delivers 2 and 3 in order and states that entry. Send 1, released after the entry, is
 * refused as before it and never delivered, and its handle ends `failed`. Over `rtc` alone: over `ws` the WS server
 * hop orders the track by another rule.
 */
export const lostStreamStartBounded: AlmConformanceScenarioDefinition = {
    scenarioId: 'lost-stream-start-bounded',
    scenarioKey: 'lost-stream-start-bounded',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_RTC_ALONE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toBoundedSenderCommands,
    toRecipientCommands: toBoundedReceiverCommands
};

/**
 * The sender listens for the receiver's cue as its arming run, then holds send 1 by its message id and sends 2 and 3.
 * The release waits for the receiver's cue, which follows its entry, so no frame of send 1 can reach it before.
 */
function toBoundedSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const first = { ...sender, index: 1 };
    const cue = toCueStep(sender);
    return [
        ...toCueListenCommands(cue),
        ...toHeldSendCommands(first, toOrderedSendCommands(sender, 1, { ack: 'receiver' })),
        ...toOrderedSendCommands(sender, 2, { ack: 'receiver' }),
        ...toOrderedSendCommands(sender, 3, { ack: 'receiver' }),
        toGapNackWait({ step: sender, name: 'gap-nack', orderingKey: toOrderingKey(sender), absent: false }),
        toCueWait(cue, 'entered'),
        ...toHeldMessageFaultCommands(first, 'release-message-1', 0),
        toObserveCommand({ ...first, state: 'failed', budgetMs: NON_EXPIRING_SEND_TIMEOUT_MS })
    ];
}

/**
 * The hold's entry at 2, after the record's prior 1, then 2 and 3 in order. The cue follows them, so the absence of a
 * third arrival covers the released send 1, which is refused as before the entry. One sender holds the cell's track,
 * so the ordering key alone names it.
 */
function toBoundedReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const track = toOrderingKey(receiver);
    return [
        toOrderingPositionWait(receiver, { name: 'entered-2', status: 'entered', priorSeq: 1, track }),
        toReceivedCommand({ ...receiver, index: 2, count: 2, absent: false, ascendingBy: 'seq' }),
        ...toCueSendCommands(toCueStep(receiver), 'entered'),
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: true }),
        toOrderingPositionWait(receiver, { name: 'before-entry-1', status: 'before-entry', priorSeq: 0, track })
    ];
}
