import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { toPrincipalPlaceholder } from '../../resolve-alm-conformance-principals.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toCueListenCommands, toCueWait } from '../topic-subscription/topic-subscription-publications.ts';
import {
    GRANTED_RTC_CARRIERS,
    toInboundRefusalWait,
    toRefusedReceiverCommands,
    toRewritingPublisherCommands
} from './granted-rtc-commands.ts';

/**
 * The sender's page names each frame it signed as recipient-b's: that member's live session and its registered key,
 * so the forged identity is neither the sender nor the receiver. The receiver and recipient-b each find the key and
 * drop the frame for its signature, `unauthorized`; the receiver never delivers it.
 */
export const grantedRtcForgedSender: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-forged-sender',
    scenarioKey: 'granted-rtc-forged-sender',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'sender', 'recipient-b'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (sender) =>
        toRewritingPublisherCommands(sender, { forgeSender: { principal: toPrincipalPlaceholder('recipient-b') } }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toRefusedReceiverCommands(recipient, 'invalid-signature')
            : [
                ...toCueListenCommands(recipient),
                toInboundRefusalWait(recipient, 'invalid-signature'),
                toCueWait(recipient, 'refused')
            ]
};
