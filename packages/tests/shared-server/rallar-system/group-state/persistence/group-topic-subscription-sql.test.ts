import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { CLIENT_STATE_SESSIONS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '@shared-server/rallar-system/client-state/persistence/client-state-session-storage-key.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor, GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { GroupMutationComputed } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { SUBSCRIPTIONS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { readGroupStateSnapshotVersions } from '@shared-server/rallar-system/group-state/persistence/read-group-state-authority.ts';
import { groupStateTopicSubscriptionStorageKey } from '@shared-server/rallar-system/group-state/persistence/subscription/group-topic-subscription-storage-key.ts';
import { readGroupSessionTopicSubscriptions } from '@shared-server/rallar-system/group-state/persistence/subscription/read-group-topic-subscriptions.ts';
import { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import {
    GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
    type GroupTopicSubscription
} from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestBackend } from '../../../queuebox/resource-inbox-test-storage.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

const REF: GroupRef = { applicationId: 'subscription-app', workspaceId: 'subscription-workspace', groupId: 'subscription-room' };
const GENERATION = 'bob-ws-generation-1';

interface SubscriptionSqlFixture {
    readonly sql: PSqlSql;
    readonly runtime: PSqlRuntimeStateRepository;
    readonly repository: GroupStateRepository;
    readonly mutations: GroupStateService;
    readonly nowEpochMs: number;
}

describe.each(['memory', 'postgres'] as const)('group topic subscription rows (%s)', (backend) => {
    const sqlIt = backend === 'postgres' && process.env.RALLAR_POSTGRES_INTEGRATION !== '1' ? it.skip : it;

    sqlIt('a subscribe writes the row with its lease as the store expiry and no event row', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            const eventsBefore = await fixture.repository.listEvents(REF);
            const snapshotBefore = await fixture.repository.readSnapshot(REF);

            await runMutation(fixture, subscribeDescriptor('room.feed', 'subscribe-bob-feed-000001'));

            const entry = await fixture.runtime.findEntry(SUBSCRIPTIONS_NAMESPACE, subscriptionKey('room.feed'));
            expect(entry?.expireAtTimestamp).toBe(fixture.nowEpochMs + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS);
            expect(JSON.parse(entry?.value ?? 'null')).toMatchObject({ sessionId: 'bob-session', connectionGenerationId: GENERATION });
            expect(await fixture.repository.listEvents(REF)).toEqual(eventsBefore);
            expect((await fixture.repository.readSnapshot(REF))?.group).toEqual(snapshotBefore?.group);
        });
    }, 30_000);

    sqlIt('a renewal leaves the group\'s version probe and the cached snapshot untouched', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            await runMutation(fixture, subscribeDescriptor('room.feed', 'subscribe-bob-feed-before-renew'));
            const current = new GroupStateCurrentSnapshotCache({
                repository: fixture.repository,
                versionReader: fixture.runtime,
                nowEpochMs: () => fixture.nowEpochMs,
                maxEntries: 4
            });
            const [probeBefore] = await readGroupStateSnapshotVersions(fixture.runtime, [REF], fixture.nowEpochMs);
            const cachedBefore = await current.readSnapshot(REF);

            const renewal = await runMutation(fixture, subscribeDescriptor('room.feed', 'renew-bob-feed-after-subscribe'));

            expect(renewal).toMatchObject({ receipt: { subscriptionOutcome: 'renewed' } });
            expect(await readGroupStateSnapshotVersions(fixture.runtime, [REF], fixture.nowEpochMs)).toEqual([probeBefore]);
            expect(await current.readSnapshot(REF)).toBe(cachedBefore);
        });
    }, 30_000);

    sqlIt('a lapsed row reads as absent and a later subscribe inserts over it', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            await writeSubscriptionRow(fixture, { ...subscriptionFor('room.feed'), leaseExpiresAtEpochMs: fixture.nowEpochMs - 1_000 });
            const lapsed = await fixture.runtime.findEntry(SUBSCRIPTIONS_NAMESPACE, subscriptionKey('room.feed'));

            const computed = await runMutation(fixture, subscribeDescriptor('room.feed', 'subscribe-bob-over-lapsed-1'));

            expect(computed).toMatchObject({ guard: { operation: 'insert' }, receipt: { subscriptionOutcome: 'subscribed' } });
            const replaced = await fixture.runtime.findEntry(SUBSCRIPTIONS_NAMESPACE, subscriptionKey('room.feed'));
            expect(replaced?.revision).toBe((lapsed?.revision ?? 0) + 1);
            expect(replaced?.expireAtTimestamp).toBe(fixture.nowEpochMs + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS);
        });
    }, 30_000);

    sqlIt('readGroupSessionTopicSubscriptions lists the session\'s live rows in topic order', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            const live = ['room.zed', 'app.scores', 'room.feed'].map(subscriptionFor);
            for (const subscription of live) {
                await writeSubscriptionRow(fixture, subscription);
            }
            await writeSubscriptionRow(fixture, { ...subscriptionFor('room.old'), leaseExpiresAtEpochMs: fixture.nowEpochMs - 1 });
            await writeSubscriptionRow(fixture, { ...subscriptionFor('room.feed'), sessionId: 'bob-session-2' });

            const rows = await readGroupSessionTopicSubscriptions(fixture.runtime, {
                ref: REF,
                sessionId: 'bob-session',
                observedAtEpochMs: fixture.nowEpochMs
            });

            expect(rows.map((row) => row.topicId)).toEqual(['app.scores', 'room.feed', 'room.zed']);
        });
    }, 30_000);

    sqlIt('retirement reads the group\'s subscription rows as room-owned', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            await writeSubscriptionRow(fixture, subscriptionFor('room.feed'));

            const entries = await fixture.repository.readRetirementEntries(REF);

            expect(entries.filter((entry) => entry.namespace === SUBSCRIPTIONS_NAMESPACE).map(({ entry }) => entry.key))
                .toEqual([subscriptionKey('room.feed')]);
        });
    }, 30_000);

    sqlIt('a corrupt subscription row fails the mutation read closed', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            await fixture.runtime.upsert(
                SUBSCRIPTIONS_NAMESPACE,
                subscriptionKey('room.feed'),
                JSON.stringify({ ...subscriptionFor('room.feed'), sessionId: 'someone-else' }),
                fixture.nowEpochMs + 60_000
            );

            await expect(runMutation(fixture, subscribeDescriptor('room.feed', 'subscribe-bob-corrupt-row1')))
                .rejects.toBeInstanceOf(GroupStateRepositoryInvariantCorruptionError);
        });
    }, 30_000);

    sqlIt('a client session row failing its contract fails the mutation read closed', async () => {
        await withSubscriptionSql(backend, async (fixture) => {
            await seedSubscribableRoom(fixture);
            await writeClientSession(fixture, { ...clientSessionFor(fixture), generationVersion: -1 });

            await expect(runMutation(fixture, subscribeDescriptor('room.feed', 'subscribe-bob-corrupt-session')))
                .rejects.toBeInstanceOf(GroupStateRepositoryInvariantCorruptionError);
        });
    }, 30_000);
});

function subscriptionFor(topicId: string): GroupTopicSubscription {
    return {
        sessionId: 'bob-session',
        principalId: 'bob',
        topicId,
        connectionGenerationId: GENERATION,
        leaseExpiresAtEpochMs: Date.now() + GROUP_TOPIC_SUBSCRIPTION_LEASE_MS,
        admittedAtGroupRevision: 2
    };
}

function subscriptionKey(topicId: string): string {
    return groupStateTopicSubscriptionStorageKey(REF, 'bob-session', topicId);
}

async function writeSubscriptionRow(fixture: SubscriptionSqlFixture, subscription: GroupTopicSubscription): Promise<void> {
    await fixture.runtime.upsert(
        SUBSCRIPTIONS_NAMESPACE,
        groupStateTopicSubscriptionStorageKey(REF, subscription.sessionId, subscription.topicId),
        JSON.stringify(subscription),
        subscription.leaseExpiresAtEpochMs
    );
}

function clientSessionFor(fixture: SubscriptionSqlFixture): ClientSession {
    return {
        applicationId: REF.applicationId,
        workspaceId: REF.workspaceId,
        principalId: 'bob',
        clientInstanceId: 'bob-instance',
        sessionId: 'bob-session',
        generationId: GENERATION,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: fixture.nowEpochMs,
        connectedAtEpochMs: fixture.nowEpochMs,
        lastHeartbeatAtEpochMs: fixture.nowEpochMs,
        expiresAtEpochMs: fixture.nowEpochMs + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

async function writeClientSession(fixture: SubscriptionSqlFixture, session: ClientSession): Promise<void> {
    await fixture.runtime.upsert(
        CLIENT_STATE_SESSIONS_NAMESPACE,
        clientStateSessionStorageKey(session),
        JSON.stringify(session),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
}

/** alice owns the room; bob is a member holding subscribe on room.feed with a live client session. */
async function seedSubscribableRoom(fixture: SubscriptionSqlFixture): Promise<void> {
    await runMutation(
        fixture,
        mutationDescriptor({
            operation: 'createGroup',
            scope: REF,
            groupId: REF.groupId,
            request: {
                groupId: REF.groupId,
                displayName: 'Subscription room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                actorPrincipalId: 'alice',
                requestId: 'create-subscription-room-01'
            }
        })
    );
    await runMutation(
        fixture,
        mutationDescriptor({
            operation: 'joinGroup',
            scope: REF,
            groupId: REF.groupId,
            request: { actorPrincipalId: 'bob', requestId: 'join-bob-subscription-room-1' }
        })
    );
    await runMutation(
        fixture,
        mutationDescriptor({
            operation: 'grantGroupPublication',
            scope: REF,
            groupId: REF.groupId,
            targetPrincipalId: 'bob',
            request: {
                topicId: 'room.feed',
                publish: false,
                subscribe: true,
                actorPrincipalId: 'alice',
                requestId: 'grant-bob-feed-subscribe-01'
            }
        })
    );
    await writeClientSession(fixture, clientSessionFor(fixture));
}

function subscribeDescriptor(topicId: string, requestId: string): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: 'subscribeGroupTopic',
        scope: REF,
        groupId: REF.groupId,
        sessionId: 'bob-session',
        request: { topicId, connectionGenerationId: GENERATION, actorPrincipalId: 'bob', requestId }
    });
}

async function runMutation(
    fixture: SubscriptionSqlFixture,
    descriptor: GroupMutationDescriptor
): Promise<GroupMutationComputed> {
    const principalId = descriptor.request.actorPrincipalId ?? 'alice';
    const session = createTestAuthSession(principalId);
    await new AuthSessionRepository(fixture.runtime).putSession(session);
    const ingress = await fixture.mutations.captureMutationIngress(descriptor, session);
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: fixture.nowEpochMs,
            traceId: 'trace-group-topic-subscription-sql'
        })
    };
    const read = await fixture.mutations.read(command);
    const computed = fixture.mutations.compute(command, read);
    expect(fixture.mutations.validate(command, read, computed)).toEqual([]);
    if (computed.outcome !== 'write') {
        throw new Error(`Expected a ${descriptor.operation} write, received ${computed.outcome}`);
    }
    await fixture.sql.begin((transaction) => fixture.mutations.write(transaction, computed));
    return computed;
}

async function withSubscriptionSql(
    backend: ResourceInboxTestBackend,
    run: (fixture: SubscriptionSqlFixture) => Promise<void>
): Promise<void> {
    const storage = await createResourceInboxTestStorage('topic_subscriptions', 2, backend);
    try {
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const events = new PSqlGroupStateEventRepository(storage.sql);
        const nowEpochMs = Date.now();
        const mutations = createGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStore: events,
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null,
            serviceId: 'subscription-sql-test',
            now: () => nowEpochMs
        });
        await run({ sql: storage.sql, runtime, repository: new GroupStateRepository(runtime, events), mutations, nowEpochMs });
    }
    finally {
        await storage.close();
    }
}
