import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    createAppInboxResourceEntry,
    createDefaultAppInboxQueueMessage
} from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { GroupMutationIdempotencyConflictError } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { toGroupCommandExclusionKey } from '@shared-server/rallar-system/group-state/inbox/to-group-command-exclusion-key.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateConditionalWriteResult } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import {
    applyPublicationMutation,
    GRANT_ROOM,
    seedGrantRoom,
    writeGrantRow
} from '../mutation/group-publication-grant-test-runtime.ts';
import {
    applySubscriptionMutation,
    readSubscriptionRow,
    SUBSCRIPTION_NOW_EPOCH_MS,
    writeClientSessionRow,
    type TopicSubscriptionDescriptorInput
} from '../mutation/group-topic-subscription-test-runtime.ts';

const BOB_SUBSCRIBE: TopicSubscriptionDescriptorInput = {
    operation: 'subscribeGroupTopic',
    actorPrincipalId: 'bob',
    topicId: 'room.feed',
    connectionGenerationId: 'bob-ws-generation-1',
    requestId: 'subscribe-bob-feed-generation-1'
};

/** Refuses the next subscription-row insert as a lost compare-and-set, as a concurrent writer would. */
class SubscriptionGuardConflictRepository extends GroupBarrierRepository {
    private subscriptionConflictsRemaining = 0;

    failNextSubscriptionInsert(count: number): void {
        this.subscriptionConflictsRemaining = count;
    }

    override async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        if (namespace === SUBSCRIPTIONS_NAMESPACE && this.subscriptionConflictsRemaining > 0) {
            this.subscriptionConflictsRemaining -= 1;
            return { status: 'conflict' };
        }
        return await super.insertIfAbsent(namespace, key, value, expireAtTimestamp);
    }
}

async function subscribableRoom<T extends GroupBarrierRepository>(runtime: T): Promise<T> {
    await seedGrantRoom(runtime);
    await writeGrantRow(runtime, 'bob', { 'room.feed': { publish: true, subscribe: true } });
    await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-1');
    return runtime;
}

describe('group topic subscription convergence', () => {
    it('a subscribe and a revoke of subscribe for one group share the aggregate exclusion key', () => {
        const subscribe = toEntry({
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_TOPIC_SUBSCRIBE,
            topicId: AppInboxType.GROUP_TOPIC_SUBSCRIBE,
            resourceId: 'subscribe-bob',
            contextId: 'caller=bob',
            data: { scope: SCOPE, groupId: GRANT_ROOM, sessionId: 'bob-session', request: {} }
        });
        const revoke = toEntry({
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_PUBLICATION_REVOKE,
            topicId: AppInboxType.GROUP_PUBLICATION_REVOKE,
            resourceId: 'revoke-bob',
            contextId: 'caller=alice',
            data: { scope: SCOPE, groupId: GRANT_ROOM, principalId: 'bob', request: {} }
        });

        expect(toGroupCommandExclusionKey(subscribe)).toBeDefined();
        expect(toGroupCommandExclusionKey(subscribe)).toBe(toGroupCommandExclusionKey(revoke));
    });

    it('a subscribe queued behind a revoke of subscribe is refused no-subscribe-grant and writes no row', async () => {
        const runtime = await subscribableRoom(new GroupBarrierRepository());
        await applyPublicationMutation(runtime, {
            operation: 'revokeGroupPublication',
            actorPrincipalId: 'alice',
            targetPrincipalId: 'bob',
            topicId: 'room.feed',
            publish: false,
            subscribe: true,
            requestId: 'revoke-bob-feed-subscribe-01'
        });

        await expect(applySubscriptionMutation(runtime, BOB_SUBSCRIBE)).rejects.toMatchObject({
            denial: { code: 'no-subscribe-grant' }
        });
        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toBeUndefined();
    });

    it('a CAS conflict injected at the subscription guard retries on a fresh read and converges', async () => {
        const runtime = await subscribableRoom(new SubscriptionGuardConflictRepository());
        runtime.failNextSubscriptionInsert(1);

        await expect(applySubscriptionMutation(runtime, BOB_SUBSCRIBE)).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );
        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toBeUndefined();
        const converged = await applySubscriptionMutation(runtime, BOB_SUBSCRIBE, { attemptCount: 2 });

        expect(converged).toMatchObject({ outcome: 'applied', attemptCount: 2, subscriptionOutcome: 'subscribed' });
        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toMatchObject({
            connectionGenerationId: 'bob-ws-generation-1'
        });
    });

    it('an idempotent replay returns the first outcome, renewed included', async () => {
        const runtime = await subscribableRoom(new GroupBarrierRepository());
        const renew = { ...BOB_SUBSCRIBE, requestId: 'renew-bob-feed-generation-1' };
        const later = { nowEpochMs: SUBSCRIPTION_NOW_EPOCH_MS + 20_000 };

        const subscribed = await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const renewed = await applySubscriptionMutation(runtime, renew, later);
        const renewedReplay = await applySubscriptionMutation(runtime, renew, later);
        const subscribedReplay = await applySubscriptionMutation(runtime, BOB_SUBSCRIBE, later);

        expect([subscribed, renewed].map((receipt) => receipt.subscriptionOutcome)).toEqual(['subscribed', 'renewed']);
        expect(renewedReplay).toEqual(renewed);
        expect(subscribedReplay).toEqual(subscribed);
    });

    it('a changed body under the same requestId is group-mutation-idempotency-conflict', async () => {
        const runtime = await subscribableRoom(new GroupBarrierRepository());
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);

        await expect(applySubscriptionMutation(runtime, { ...BOB_SUBSCRIBE, topicId: 'room.other' })).rejects.toMatchObject({
            code: 'group-mutation-idempotency-conflict'
        });
        await expect(applySubscriptionMutation(runtime, { ...BOB_SUBSCRIBE, topicId: 'room.other' })).rejects
            .toBeInstanceOf(GroupMutationIdempotencyConflictError);
    });
});

function toEntry(enqueue: AppInboxEnqueueInput): ResourceEntry {
    return createAppInboxResourceEntry(enqueue, 'server-1', {
        createMessage: createDefaultAppInboxQueueMessage,
        creationNow: Temporal.Now.instant
    });
}
