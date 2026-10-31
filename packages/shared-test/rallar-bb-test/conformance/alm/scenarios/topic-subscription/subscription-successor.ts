import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '../../../../rallar-black-box-test-contracts.ts';

import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import {
    TOPIC_SUBSCRIPTION_CARRIERS,
    TOPIC_SUBSCRIPTION_SELECTOR,
    toSubscribeCommand,
    toSubscriptionRowsCommand,
    toTokenReadCommand,
    toTopicGrantCommand,
    toUnsubscribeCommands,
    toUnsubscribeRequestCommand
} from './topic-subscription-commands.ts';
import { toRowsGenerationPollCommand } from './topic-subscription-generation-polls.ts';
import {
    toGenerationText,
    toReadPollCommand,
    toResultFact,
    toResultTextWait
} from './topic-subscription-polls.ts';
import {
    toCueListenCommands,
    toCueSendCommands,
    toCueWait,
    toPublicationWait,
    toPublishCommands
} from './topic-subscription-publications.ts';

/** The owner page's read of its own generation, after which the lane opens the successor that replaces its socket. */
const OWNER_GATE = 'tokens-owner-generation';

/**
 * The successor page of the sender's context opens while the owner page still runs, replacing its socket, and
 * subscribes under its own generation, which moves the session's one row to it. The replaced owner's token reads
 * `lapsed` and releases nothing remotely, and an explicit release naming the owner's generation answers
 * `not-subscribed`: the row stays the successor's, which `publication` then reaches. The successor keeps its election
 * to the end, since the owner page, whose socket is gone, reads the row after the successor's own steps.
 */
export const subscriptionSuccessor: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-successor',
    scenarioKey: 'subscription-successor',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ['sender', 'receiver', 'successor'],
    laneFamily: 'same-context',
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: (page) => page.role === 'sender' ? toOwnerPageCommands(page) : toSuccessorPageCommands(page),
    toRecipientCommands: toPublisherCommands
};

/** The owner page's command after which the lane opens the successor page. */
export function toSubscriptionSuccessorGateCommandId(owner: RallarBlackBoxTestRecipe): string {
    const gate = owner.commands.find((command) => command.commandId?.endsWith(`-sender-${OWNER_GATE}`));
    if (gate?.commandId === undefined) {
        throw new Error(`${owner.recipeId} names no ${OWNER_GATE} command for the successor to follow.`);
    }
    return gate.commandId;
}

/** The receiver owns the room: it grants itself `publish` and the sender's principal `subscribe`. */
function toPublisherCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: true, subscribe: false }),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: false, subscribe: true }),
        ...toCueListenCommands(owner),
        toCueWait(owner, 'successor-subscribed'),
        ...toPublishCommands(owner, 'publication')
    ];
}

/**
 * The owner reads its token `lapsed` once the successor replaced its socket and the row `moved` once the successor
 * subscribed; then neither its own release nor an explicit one under its generation moves the row back.
 */
function toOwnerPageCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const ownerGeneration = `{resultCache.${toCommandId(owner, OWNER_GATE)}.value.connectionGenerationId}`;
    const staleRelease = toUnsubscribeRequestCommand(owner, ownerGeneration);
    return [
        toSubscribeCommand(owner, 'sender'),
        toTokenReadCommand(owner, OWNER_GATE),
        toReadPollCommand({
            step: owner,
            name: 'replaced',
            read: (readName) => toTokenReadCommand(owner, readName),
            facts: [{
                name: 'replaced-lapsed',
                field: 'subscriptions.0.status',
                operator: 'equals',
                expected: 'lapsed'
            }]
        }),
        toRowsGenerationPollCommand({ step: owner, name: 'rows-moved', tokens: OWNER_GATE, names: false }),
        ...toUnsubscribeCommands(owner, 'sender'),
        toRowsGenerationPollCommand({ step: owner, name: 'rows-after-release', tokens: OWNER_GATE, names: false }),
        staleRelease,
        toResultFact({
            step: owner,
            name: 'stale-unsubscribe-not-subscribed',
            source: `resultCache.${staleRelease.commandId}.value.body.outcome`,
            operator: 'equals',
            expected: 'not-subscribed'
        }),
        toRowsGenerationPollCommand({ step: owner, name: 'rows-after-stale-release', tokens: OWNER_GATE, names: false })
    ];
}

function toSuccessorPageCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const generation = toCommandId(successor, 'tokens-successor-generation');
    const rows = toCommandId(successor, 'rows-successor');
    return [
        toSubscribeCommand(successor, 'successor'),
        toTokenReadCommand(successor, 'tokens-successor-generation'),
        toSubscriptionRowsCommand(successor, 'rows-successor'),
        toResultFact({
            step: successor,
            name: 'rows-successor-count',
            source: `resultCache.${rows}.value.body.subscriptions`,
            operator: 'length',
            expected: 1
        }),
        toResultTextWait({
            step: successor,
            name: 'rows-successor-generation',
            commandId: rows,
            topic: 'rallar.bb.http.response',
            text: toGenerationText(`{resultCache.${generation}.value.connectionGenerationId}`),
            absent: false
        }),
        ...toCueSendCommands(successor, 'successor-subscribed'),
        toPublicationWait(successor, 'publication', false)
    ];
}
