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
import { readGroupSessionTopicSubscriptions } from '@shared-server/rallar-system/group-state/persistence/subscription/read-group-topic-subscriptions.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateConditionalWriteResult } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';

import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
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
import { createService } from '../presence/group-presence-test-runtime.ts';

const BOB_SUBSCRIBE: TopicSubscriptionDescriptorInput = {
    operation: 'subscribeGroupTopic',
    actorPrincipalId: 'bob',
    topicId: 'room.feed',
    connectionGenerationId: 'bob-ws-generation-1',
    requestId: 'subscribe-bob-feed-generation-1'
};

const REVOKE_BOB_SUBSCRIBE = {
    operation: 'revokeGroupPublication',
    actorPrincipalId: 'alice',
    targetPrincipalId: 'bob',
    topicId: 'room.feed',
    publish: false,
    subscribe: true,
    requestId: 'revoke-bob-feed-subscribe-01'
} as const;

const RENEW_BOB_SUBSCRIBE: TopicSubscriptionDescriptorInput = { ...BOB_SUBSCRIBE, requestId: 'renew-bob-feed-after-race' };

const BOB_LEAVES = { status: 'left', actorPrincipalId: 'bob', requestId: 'leave-bob-racing-a-subscribe' } as const;

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

    // Exclusion keys order one server's flight only. Across servers a subscribe whose read preceded a revoke or a
    // departure may commit after it: the orphan lives at most its lease, its renewals are refused, and the next grant
    // of subscribe or activation of the member deletes it.
    it('a subscribe racing a revoke of subscribe leaves an orphan whose renewal is refused and which a re-grant deletes', async () => {
        const runtime = await subscribableRoom(new GroupBarrierRepository());
        await raceSubscribeAgainst(runtime, () => applyPublicationMutation(runtime, REVOKE_BOB_SUBSCRIBE));

        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toBeDefined();
        await expect(applySubscriptionMutation(runtime, RENEW_BOB_SUBSCRIBE)).rejects.toMatchObject({
            denial: { code: 'no-subscribe-grant' }
        });
        await applyPublicationMutation(runtime, { ...REVOKE_BOB_SUBSCRIBE, operation: 'grantGroupPublication', requestId: 'regrant-bob-feed-01' });

        expect(await readSessionSubscriptions(runtime)).toEqual([]);
    });

    it('a subscribe racing a leave leaves an orphan whose renewal is refused and which a rejoin deletes', async () => {
        const runtime = await subscribableRoom(new GroupBarrierRepository());
        await raceSubscribeAgainst(
            runtime,
            () => createService(runtime, 3_000).upsertMember(SCOPE, GRANT_ROOM, 'bob', BOB_LEAVES)
        );

        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toBeDefined();
        await expect(applySubscriptionMutation(runtime, RENEW_BOB_SUBSCRIBE)).rejects.toMatchObject({
            denial: { code: 'member-not-active' }
        });
        await createService(runtime, 3_000).joinGroup(SCOPE, GRANT_ROOM, { actorPrincipalId: 'bob', requestId: 'rejoin-bob-after-race' });

        expect(await readSessionSubscriptions(runtime)).toEqual([]);
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

        const conflict = await applySubscriptionMutation(runtime, { ...BOB_SUBSCRIBE, topicId: 'room.other' }).then(
            () => undefined,
            (error: Error) => error
        );

        expect(conflict).toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(conflict).toMatchObject({ code: 'group-mutation-idempotency-conflict' });
    });
});

function toEntry(enqueue: AppInboxEnqueueInput): ResourceEntry {
    return createAppInboxResourceEntry(enqueue, 'server-1', {
        createMessage: createDefaultAppInboxQueueMessage,
        creationNow: Temporal.Now.instant
    });
}

/** Holds the subscribe after its read, commits the racing command, then lets the stale subscribe commit. */
async function raceSubscribeAgainst(runtime: GroupBarrierRepository, racing: () => Promise<object>): Promise<void> {
    const held = runtime.holdNextGroupReadFor(groupStateGroupStorageKey(groupRef(GRANT_ROOM)));
    const subscribe = applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
    await held.firstArrival;
    await racing();
    held.release();
    expect(await subscribe).toMatchObject({ subscriptionOutcome: 'subscribed' });
}

async function readSessionSubscriptions(runtime: GroupBarrierRepository) {
    return await readGroupSessionTopicSubscriptions(runtime, {
        ref: groupRef(GRANT_ROOM),
        sessionId: 'bob-session',
        observedAtEpochMs: Date.now()
    });
}
