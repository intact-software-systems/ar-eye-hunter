import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toCueWait, toPublicationWait } from '../topic-subscription/topic-subscription-publications.ts';
import { toPublishUntilCueCommand, toRtcArrivalWait } from './granted-rtc-commands.ts';
import { toPathMemberCommands, toPathOwnerCommands, toPathSenderCommands } from './granted-rtc-path.ts';
import { PATH_START_GRANTS } from './granted-rtc-start-grants.ts';

/**
 * The owner reshapes the room into a path before the sender publishes. The receiver holds `subscribe` and an
 * election, recipient-b `publish` alone, so the sender's `ack: 'none'` publication is frozen to the receiver. The
 * cell proves two things: the receiver gets the publication over RTC, and recipient-b, which holds no `subscribe`,
 * delivers nothing to its application. It does not prove that recipient-b forwards the frame: the run draws the
 * path and nothing forces recipient-b into its middle, so the frame may reach the receiver without crossing it. A
 * hop test pins the forward, and the carrier matrix names it beside this cell under `relay-payload-confidentiality`.
 * Each page records its next hops, which name the layout the run drew; the cell asserts neither which agent relays
 * nor the hop count.
 */
export const grantedRtcRelayOnly: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-relay-only',
    scenarioKey: 'granted-rtc-relay-only',
    roomTopology: 'reshaped',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('granted-rtc-relay-only'),
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: PATH_START_GRANTS,
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
