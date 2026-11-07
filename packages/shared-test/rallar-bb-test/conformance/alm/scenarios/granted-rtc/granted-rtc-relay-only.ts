import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toCueWait, toPublicationWait } from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS, toPublishUntilCueCommand, toRtcArrivalWait } from './granted-rtc-commands.ts';
import { toPathMemberCommands, toPathOwnerCommands, toPathSenderCommands } from './granted-rtc-path.ts';

/**
 * The owner reshapes the room into a path before the sender publishes. The receiver holds `subscribe` and an
 * election, recipient-b `publish` alone, so the sender's `ack: 'none'` publication is frozen to the receiver.
 * Whichever of the two the path puts in the middle, recipient-b delivers nothing: as the middle it forwards the frame
 * to the receiver, as a leaf the frozen audience routes no copy to it. Each page records its next hops, which name the
 * layout the run drew; the cell asserts neither which agent relays nor the hop count.
 */
export const grantedRtcRelayOnly: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-relay-only',
    scenarioKey: 'granted-rtc-relay-only',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    connect: { minReadyPeers: 1 },
    toSenderCommands: (sender) => toPathSenderCommands(sender, [toPublishUntilCueCommand(sender, 'received')]),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toPathOwnerCommands(recipient, [toRtcArrivalWait(recipient)])
            : toPathMemberCommands(recipient, [
                toCueWait(recipient, 'received'),
                toPublicationWait(recipient, 'publication', true)
            ])
};
