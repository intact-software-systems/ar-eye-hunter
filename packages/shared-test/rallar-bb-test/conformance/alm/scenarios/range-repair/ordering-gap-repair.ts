import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_SINGLE_HOP_CARRIERS } from '../../alm-conformance-carriers.ts';
import {
    ALM_INBOUND_DIAGNOSTICS_TOPIC,
    toDiagnosticWait,
    toRepairDispatchWait
} from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands } from '../../alm-conformance-fault-commands.ts';
import { toHeldSecondSendCommands, toOrderingKey } from '../../alm-conformance-ordering-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';

/**
 * An in-window gap is repaired by range: the sender's second frame is held, the third reveals the gap, the hop NACKs
 * the range `2-2`, which the sender admits and answers with a repair dispatch of the second message while the hold
 * still stands; the hop buffers the third behind the gap and releases it once the second arrives, so the receiver's
 * channel reads seq 1, 2, 3 in order and nothing more. Over `rtc` the receiver is that hop and proves its own release;
 * over `ws` the relay is, and the receiver sees the three arrive in order. The cell runs where one hop carries the
 * track: a hand-over to WS would show the relay a lone second frame it gates as its own gap.
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

/**
 * The release follows the admitted NACK and the repair dispatch it raised, so the retransmission is proved before any
 * frame of the second message can leave: under the hold the original is resubmitted as well, and a release right after
 * the NACK would deliver seq 2 even if the hint were never served.
 */
function toOrderingGapRepairSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldSecondSendCommands(sender),
        toRepairDispatchWait({ ...sender, index: 2 }, 'repair-dispatch-2'),
        ...toHeldMessageFaultCommands({ ...sender, index: 2 }, 'release-message-2', 0)
    ];
}

/**
 * The first arrival starts the observation; all three must arrive within the send budget after the sender's
 * release; a fourth never does. Over `rtc` the receiver is the hop that buffers seq 3 behind the gap, so three arrivals
 * and its release of seq 3 together prove the order. Over `ws` the relay buffers and releases it, out of the page's
 * sight: the receiver gets the three in order and would have had a release of its own to show had it not.
 */
function toOrderingGapRepairReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toReceivedCommand({ ...receiver, index: 3, count: 3, absent: false }),
        ...(receiver.input.carrier === 'rtc' ? toBufferedReleaseWaits(receiver) : []),
        toReceivedCommand({ ...receiver, index: 4, count: 4, absent: true })
    ];
}

/**
 * The `claim-settled` event of the release that handed seq 3 to the channel, in its emitted key order (`effectId`,
 * `msgId`, `typeId`, `subjectMsgId`, `payloadKind`). The effect id is `release:<track key>:<seq>` with the track key
 * `<ordering key>:<sender peer id>:<epoch>` URI-encoded, so the sender's peer id sits inside it, unknown when the
 * recipe is authored: the cell's track is matched by the id's head, the sequence and the kind by its tail. A release
 * carries no message, so its identities read `null` rather than the cell's type id.
 */
function toBufferedReleaseWaits(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toDiagnosticWait({
            step: receiver,
            name: 'release-buffered-track',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            contains: `"effectId":"release:${encodeURIComponent(toOrderingKey(receiver))}%3A`
        }),
        toDiagnosticWait({
            step: receiver,
            name: 'release-buffered-3',
            topic: ALM_INBOUND_DIAGNOSTICS_TOPIC,
            contains: '%3A0:3","msgId":null,"typeId":null,"subjectMsgId":null,"payloadKind":"release-buffered"'
        })
    ];
}
