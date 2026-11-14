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
import { GRANTED_RTC_CARRIERS, toRtcAdmittedWait } from './granted-rtc-commands.ts';
import { LISTENER_AND_PUBLISHER_START_GRANTS } from './granted-rtc-start-grants.ts';
import { toConfirmingOwnerCommands } from './to-confirming-owner-commands.ts';

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
    startGrants: [...LISTENER_AND_PUBLISHER_START_GRANTS, { grantee: 'recipient-b', publish: false, subscribe: true }],
    toSenderCommands: (sender) =>
        toPublishUntilConfirmedCommands({
            step: sender,
            name: 'publication',
            confirmations: 1,
            outsideAudience: 1,
            kind: 'publication'
        }),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toConfirmingOwnerCommands(recipient)
            : toUnelectedRecipientCommands(recipient)
};

function toUnelectedRecipientCommands(recipient: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(recipient),
        toRtcAdmittedWait(recipient),
        toConfirmedCueWait(recipient, 'publication'),
        toPublicationWait(recipient, 'publication', true)
    ];
}
