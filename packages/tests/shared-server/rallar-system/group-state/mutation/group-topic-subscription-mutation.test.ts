import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStateTopicSubscriptionStorageKey } from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-storage-key.ts';
import { GROUP_TOPIC_SUBSCRIPTION_LEASE_MS } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import { describe, expect, it } from 'vitest';

import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';
import { GRANT_ROOM, requireWrite, seedGrantRoom, writeGrantRow } from './group-publication-grant-test-runtime.ts';
import {
    applySubscriptionMutation,
    computeSubscriptionMutation,
    readSubscriptionRow,
    SUBSCRIPTION_NOW_EPOCH_MS,
    writeClientSessionRow,
    type TopicSubscriptionDescriptorInput
} from './group-topic-subscription-test-runtime.ts';

const BOB_SUBSCRIBE: TopicSubscriptionDescriptorInput = {
    operation: 'subscribeGroupTopic',
    actorPrincipalId: 'bob',
    topicId: 'room.feed',
    connectionGenerationId: 'bob-ws-generation-1',
    requestId: 'subscribe-bob-feed-generation-1'
};

const BOB_UNSUBSCRIBE: TopicSubscriptionDescriptorInput = {
    ...BOB_SUBSCRIBE,
    operation: 'unsubscribeGroupTopic',
    requestId: 'unsubscribe-bob-feed-generation-1'
};

/** bob holds subscribe on room.feed and a live client session at generation 1. */
async function subscribableRoom(): Promise<GroupBarrierRepository> {
    const runtime = new GroupBarrierRepository();
    await seedGrantRoom(runtime);
    await writeGrantRow(runtime, 'bob', { 'room.feed': { publish: true, subscribe: true } });
    await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-1');
    return runtime;
}

async function expectSubscribeDenial(
    runtime: GroupBarrierRepository,
    input: TopicSubscriptionDescriptorInput,
    code: string
): Promise<void> {
    const { computed } = await computeSubscriptionMutation(runtime, input);
    expect(computed, input.actorPrincipalId).toMatchObject({
        outcome: 'rejected',
        rejectionCode: 'group-policy-denied',
        policyDenial: { code }
    });
}

describe('group topic subscription mutation', () => {
    it('a first subscribe is subscribed with the server-derived lease and writes guard, receipt and nothing else', async () => {
        const runtime = await subscribableRoom();
        const { read, computed } = await computeSubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const write = requireWrite(computed);
        const group = read.group?.value;
        const subscription = {
            sessionId: 'bob-session',
            principalId: 'bob',
            topicId: 'room.feed',
            connectionGenerationId: 'bob-ws-generation-1',
            leaseExpiresAtEpochMs: SUBSCRIPTION_NOW_EPOCH_MS + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
            admittedAtGroupRevision: group?.snapshotVersion
        };

        expect(write.guard).toEqual({ kind: 'subscription', operation: 'insert', ref: groupRef(GRANT_ROOM), value: subscription });
        expect(write.persistence.guardedBatch.guard).toEqual({
            operation: 'insert',
            namespace: SUBSCRIPTIONS_NAMESPACE,
            key: groupStateTopicSubscriptionStorageKey(groupRef(GRANT_ROOM), 'bob-session', 'room.feed'),
            value: JSON.stringify(subscription),
            expireAtTimestamp: subscription.leaseExpiresAtEpochMs
        });
        expect(write.persistence.guardedBatch.effects.map((effect) => [effect.effectId, effect.operation])).toEqual([
            ['receipt', 'insert']
        ]);
        expect(write.event).toBeNull();
        expect(write.persistence.eventWrite).toBeNull();
        expect(write.outboxWrites).toEqual([]);
        expect(write.members).toEqual([]);
        expect(write.receipt).toMatchObject({
            outcome: 'applied',
            eventId: null,
            outboxIds: [],
            snapshotVersion: group?.snapshotVersion,
            subscriptionOutcome: 'subscribed'
        });
    });

    it('the same generation renews', async () => {
        const runtime = await subscribableRoom();
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const later = SUBSCRIPTION_NOW_EPOCH_MS + 20_000;
        const { read, computed } = await computeSubscriptionMutation(
            runtime,
            { ...BOB_SUBSCRIBE, requestId: 'renew-bob-feed-generation-1' },
            later
        );
        const write = requireWrite(computed);

        expect(write.guard).toMatchObject({
            kind: 'subscription',
            operation: 'update',
            expectedRevision: read.targetTopicSubscription?.entry.revision,
            value: { leaseExpiresAtEpochMs: later + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS }
        });
        expect(write.receipt.subscriptionOutcome).toBe('renewed');
    });

    it('a new generation replaces the row and is subscribed', async () => {
        const runtime = await subscribableRoom();
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-2');
        const { read, computed } = await computeSubscriptionMutation(runtime, {
            ...BOB_SUBSCRIBE,
            connectionGenerationId: 'bob-ws-generation-2',
            requestId: 'subscribe-bob-feed-generation-2'
        });
        const write = requireWrite(computed);

        expect(write.guard).toMatchObject({
            operation: 'update',
            expectedRevision: read.targetTopicSubscription?.entry.revision,
            value: { connectionGenerationId: 'bob-ws-generation-2' }
        });
        expect(write.receipt.subscriptionOutcome).toBe('subscribed');
    });

    it('no live client session is no-live-session', async () => {
        const runtime = new GroupBarrierRepository();
        await seedGrantRoom(runtime);
        await writeGrantRow(runtime, 'bob', { 'room.feed': { publish: false, subscribe: true } });
        await expectSubscribeDenial(runtime, BOB_SUBSCRIBE, 'no-live-session');

        await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-1', { expiresAtEpochMs: SUBSCRIPTION_NOW_EPOCH_MS });
        await expectSubscribeDenial(runtime, BOB_SUBSCRIBE, 'no-live-session');
    });

    it('a body generation other than the live session\'s is stale-generation', async () => {
        const runtime = await subscribableRoom();

        await expectSubscribeDenial(
            runtime,
            { ...BOB_SUBSCRIBE, connectionGenerationId: 'bob-ws-generation-0' },
            'stale-generation'
        );
    });

    it('a principal without effective subscribe is no-subscribe-grant', async () => {
        const runtime = await subscribableRoom();
        await writeGrantRow(runtime, 'erin', { 'room.feed': { publish: true, subscribe: false } });
        for (const principalId of ['carol', 'erin']) {
            await writeClientSessionRow(runtime, principalId, `${principalId}-ws-generation-1`);
            await expectSubscribeDenial(
                runtime,
                {
                    ...BOB_SUBSCRIBE,
                    actorPrincipalId: principalId,
                    connectionGenerationId: `${principalId}-ws-generation-1`,
                    requestId: `subscribe-${principalId}-feed-000001`
                },
                'no-subscribe-grant'
            );
        }
        await expectSubscribeDenial(runtime, { ...BOB_SUBSCRIBE, topicId: 'room.other' }, 'no-subscribe-grant');
    });

    it('a member that left is member-not-active', async () => {
        const runtime = await subscribableRoom();
        await writeGrantRow(runtime, 'lee', { 'room.feed': { publish: false, subscribe: true } });
        await writeClientSessionRow(runtime, 'lee', 'lee-ws-generation-1');

        await expectSubscribeDenial(
            runtime,
            {
                ...BOB_SUBSCRIBE,
                actorPrincipalId: 'lee',
                connectionGenerationId: 'lee-ws-generation-1',
                requestId: 'subscribe-lee-feed-000001'
            },
            'member-not-active'
        );
    });

    it('a spectator holding subscribe is subscribed', async () => {
        const runtime = await subscribableRoom();
        await writeGrantRow(runtime, 'sam', { 'room.feed': { publish: false, subscribe: true } });
        await writeClientSessionRow(runtime, 'sam', 'sam-ws-generation-1');
        const { computed } = await computeSubscriptionMutation(runtime, {
            ...BOB_SUBSCRIBE,
            actorPrincipalId: 'sam',
            connectionGenerationId: 'sam-ws-generation-1',
            requestId: 'subscribe-sam-feed-000001'
        });

        expect(requireWrite(computed).receipt.subscriptionOutcome).toBe('subscribed');
    });

    it('an archived group denies group-archived', async () => {
        const runtime = await subscribableRoom();
        await createService(runtime, 2_000).updateGroup(SCOPE, GRANT_ROOM, {
            status: 'archived',
            actorPrincipalId: 'alice',
            requestId: 'archive-grant-room-000001'
        });

        await expectSubscribeDenial(runtime, BOB_SUBSCRIBE, 'group-archived');
    });

    it('an unsubscribe of the asserting generation deletes the row and is unsubscribed', async () => {
        const runtime = await subscribableRoom();
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const { read, computed } = await computeSubscriptionMutation(runtime, BOB_UNSUBSCRIBE);
        const write = requireWrite(computed);

        expect(write.guard).toMatchObject({
            kind: 'subscription',
            operation: 'delete',
            expectedRevision: read.targetTopicSubscription?.entry.revision
        });
        expect(write.persistence.guardedBatch.guard).toMatchObject({ operation: 'delete', namespace: SUBSCRIPTIONS_NAMESPACE });
        expect(write.receipt).toMatchObject({ outcome: 'applied', eventId: null, subscriptionOutcome: 'unsubscribed' });
        await applySubscriptionMutation(runtime, BOB_UNSUBSCRIBE);
        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toBeUndefined();
    });

    it('an unsubscribe asserting another generation is not-subscribed and keeps the row', async () => {
        const runtime = await subscribableRoom();
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const stale = { ...BOB_UNSUBSCRIBE, connectionGenerationId: 'bob-ws-generation-0' };
        const { computed } = await computeSubscriptionMutation(runtime, stale);

        expect(computed).toMatchObject({ outcome: 'no-op', receipt: { outcome: 'no-op', subscriptionOutcome: 'not-subscribed' } });
        expect(await applySubscriptionMutation(runtime, stale)).toMatchObject({ subscriptionOutcome: 'not-subscribed' });
        expect(await readSubscriptionRow(runtime, 'bob-session', 'room.feed')).toMatchObject({
            connectionGenerationId: 'bob-ws-generation-1'
        });
    });

    it('an unsubscribe without a row or without a live session is not-subscribed', async () => {
        const runtime = await subscribableRoom();
        const withoutRow = await computeSubscriptionMutation(runtime, BOB_UNSUBSCRIBE);
        await applySubscriptionMutation(runtime, BOB_SUBSCRIBE);
        await writeClientSessionRow(runtime, 'bob', 'bob-ws-generation-1', { expiresAtEpochMs: SUBSCRIPTION_NOW_EPOCH_MS });
        const withoutSession = await computeSubscriptionMutation(runtime, BOB_UNSUBSCRIBE);

        for (const { computed } of [withoutRow, withoutSession]) {
            expect(computed).toMatchObject({ outcome: 'no-op', receipt: { subscriptionOutcome: 'not-subscribed' } });
        }
    });

    it('validate refuses a computed subscribe whose lease was altered', async () => {
        const runtime = await subscribableRoom();
        const { command, read, computed } = await computeSubscriptionMutation(runtime, BOB_SUBSCRIBE);
        const write = requireWrite(computed);
        if (write.guard.kind !== 'subscription') {
            throw new Error('Expected a subscription guard');
        }
        const altered = {
            ...write,
            guard: { ...write.guard, value: { ...write.guard.value, leaseExpiresAtEpochMs: Number.MAX_SAFE_INTEGER } }
        };

        expect(validateGroupMutation({ command: command.command, read, facts: command.facts, computed: write })).toEqual([]);
        expect(validateGroupMutation({ command: command.command, read, facts: command.facts, computed: altered }))
            .not.toEqual([]);
    });
});
