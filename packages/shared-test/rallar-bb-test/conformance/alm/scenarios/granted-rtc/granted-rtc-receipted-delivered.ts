import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import { toPublishUntilConfirmedCommands } from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS } from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';
import { toConfirmingOwnerCommands } from './to-confirming-owner-commands.ts';

/**
 * A receipted granted publication rides RTC: the sender publishes asking every logical recipient until the receipt of
 * one copy expects the subscribed receiver alone and it confirms, so nobody ends outside the audience.
 */
export const grantedRtcReceiptedDelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-receipted-delivered',
    scenarioKey: 'granted-rtc-receipted-delivered',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: LISTENER_AND_PUBLISHER_START_GRANTS,
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication'
        }),
    toRecipientCommands: (receiver) => toConfirmingOwnerCommands(receiver)
};
