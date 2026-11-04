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
import {
    toConfirmedCueWait,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS, toGrantedRtcOwnerCommands, toRtcArrivalWait } from './granted-rtc-commands.ts';

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
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication'
        }),
    toRecipientCommands: toConfirmingReceiverCommands
};

function toConfirmingReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(receiver, []),
        toRtcArrivalWait(receiver),
        toConfirmedCueWait(receiver, 'publication'),
        ...toUnsubscribeCommands(receiver, 'receiver')
    ];
}
