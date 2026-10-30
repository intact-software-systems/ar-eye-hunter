import type { GroupPolicyDenied, GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import {
    GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { canMutateActiveGroup } from '../../policy/group-lifecycle-policy.ts';
import { canSubscribeGroupTopic, isLiveClientSession } from '../../policy/group-topic-subscription-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    GroupTopicSubscriptionDeleteEffect,
    GroupTopicSubscriptionOperation,
    SubscriptionGuardCandidate
} from '../group-mutation-contracts.ts';
import {
    computeGroupMutationWriteResult,
    notSubscribed,
    rejectedByGroupPolicy,
    requireGroup
} from '../group-mutation-result.ts';

type GroupTopicSubscriptionCommand = Extract<GroupMutationCommand, { operation: GroupTopicSubscriptionOperation; }>;

export function computeGroupTopicSubscriptionMutation(
    command: GroupTopicSubscriptionCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    return command.operation === 'subscribeGroupTopic'
        ? computeSubscribe(command, read, facts)
        : computeUnsubscribe(command, read, facts);
}

/** The deletes of the given live rows, each at the revision its read observed. */
export function toTopicSubscriptionDeleteEffects(
    ref: GroupRef,
    subscriptions: readonly RuntimeStateEntryValue<GroupTopicSubscription>[]
): readonly GroupTopicSubscriptionDeleteEffect[] {
    return subscriptions.map(({ entry, value }) => ({ ref, value, expectedRevision: entry.revision }));
}

function computeSubscribe(
    command: GroupTopicSubscriptionCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef).value;
    const denial = resolveSubscribeDenial(command, read, facts);
    if (denial !== null) {
        return rejectedByGroupPolicy({ command, read, facts, denial });
    }
    if (read.targetMember === null) {
        throw new TypeError('An allowed subscribe reads its active member');
    }
    const subscription: GroupTopicSubscription = {
        sessionId: command.sessionId,
        principalId: read.targetMember.principalId,
        topicId: command.input.topicId,
        connectionGenerationId: command.input.connectionGenerationId,
        leaseExpiresAtEpochMs: facts.attemptAtEpochMs + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
        admittedAtGroupRevision: group.snapshotVersion
    };
    const current = read.targetTopicSubscription;
    const ref = command.aggregateRef;
    return computeSubscriptionWrite({
        command,
        read,
        facts,
        guard: current === null
            ? { kind: 'subscription', operation: 'insert', ref, value: subscription }
            : {
                kind: 'subscription',
                operation: 'update',
                ref,
                value: subscription,
                expectedRevision: current.entry.revision
            },
        outcome: current?.value.connectionGenerationId === subscription.connectionGenerationId
            ? 'renewed'
            : 'subscribed'
    });
}

function resolveSubscribeDenial(
    command: GroupTopicSubscriptionCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupPolicyDenied | null {
    const results: readonly GroupPolicyResult[] = [
        canMutateActiveGroup({
            group: requireGroup(read, command.aggregateRef).value,
            nowEpochMs: facts.attemptAtEpochMs
        }),
        canSubscribeGroupTopic({
            member: read.targetMember,
            grant: read.targetPublicationGrant?.value ?? null,
            topicId: command.input.topicId,
            clientSession: read.targetClientSession?.value ?? null,
            connectionGenerationId: command.input.connectionGenerationId,
            nowEpochMs: facts.attemptAtEpochMs
        })
    ];
    return results.find((result): result is GroupPolicyDenied => !result.allowed) ?? null;
}

/** Only the generation that holds the row and is the session's live one releases it; anything else deletes nothing. */
function computeUnsubscribe(
    command: GroupTopicSubscriptionCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const current = read.targetTopicSubscription;
    const session = read.targetClientSession?.value ?? null;
    const generation = command.input.connectionGenerationId;
    if (
        current === null || current.value.connectionGenerationId !== generation ||
        !isLiveClientSession(session, facts.attemptAtEpochMs) || session.generationId !== generation
    ) {
        return notSubscribed(command, read, facts);
    }
    return computeSubscriptionWrite({
        command,
        read,
        facts,
        guard: {
            kind: 'subscription',
            operation: 'delete',
            ref: command.aggregateRef,
            value: current.value,
            expectedRevision: current.entry.revision
        },
        outcome: 'unsubscribed'
    });
}

interface SubscriptionWriteInput {
    readonly command: GroupTopicSubscriptionCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly guard: SubscriptionGuardCandidate;
    readonly outcome: 'subscribed' | 'renewed' | 'unsubscribed';
}

/** The subscription row is its own guard: no event, no outbox, no version bump, only the row and its receipt. */
function computeSubscriptionWrite(
    { command, read, facts, guard, outcome }: SubscriptionWriteInput
): GroupMutationComputed {
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard,
        members: [],
        initialPresenceSummary: null,
        presenceAdmission: null,
        eventType: null,
        lifecyclePolicy: null,
        presenceSummaryWork: 'none',
        publicationGrantEffects: [],
        subscriptionEffects: [],
        subscriptionOutcome: outcome
    });
}
