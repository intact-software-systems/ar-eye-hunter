import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toPauseCommand } from '../../to-pause-command.ts';
import {
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toProductSocketCommand,
    toSubscribeCommand,
    toTokenReadCommand,
    toTopicGrantCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import {
    toGenerationChangePollCommand,
    toRowsGenerationPollCommand
} from './topic-subscription-generation-polls.ts';
import { toResultFact } from './topic-subscription-polls.ts';
import {
    SUBSCRIPTION_ABSENCE_MS,
    toConfirmedCueWait,
    toCueListenCommands,
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

/** Covers the sibling's close, which follows the probe loop's cue at once, its reopen and its re-assertion. */
const RECONNECT_MARGIN_MS = 2_000;

/**
 * A same-session socket reconnect re-asserts the subscription under the new connection generation, but the server
 * closed the session's room presence with the old socket and nothing reopens it. The sibling's product socket drops
 * and reopens; its one row moves to the new generation and its token stays `active`, yet `publication`, published once
 * the server expects the receiver alone, reaches the receiver and not the reopened sibling.
 */
export const subscriptionReconnect: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-reconnect',
    scenarioKey: 'subscription-reconnect',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (producer) => producer.role === 'sender' ? toPublisherCommands(producer) : [],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toReconnectingSubscriberCommands(recipient)
};

function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: false, subscribe: true }),
        toSubscribeCommand(owner, 'receiver'),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: true, subscribe: true }),
        toPublicationWait(owner, 'publication', false),
        toConfirmedCueWait(owner, 'publication'),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}

/** The sibling sends nothing: the reopened session holds no room presence to send with. */
function toReconnectingSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    if (sibling.role !== 'sibling') {
        return [];
    }
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        toTokenReadCommand(sibling, 'tokens-before-drop'),
        toConfirmedCueWait(sibling, 'probe-two-subscribers'),
        toProductSocketCommand(sibling, 'close'),
        toProductSocketCommand(sibling, 'reopen'),
        toGenerationChangePollCommand({
            step: sibling,
            name: 'reasserted',
            before: 'tokens-before-drop',
            status: 'active'
        }),
        toTokenReadCommand(sibling, 'tokens-reconnected'),
        toRowsGenerationPollCommand({
            step: sibling,
            name: 'rows-reconnected',
            tokens: 'tokens-reconnected',
            names: true
        }),
        toTokenReadCommand(sibling, 'tokens-after-rows'),
        toResultFact({
            step: sibling,
            name: 'tokens-after-rows-active',
            source: `resultCache.${toCommandId(sibling, 'tokens-after-rows')}.value.subscriptions.0.status`,
            operator: 'equals',
            expected: 'active'
        }),
        toPauseCommand(sibling, 'publication-margin', SUBSCRIPTION_ABSENCE_MS),
        toPublicationWait(sibling, 'publication', true),
        ...toUnsubscribeCommands(sibling, 'sibling')
    ];
}

function toPublisherCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'probe-two-subscribers',
            confirmations: 2,
            kind: 'probe'
        }),
        toPauseCommand(sender, 'reconnect-margin', RECONNECT_MARGIN_MS),
        ...toPublishUntilConfirmedCommands({ step: sender, name: 'publication', confirmations: 1, kind: 'publication' })
    ];
}
