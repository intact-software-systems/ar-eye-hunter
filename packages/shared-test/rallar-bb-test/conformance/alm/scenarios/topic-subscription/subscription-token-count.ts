import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_FOUR_ROLE_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toSubscribeCommand,
    toSubscriptionRowsCommand,
    toTokenReadCommand,
    toTopicGrantCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import {
    toReadPollCommand,
    toResultFact
} from './topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationWait,
    toPublishCommands,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

/**
 * Two tokens on one page hold one election: the receiver's first unsubscribe lapses `t1` alone and its session keeps
 * its one subscription row, so `publication-1` still reaches it; the last token's release deletes the row, and
 * `publication-2`, published once the receiver says so, reaches the subscribed sibling and not the receiver.
 */
export const subscriptionTokenCount: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-token-count',
    scenarioKey: 'subscription-token-count',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (producer) => producer.role === 'sender' ? toPublisherCommands(producer) : [],
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toSubscriberCommands(recipient)
};

/**
 * The receiver releases `t1` before it grants the sender's principal, so the sibling's election, and with it the
 * readiness of `publication-1`, follows the release.
 */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: false, subscribe: true }),
        toSubscribeCommand(owner, 't1'),
        toSubscribeCommand(owner, 't2'),
        ...toRowCountCommands(owner, 'rows-two-tokens', 1),
        ...toUnsubscribeCommands(owner, 't1'),
        toTokenReadCommand(owner, 'tokens-after-t1'),
        ...(['lapsed', 'active'] as const).map((status, index) =>
            toResultFact({
                step: owner,
                name: `tokens-after-t1-${index}-${status}`,
                source: toTokenStatusSource(owner, index),
                operator: 'equals',
                expected: status
            })
        ),
        ...toRowCountCommands(owner, 'rows-one-token', 1),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: true, subscribe: true }),
        toPublicationWait(owner, 'publication-1', false),
        ...toUnsubscribeCommands(owner, 't2'),
        toReadPollCommand({
            step: owner,
            name: 'rows-released',
            read: (readName) => toSubscriptionRowsCommand(owner, readName),
            facts: [{ name: 'rows-released-empty', field: 'body.subscriptions', operator: 'length', expected: 0 }]
        }),
        ...toCueSendCommands(owner, 'released'),
        toPublicationWait(owner, 'publication-2', true)
    ];
}

function toSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return sibling.role === 'sibling'
        ? [
            toSubscribeCommand(sibling, 'sibling'),
            toPublicationWait(sibling, 'publication-1', false),
            toPublicationWait(sibling, 'publication-2', false),
            ...toUnsubscribeCommands(sibling, 'sibling')
        ]
        : [];
}

/** A probe until both elections hold, then each publication once, the second after the receiver released `t2`. */
function toPublisherCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sender),
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: 'probe-two-subscribers',
            confirmations: 2,
            kind: 'probe'
        }),
        ...toPublishCommands(sender, 'publication-1'),
        toCueWait(sender, 'released'),
        ...toPublishCommands(sender, 'publication-2')
    ];
}

function toRowCountCommands(
    owner: AlmConformanceStepInput,
    name: string,
    rows: number
): readonly RallarBlackBoxTestCommand[] {
    const read = toSubscriptionRowsCommand(owner, name);
    return [
        read,
        toResultFact({
            step: owner,
            name: `${name}-count`,
            source: `resultCache.${read.commandId}.value.body.subscriptions`,
            operator: 'length',
            expected: rows
        })
    ];
}

function toTokenStatusSource(owner: AlmConformanceStepInput, index: number): string {
    return `resultCache.${toTokenReadCommand(owner, 'tokens-after-t1').commandId}.value.subscriptions.${index}.status`;
}
