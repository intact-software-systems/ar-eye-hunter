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
    toTopicGrantCommand,
    toUnsubscribeCommands
} from './topic-subscription-commands.ts';
import {
    toConfirmedCueWait,
    toCueListenCommands,
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from './topic-subscription-publications.ts';

/**
 * Both producers hold `publish` and `subscribe`, the receiver `subscribe`; only the receiver and the sibling elect to
 * receive. Each producer publishes until both confirm one copy, so the receiver and the sibling receive both
 * publications, the sibling its own principal's too, and neither producer, granted but not subscribed, the other's.
 * Each recipient keeps its election until both producers said their copy was confirmed.
 */
export const subscriptionDelivery: AlmConformanceScenarioDefinition = {
    scenarioId: 'subscription-delivery',
    scenarioKey: 'subscription-delivery',
    tags: FULL_TAGS,
    carriers: TOPIC_SUBSCRIPTION_CARRIERS,
    roles: ALM_CONFORMANCE_FOUR_ROLE_ROLES,
    laneFamily: 'four-role',
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    toSenderCommands: toProducerCommands,
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver' ? toOwnerCommands(recipient) : toSubscriberCommands(recipient)
};

function toProducerCommands(producer: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const [own, other] = producer.role === 'sender'
        ? ['publication-a', 'publication-c']
        : ['publication-c', 'publication-a'];
    return [
        ...toPublishUntilConfirmedCommands({ step: producer, name: own, confirmations: 2, kind: 'publication' }),
        toPublicationWait(producer, other, true)
    ];
}

/** The receiver owns the room: it elects itself before it grants the others, so it is subscribed before they are. */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(owner),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'receiver', publish: false, subscribe: true }),
        toSubscribeCommand(owner, 'receiver'),
        toTopicGrantCommand({
            step: owner,
            operation: 'grant',
            grantee: 'publisher-b',
            publish: true,
            subscribe: true
        }),
        toTopicGrantCommand({ step: owner, operation: 'grant', grantee: 'sender', publish: true, subscribe: true }),
        ...toReceivedPublicationCommands(owner)
    ];
}

function toSubscriberCommands(sibling: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toCueListenCommands(sibling),
        toSubscribeCommand(sibling, 'sibling'),
        ...toReceivedPublicationCommands(sibling)
    ];
}

function toReceivedPublicationCommands(subscriber: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toPublicationWait(subscriber, 'publication-a', false),
        toPublicationWait(subscriber, 'publication-c', false),
        toConfirmedCueWait(subscriber, 'publication-a'),
        toConfirmedCueWait(subscriber, 'publication-c'),
        ...toUnsubscribeCommands(subscriber, subscriber.role)
    ];
}
