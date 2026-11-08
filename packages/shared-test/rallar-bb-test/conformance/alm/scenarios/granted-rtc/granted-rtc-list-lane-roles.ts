import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    TOPIC_SUBSCRIPTION_SELECTOR,
    toSubscribeCommand,
    toUnsubscribeCommands
} from '../topic-subscription/topic-subscription-commands.ts';
import {
    toConfirmedCueWait,
    toCueListenCommands,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS, toRtcArrivalWait } from './granted-rtc-commands.ts';
import { RECIPIENT_B_SUBSCRIBES, toConfirmingOwnerCommands } from './granted-rtc-confirming-owner.ts';

/**
 * The sender lists its two recipients by lane role, which the page resolves to their sessions through the leader rule.
 * Both hold `subscribe` and an election, so one copy's receipt expects both, both confirm, and nobody ends outside the
 * audience.
 */
export const grantedRtcListLaneRoles: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-list-lane-roles',
    scenarioKey: 'granted-rtc-list-lane-roles',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 2,
            outsideAudience: 0,
            kind: 'publication',
            audience: { recipientPeers: ['receiver', 'recipient-b'] }
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toConfirmingOwnerCommands(recipient, [RECIPIENT_B_SUBSCRIBES])
            : toListedSubscriberCommands(recipient)
};

function toListedSubscriberCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toSubscribeCommand(recipient, 'recipient-b'),
        toRtcArrivalWait(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        ...toUnsubscribeCommands(recipient, 'recipient-b')
    ];
}
