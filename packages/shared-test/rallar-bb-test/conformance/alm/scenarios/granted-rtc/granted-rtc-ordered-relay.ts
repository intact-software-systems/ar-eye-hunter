import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toOrderingPositionWait, toRepairDispatchWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toSentCommands } from '../../alm-conformance-ordering-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toSendHandleId } from '../../alm-conformance-step-identities.ts';
import { toGrantedSend } from '../topic-subscription/to-granted-send.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import {
    toArrivedTrackKey,
    toPublicationAbsenceWaits,
    toReadinessProbeCommands
} from '../topic-subscription/topic-subscription-ordered-publications.ts';
import {
    toCueWait,
    toPublicationPayload,
    toPublicationWait
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS } from './granted-rtc-commands.ts';
import { toPathMemberCommands, toPathOwnerCommands, toPathSenderCommands } from './granted-rtc-path.ts';
import { PATH_START_GRANTS } from './granted-rtc-start-grants.ts';

/** The track's publications, each named after its place on the track. */
const PUBLICATIONS = [1, 2, 3] as const;

/**
 * A gap on an ordered track is repaired across the path, whichever page it puts in the middle. The sender mints a
 * receipted track on the path the relay-only cell draws: `p1` leaves, `p2` is held at the sender's own RTC transport,
 * `p3` leaves and reveals the gap. The hop that sees it NACKs the range: the receiver, the sender's next hop or not,
 * or recipient-b in the middle, which relays the receiver's NACK to the sender. The sender's repair dispatch of `p2`
 * is proven before the hold is released, so the release cannot stand in for it. The receiver enters the track at `p1`
 * and receives all three, with no omission. Each page records its next hops, which name the layout the run drew; the
 * relay's NACK is reported from the run's evidence, never asserted, since the layout decides whether one is relayed.
 */
export const grantedRtcOrderedRelay: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-ordered-relay',
    scenarioKey: 'granted-rtc-ordered-relay',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: PATH_START_GRANTS,
    connect: { minReadyPeers: 1 },
    toSenderCommands: (sender) => toPathSenderCommands(sender, toHeldTrackCommands(sender)),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toPathOwnerCommands(recipient, toReceivedTrackCommands(recipient))
            : toPathMemberCommands(recipient, [
                toCueWait(recipient, 'received'),
                ...toPublicationAbsenceWaits(recipient, PUBLICATIONS.map(toPublicationName))
            ])
};

/**
 * A readiness probe, on no track, waits until the receiver alone is expected and confirms: recipient-b and the sender
 * hold no `subscribe`. `p1` has left before the hold of `p2` starts, so the hold meets `p2` alone.
 */
function toHeldTrackCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: 2 };
    return [
        ...toReadinessProbeCommands(sender, 1, 0),
        toTrackSend(sender, 1),
        ...toSentCommands({ ...sender, index: 1 }),
        ...toHeldSendCommands(held, [toTrackSend(sender, 2)]),
        toTrackSend(sender, 3),
        toRepairDispatchWait(held, 'repair-dispatch-2'),
        ...toHeldMessageFaultCommands(held, 'release-message-2', 0),
        toCueWait(sender, 'received')
    ];
}

/**
 * The receiver's position on the track: entered at `p1`, then in order. An omission of the held `p2` would name
 * whatever prior the sender recorded, so no omission of any prior may follow.
 */
function toReceivedTrackCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const arrivals = PUBLICATIONS.map((index) => toPublicationWait(receiver, toPublicationName(index), false));
    const track = toArrivedTrackKey(receiver, arrivals[0]);
    return [
        ...arrivals,
        toOrderingPositionWait(receiver, { name: 'entered-p1', status: 'entered', priorSeq: 0, track }),
        toOrderingPositionWait(receiver, { name: 'no-omitted', status: 'omitted', track, absent: true })
    ];
}

/** One minted, receipted publication on the cell's track, named as the fault holds and the repair wait name it. */
function toTrackSend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    const payload = toPublicationPayload(sender, toPublicationName(index), 'publication');
    return {
        ...toGrantedSend({ step: sender, payload, orderingKey: sender.scenarioKey }),
        commandId: toCommandId(sender, `send-${index}`),
        handleId: toSendHandleId({ ...sender, index })
    };
}

function toPublicationName(index: number): string {
    return `p${index}`;
}
