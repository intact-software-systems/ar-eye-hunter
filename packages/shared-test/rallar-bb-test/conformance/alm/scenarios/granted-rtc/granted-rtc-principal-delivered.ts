import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES } from '../../alm-conformance-roles.ts';
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
import { GRANTED_RTC_CARRIERS, toGrantedRtcOwnerCommands, toRtcArrivalWait } from './granted-rtc-commands.ts';

/**
 * The sender addresses its own principal on the granted topic. The owner grants that principal `subscribe` too, so the
 * sender's sibling, which elects itself, receives the copy over RTC and confirms it; the receiver, elected but of
 * another principal, delivers nothing, and nobody ends outside the audience.
 */
export const grantedRtcPrincipalDelivered: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-principal-delivered',
    scenarioKey: 'granted-rtc-principal-delivered',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES,
    laneFamily: 'same-principal',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'publication',
            audience: { scope: 'principal', principalId: '{auth.clientId}' }
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toBystanderOwnerCommands(recipient) : toSiblingCommands(recipient)
};

function toBystanderOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner, [], { publish: true, subscribe: true }),
        toConfirmedCueWait(owner, 'publication'),
        toPublicationWait(owner, 'publication', true),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

function toSiblingCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        toRtcArrivalWait(sibling),
        toConfirmedCueWait(sibling, 'publication'),
        ...toUnsubscribeCommands(sibling, 'sibling')
    ];
}
