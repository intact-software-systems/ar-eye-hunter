import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    TOPIC_SUBSCRIPTION_SELECTOR,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import { toCueListenCommands, toCueSendCommands } from '../topic-subscription/topic-subscription-publications.ts';
import {
    GRANTED_RTC_CARRIERS,
    toGrantedRtcOwnerCommands,
    toPublishUntilCueCommand,
    toRtcArrivalWait
} from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';

/**
 * The sender holds `publish`, the receiver `subscribe` and an active election. The sender's page signs each `ack: 'none'`
 * room publication with the key its snapshot attests, and the receiver verifies the frame against its own snapshot and
 * delivers it over RTC, to its election alone.
 */
export const grantedRtcDelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-delivered',
    scenarioKey: 'granted-rtc-delivered',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: LISTENER_AND_PUBLISHER_START_GRANTS,
    toSenderCommands: (sender) => [...toCueListenCommands(sender), toPublishUntilCueCommand(sender, 'received')],
    toRecipientCommands: toDeliveredReceiverCommands
};

function toDeliveredReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(receiver),
        toRtcArrivalWait(receiver),
        ...toCueSendCommands(receiver, 'received'),
        ...toUnsubscribeCommands(receiver, 'receiver')
    ];
}
