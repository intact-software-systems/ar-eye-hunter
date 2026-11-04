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

/** The sibling's fact that its re-asserted token reads `active` once its row names the new generation. */
const REASSERTED_ACTIVE = 'tokens-after-rows-active';

/**
 * A same-session socket reconnect re-asserts the subscription under the new connection generation, but the server
 * closed the session's room presence with the old socket and nothing reopens it. The sibling's product socket drops
 * and reopens; its one row moves to the new generation and its token stays `active`, yet `publication` reaches the
 * receiver and not the reopened sibling. A probe publishes first until the receiver alone is expected: the WS server
 * stops expecting the sibling with its socket, an RTC sender once its snapshot drops the closed presence, which
 * until then freezes the sibling in with its active token. The reopened sibling can send nothing to say it is done,
 * so the lane holds the publication back as the sender's continuation until the sibling's token reads `active` after
 * its row names the new generation.
 */
export const subscriptionReconnect: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-reconnect',
    scenarioKey: 'subscription-reconnect',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    principalRoles: ['receiver', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (producer) => producer.role === 'sender' ? toProbeCommands(producer) : [],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toReconnectingSubscriberCommands(recipient),
    continuation: {
        // A fact's command is named `assert-<fact>`.
        gate: { role: 'sibling', commandName: `assert-${REASSERTED_ACTIVE}` },
        toCommands: (sender) =>
            toPublishUntilConfirmedCommands({
                step: sender,
                name: 'publication',
                confirmations: 1,
                outsideAudience: 0,
                kind: 'publication'
            })
    }
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
            name: REASSERTED_ACTIVE,
            source: `resultCache.${toCommandId(sibling, 'tokens-after-rows')}.value.subscriptions.0.status`,
            operator: 'equals',
            expected: 'active'
        }),
        toPauseCommand(sibling, 'publication-margin', SUBSCRIPTION_ABSENCE_MS),
        toPublicationWait(sibling, 'publication', true),
        ...toUnsubscribeCommands(sibling, 'sibling')
    ];
}

function toProbeCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'probe-two-subscribers',
            confirmations: 2,
            outsideAudience: 0,
            kind: 'probe'
        }),
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'probe-receiver-alone',
            confirmations: 1,
            outsideAudience: 0,
            kind: 'probe'
        })
    ];
}
