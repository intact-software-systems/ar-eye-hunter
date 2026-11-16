import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import {
    GRANTED_RTC_CARRIERS,
    toRefusedReceiverCommands,
    toRewritingPublisherCommands
} from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';

/** The sender's page deletes the proof from each frame it signed; the receiver drops the frame `unauthorized`. */
export const grantedRtcMissingProof: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-missing-proof',
    scenarioKey: 'granted-rtc-missing-proof',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: LISTENER_AND_PUBLISHER_START_GRANTS,
    toSenderCommands: (sender) => toRewritingPublisherCommands(sender, 'strip-proof'),
    toRecipientCommands: (receiver) => toRefusedReceiverCommands(receiver, 'missing-proof')
};
