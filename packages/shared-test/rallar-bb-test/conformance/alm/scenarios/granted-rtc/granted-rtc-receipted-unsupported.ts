import { toRtcRefusalFacts } from '../../to-rtc-refusal-facts.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR, toTopicGrantCommand } from '../topic-subscription/topic-subscription-commands.ts';
import { GRANTED_RTC_CARRIERS, RECEIPTED_DELIVERY, toGrantedRefusalPollCommand } from './granted-rtc-commands.ts';

/**
 * The sender holds `publish` and asks a receipt of its granted room publication: RTC carries none for a granted topic,
 * so the carrier refuses the send `unsupported` before admission and, under `rtc`, no other carrier takes it.
 */
export const grantedRtcReceiptedUnsupported: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-receipted-unsupported',
    scenarioKey: 'granted-rtc-receipted-unsupported',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (sender) => [
        toGrantedRefusalPollCommand({
            step: sender,
            delivery: RECEIPTED_DELIVERY,
            facts: toRtcRefusalFacts('unsupported')
        })
    ],
    toRecipientCommands: (receiver) => [
        toTopicGrantCommand({ step: receiver, operation: 'grant', grantee: 'sender', publish: true, subscribe: false })
    ]
};
