import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toPublishUntilConfirmedCommands } from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS } from './granted-rtc-commands.ts';
import { toConfirmingOwnerCommands } from './granted-rtc-confirming-owner.ts';

/**
 * A granted unicast rides RTC as a multicast of one: the sender addresses the receiver and asks its receipt alone, so
 * one copy expects the receiver, it confirms, and nobody ends outside the audience.
 */
export const grantedRtcUnicastDelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-unicast-delivered',
    scenarioKey: 'granted-rtc-unicast-delivered',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication',
            audience: { toPeer: 'receiver' }
        }),
    toRecipientCommands: (receiver) => toConfirmingOwnerCommands(receiver, [])
};
