import type {
    GroupStateMutationExactEntries,
    GroupStateMutationExactReadInput
} from '../../persistence/read-exact-group-state-mutation.ts';
import { groupStateTopicSubscriptionStorageKey } from '../../persistence/subscription/group-topic-subscription-storage-key.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { resolveGroupMutationTargetPrincipalId } from '../orchestration/resolve-group-mutation-target-identity.ts';
import { readsTargetPrincipalSubscriptions, readsTopicSubscriptionTarget } from './group-mutation-read-scope.ts';

export type GroupMutationSubscriptionReadInput = Pick<
    GroupStateMutationExactReadInput,
    'topicSubscriptions' | 'clientSessions' | 'subscriptionPrincipalIds'
>;

export type GroupMutationSubscriptionRead = Pick<
    GroupMutationRead,
    'targetTopicSubscription' | 'targetClientSessions' | 'targetPrincipalSubscriptions'
>;

/** The subscription identities the command's read scope names; empty lists for every other command. */
export function toGroupMutationSubscriptionReadInput(
    command: GroupMutationCommand
): GroupMutationSubscriptionReadInput {
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const subscriptionTarget = readsTopicSubscriptionTarget(command)
        ? { sessionId: command.sessionId, topicId: command.input.topicId }
        : null;
    return {
        topicSubscriptions: subscriptionTarget === null ? [] : [subscriptionTarget],
        clientSessions: subscriptionTarget === null || targetPrincipalId === null
            ? []
            : [{ principalId: targetPrincipalId, sessionId: subscriptionTarget.sessionId }],
        subscriptionPrincipalIds: readsTargetPrincipalSubscriptions(command) && targetPrincipalId !== null
            ? [targetPrincipalId]
            : []
    };
}

export function toGroupMutationSubscriptionRead(
    command: GroupMutationCommand,
    read: Pick<GroupStateMutationExactEntries, 'topicSubscriptions' | 'clientSessions' | 'principalSubscriptions'>
): GroupMutationSubscriptionRead {
    const input = toGroupMutationSubscriptionReadInput(command);
    const [subscriptionTarget] = input.topicSubscriptions;
    const subscriptionKey = subscriptionTarget === undefined
        ? undefined
        : groupStateTopicSubscriptionStorageKey(
            command.aggregateRef,
            subscriptionTarget.sessionId,
            subscriptionTarget.topicId
        );
    const [clientSession] = read.clientSessions;
    const [principalSubscriptions] = read.principalSubscriptions;
    return {
        targetTopicSubscription: read.topicSubscriptions.find(({ identity }) => identity === subscriptionKey)?.entry ??
            null,
        targetClientSessions: readsTopicSubscriptionTarget(command) ? (clientSession?.entries ?? []) : null,
        targetPrincipalSubscriptions: input.subscriptionPrincipalIds.length === 0
            ? null
            : principalSubscriptions?.entries ?? []
    };
}
