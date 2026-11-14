import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
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
 * The sender lists the receiver's principal and recipient-b's, but recipient-b holds `publish` alone, so the frozen
 * audience leaves it out silently: one copy's receipt expects the receiver, it confirms, nobody ends outside the
 * audience, and recipient-b delivers nothing.
 */
export const grantedRtcListNonHolder: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-list-non-holder',
    scenarioKey: 'granted-rtc-list-non-holder',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: [...LISTENER_AND_PUBLISHER_START_GRANTS, { grantee: 'recipient-b', publish: true, subscribe: false }],
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication',
            audience: { recipientPrincipalIds: ['{principal:receiver}', '{principal:recipient-b}'] }
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toConfirmingOwnerCommands(recipient)
            : toNonHolderCommands(recipient)
};

function toNonHolderCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        toPublicationWait(recipient, 'publication', true)
    ];
}
