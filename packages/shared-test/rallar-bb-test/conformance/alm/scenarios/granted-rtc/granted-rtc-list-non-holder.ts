import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
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
    toCueListenCommands,
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS, toGrantedRtcOwnerCommands, toRtcArrivalWait } from './granted-rtc-commands.ts';

/**
 * The sender lists the receiver's principal and recipient-b's, but recipient-b holds `publish` alone, so the frozen
 * audience leaves it out silently: one copy's receipt expects the receiver, it confirms, nobody ends outside the
 * audience, and recipient-b delivers nothing. A grant only adds permissions and the room's three-agent cells share
 * it, so the owner revokes the `subscribe` an earlier cell granted recipient-b before it grants the sender.
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
            ? toNonHolderOwnerCommands(recipient)
            : toNonHolderCommands(recipient)
};

function toNonHolderOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner, [
            { operation: 'grant', grantee: 'recipient-b', publish: true, subscribe: false },
            { operation: 'revoke', grantee: 'recipient-b', publish: false, subscribe: true }
        ]),
        toRtcArrivalWait(owner),
        toConfirmedCueWait(owner, 'publication'),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

function toNonHolderCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        toPublicationWait(recipient, 'publication', true)
    ];
}
