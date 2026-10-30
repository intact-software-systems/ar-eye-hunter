import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateTopicSubscriptionStorageKey } from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-storage-key.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import {
    GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { SubscribeGroupTopicRequest } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import type { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';
import { computeDescriptorMutation, GRANT_ROOM } from './group-publication-grant-test-runtime.ts';

/**
 * A subscription's store expiry is its lease, and the repository reads at the wall clock, so subscription tests run
 * their attempts at a wall-clock instant rather than the small seed clock.
 */
export const SUBSCRIPTION_NOW_EPOCH_MS = Date.now();

export type TopicSubscriptionOperation = 'subscribeGroupTopic' | 'unsubscribeGroupTopic';

export interface TopicSubscriptionDescriptorInput {
    readonly operation: TopicSubscriptionOperation;
    readonly actorPrincipalId: string;
    readonly topicId: string;
    readonly connectionGenerationId: string;
    readonly requestId: string;
    readonly sessionId?: string;
}

export function sessionIdOf(principalId: string): string {
    return `${principalId}-session`;
}

export function subscriptionRequest(input: TopicSubscriptionDescriptorInput): SubscribeGroupTopicRequest {
    return {
        topicId: input.topicId,
        connectionGenerationId: input.connectionGenerationId,
        actorPrincipalId: input.actorPrincipalId,
        requestId: input.requestId
    };
}

export function subscriptionDescriptor(input: TopicSubscriptionDescriptorInput): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: input.operation,
        scope: SCOPE,
        groupId: GRANT_ROOM,
        sessionId: input.sessionId ?? sessionIdOf(input.actorPrincipalId),
        request: subscriptionRequest(input)
    });
}

/** The read and compute phases of one subscription attempt, without its write. */
export async function computeSubscriptionMutation(
    runtime: GroupBarrierRepository,
    input: TopicSubscriptionDescriptorInput,
    nowEpochMs = SUBSCRIPTION_NOW_EPOCH_MS
) {
    return await computeDescriptorMutation(runtime, input.actorPrincipalId, subscriptionDescriptor(input), nowEpochMs);
}

export async function applySubscriptionMutation(
    runtime: GroupBarrierRepository,
    input: TopicSubscriptionDescriptorInput,
    options: Readonly<{ nowEpochMs?: number; attemptCount?: number; }> = {}
) {
    const service = createService(runtime, options.nowEpochMs ?? SUBSCRIPTION_NOW_EPOCH_MS, options.attemptCount);
    const sessionId = input.sessionId ?? sessionIdOf(input.actorPrincipalId);
    const request = subscriptionRequest(input);
    return input.operation === 'subscribeGroupTopic'
        ? await service.subscribeGroupTopicReceipt(SCOPE, GRANT_ROOM, sessionId, request)
        : await service.unsubscribeGroupTopicReceipt(SCOPE, GRANT_ROOM, sessionId, request);
}

/** An active client-state session row whose generation is the live WS connection generation. */
export async function writeClientSessionRow(
    runtime: GroupBarrierRepository,
    principalId: string,
    generationId: string,
    overrides: Partial<Pick<ClientSession, 'expiresAtEpochMs' | 'sessionId'>> = {}
): Promise<ClientSession> {
    const session: ClientSession = {
        ...SCOPE,
        principalId,
        clientInstanceId: `${principalId}-instance`,
        sessionId: overrides.sessionId ?? sessionIdOf(principalId),
        generationId,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: overrides.expiresAtEpochMs ?? SUBSCRIPTION_NOW_EPOCH_MS + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
    await runtime.upsert(
        CLIENT_STATE_SESSIONS_NAMESPACE,
        clientStateSessionStorageKey(session),
        JSON.stringify(session),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    return session;
}

export async function readSubscriptionRow(
    runtime: GroupBarrierRepository,
    sessionId: string,
    topicId: string
): Promise<GroupTopicSubscription | undefined> {
    const entry = await runtime.findEntry(
        SUBSCRIPTIONS_NAMESPACE,
        groupStateTopicSubscriptionStorageKey(groupRef(GRANT_ROOM), sessionId, topicId)
    );
    return entry === undefined || entry.expireAtTimestamp <= Date.now()
        ? undefined
        : JSON.parse(entry.value) as GroupTopicSubscription;
}

/** A live row as a subscribe at the wall clock would write it. */
export function subscriptionRowFor(principalId: string, sessionId: string, topicId: string): GroupTopicSubscription {
    return {
        sessionId,
        principalId,
        topicId,
        connectionGenerationId: `${sessionId}-ws-generation-1`,
        leaseExpiresAtEpochMs: SUBSCRIPTION_NOW_EPOCH_MS + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
        admittedAtGroupRevision: 1
    };
}

export async function writeSubscriptionRow(
    runtime: FakeRuntimeStateRepository,
    ref: GroupRef,
    subscription: GroupTopicSubscription
): Promise<string> {
    const key = groupStateTopicSubscriptionStorageKey(ref, subscription.sessionId, subscription.topicId);
    await runtime.upsert(SUBSCRIPTIONS_NAMESPACE, key, JSON.stringify(subscription), subscription.leaseExpiresAtEpochMs);
    return key;
}
