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
import {
    GRANTED_RTC_CARRIERS,
    toGrantedRtcOwnerCommands,
    toRtcAdmittedWait,
    toRtcArrivalWait
} from './granted-rtc-commands.ts';

/**
 * Recipient-b holds `subscribe` but takes no election, so the sender's grant-narrowed audience freezes it in: its copy
 * forwards, delivers nothing, and answers `not-subscribed`. The sender publishes until one copy's receipt expects both
 * recipients, the receiver confirms and recipient-b ends outside the audience, its handle `acknowledged`.
 */
export const grantedRtcNotSubscribed: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-not-subscribed',
    scenarioKey: 'granted-rtc-not-subscribed',
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
            outsideAudience: 1,
            kind: 'publication'
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toConfirmingOwnerCommands(recipient) : toUnelectedRecipientCommands(recipient)
};

function toConfirmingOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner, [{ grantee: 'recipient-b', publish: false, subscribe: true }]),
        toRtcArrivalWait(owner),
        toConfirmedCueWait(owner, 'publication'),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

function toUnelectedRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toRtcAdmittedWait(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        toPublicationWait(recipient, 'publication', true)
    ];
}
