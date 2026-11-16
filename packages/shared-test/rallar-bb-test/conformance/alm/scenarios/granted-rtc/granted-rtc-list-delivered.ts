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
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS } from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';
import { toConfirmingOwnerCommands } from './to-confirming-owner-commands.ts';

/**
 * The sender lists the receiver's principal alone. Recipient-b holds `subscribe` and an election, yet the list leaves
 * it out: one copy's receipt expects the receiver, it confirms, and recipient-b delivers nothing. A tree layout may
 * still route recipient-b a copy to forward, so the cell makes no admission assertion there.
 */
export const grantedRtcListDelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-list-delivered',
    scenarioKey: 'granted-rtc-list-delivered',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: [...LISTENER_AND_PUBLISHER_START_GRANTS, { grantee: 'recipient-b', publish: false, subscribe: true }],
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication',
            audience: { recipientPrincipalIds: ['{principal:receiver}'] }
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toConfirmingOwnerCommands(recipient)
            : toUnlistedSubscriberCommands(recipient)
};

function toUnlistedSubscriberCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toSubscribeCommand(recipient, 'recipient-b'),
        toConfirmedCueWait(recipient, 'publication'),
        toPublicationWait(recipient, 'publication', true),
        ...toUnsubscribeCommands(recipient, 'recipient-b')
    ];
}
