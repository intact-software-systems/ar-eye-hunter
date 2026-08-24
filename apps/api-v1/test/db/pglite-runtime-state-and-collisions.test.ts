import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import assert from 'node:assert/strict';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { ClientStateEventCollisionError } from '@shared-server/rallar-system/state-events/client-state-event-store.ts';
import type { GroupTopologyConfigMutationCommand } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyAppInboxRequestPayload } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createGroupTopologyOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import {
    isRuntimeStateGuardedBatchRepositoryLike,
    type RuntimeStateGuardedBatch,
    type RuntimeStateGuardedBatchResult
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientEvent } from '@shared/api/client-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { toResilienceDto } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { createPGliteClientEventCollisionFixture } from './pglite-client-event-collision-test-runtime.ts';
import { requireTopologyMutationOwners, submitPGliteTopologyCommand, topologyGroupSnapshot, topologyOverrideCommand } from './pglite-topology-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');

interface RuntimeStateExpiryRow {
    readonly store_key: string;
    readonly expire_at_ts: string;
}

interface ResourceInboxAttemptStatusRow {
    readonly ri_attempts: string | number;
    readonly ri_status: string;
}

interface ResourceInboxPayloadRow {
    readonly ri_resource: string;
}

Deno.test(
    'PGlite client write rejects a divergent event collision and rolls back the aggregate',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteClientEventCollisionFixture(sql, 'collision');
            const divergentEvent: ClientEvent = {
                ...fixture.computed.event,
                reason: 'pre-existing divergent event body'
            };
            await fixture.events.appendClientEvent(divergentEvent);
            const eventsBeforeWrite = await fixture.events.listClientEvents({
                ...fixture.scope,
                principalId: fixture.principalId
            });

            let collisionError: Error | null = null;
            try {
                await sql.begin(async (transaction) => {
                    await fixture.service.write(transaction, fixture.computed);
                });
            }
            catch (error) {
                collisionError = error instanceof Error ? error : new Error(String(error));
            }

            const outbox = createPSqlResourceInboxRepository(sql);
            assert.deepEqual(
                {
                    isTypedCollision: collisionError instanceof ClientStateEventCollisionError,
                    errorName: collisionError instanceof Error ? collisionError.name : null,
                    errorCode: collisionError instanceof Error && 'code' in collisionError
                        ? collisionError.code
                        : null,
                    errorStatus: collisionError instanceof Error && 'status' in collisionError
                        ? collisionError.status
                        : null,
                    snapshot: await fixture.repository.readSnapshot({
                        ...fixture.scope,
                        principalId: fixture.principalId
                    }),
                    instance: await fixture.repository.findInstance({
                        ...fixture.scope,
                        principalId: fixture.principalId,
                        clientInstanceId: fixture.clientInstanceId
                    }) ?? null,
                    receipt: await fixture.repository.findIdempotentClientMutationReceipt(
                        { ...fixture.scope, principalId: fixture.principalId },
                        fixture.requestId
                    ) ?? null,
                    outbox: await Promise.all(
                        fixture.computed.outboxEntries.map((entry) => outbox.entries.findByKey(entry.key))
                    ),
                    events: await fixture.events.listClientEvents({
                        ...fixture.scope,
                        principalId: fixture.principalId
                    })
                },
                {
                    isTypedCollision: true,
                    errorName: 'ClientStateEventCollisionError',
                    errorCode: 'client-state-event-collision',
                    errorStatus: 409,
                    snapshot: fixture.before,
                    instance: null,
                    receipt: null,
                    outbox: fixture.computed.outboxEntries.map(() => null),
                    events: eventsBeforeWrite
                }
            );
        });
    }
);

Deno.test(
    'PGlite client write accepts an identical pre-existing event and commits once',
    async () => {
        await withPGliteSql(async (sql) => {
            const fixture = await createPGliteClientEventCollisionFixture(sql, 'replay');
            await fixture.events.appendClientEvent(fixture.computed.event);
            await sql.begin(async (transaction) => {
                await fixture.service.write(transaction, fixture.computed);
            });

            const snapshot = await fixture.repository.readSnapshot({
                ...fixture.scope,
                principalId: fixture.principalId
            });
            assert.equal(snapshot?.instances.length, 1);
            assert.equal(snapshot?.instances[0]?.clientInstanceId, fixture.clientInstanceId);
            assert.ok(fixture.computed.idempotency);
            assert.deepEqual(
                await fixture.repository.findIdempotentClientMutationReceipt(
                    { ...fixture.scope, principalId: fixture.principalId },
                    fixture.requestId
                ),
                fixture.computed.idempotency
            );
            const storedEvents = await fixture.events.listClientEvents({
                ...fixture.scope,
                principalId: fixture.principalId
            });
            assert.equal(
                storedEvents.filter((event) => event.eventId === fixture.computed.event.eventId).length,
                1
            );
            assert.deepEqual(
                storedEvents.find((event) => event.eventId === fixture.computed.event.eventId),
                fixture.computed.event
            );
            const outbox = createPSqlResourceInboxRepository(sql);
            for (const entry of fixture.computed.outboxEntries) {
                assert.equal((await outbox.entries.findByKey(entry.key))?.typeId, 'WS_OUTBOX');
            }
        });
    }
);

Deno.test(
    'guarded runtime-state batch applies every guard and effect operation with exact results',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = new PSqlRuntimeStateRepository(sql);
            await repository.insertIfAbsent(
                'guarded-effect',
                'update',
                'before-update',
                FUTURE_MS
            );
            await repository.insertIfAbsent(
                'guarded-effect',
                'delete',
                'before-delete',
                FUTURE_MS
            );
            await repository.insertIfAbsent(
                'guarded-effect',
                'put',
                'before-put',
                FUTURE_MS
            );

            const insertBatch: RuntimeStateGuardedBatch = {
                guard: {
                    operation: 'insert',
                    namespace: 'guarded-root',
                    key: 'root',
                    value: 'inserted-root',
                    expireAtTimestamp: FUTURE_MS
                },
                effects: [{
                    effectId: 'insert',
                    operation: 'insert',
                    namespace: 'guarded-effect',
                    key: 'insert',
                    value: 'inserted-effect',
                    expireAtTimestamp: FUTURE_MS
                }, {
                    effectId: 'update',
                    operation: 'update',
                    namespace: 'guarded-effect',
                    key: 'update',
                    expectedRevision: 0,
                    value: 'updated-effect',
                    expireAtTimestamp: FUTURE_MS
                }, {
                    effectId: 'delete',
                    operation: 'delete',
                    namespace: 'guarded-effect',
                    key: 'delete',
                    expectedRevision: 0
                }, {
                    effectId: 'put',
                    operation: 'put',
                    namespace: 'guarded-effect',
                    key: 'put',
                    value: 'put-effect',
                    expireAtTimestamp: FUTURE_MS
                }]
            };

            const insertResult = await repository.begin(async (transactionRepository) => {
                assert.equal(
                    isRuntimeStateGuardedBatchRepositoryLike(transactionRepository),
                    true
                );
                if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                    throw new Error('Expected guarded runtime-state batch capability.');
                }
                return await transactionRepository.executeGuardedBatch(insertBatch);
            });

            assert.deepEqual(insertResult, {
                guard: {
                    status: 'applied',
                    operation: 'insert',
                    namespace: 'guarded-root',
                    key: 'root',
                    resultingRevision: 0
                },
                effects: [{
                    status: 'applied',
                    effectId: 'insert',
                    operation: 'insert',
                    namespace: 'guarded-effect',
                    key: 'insert',
                    resultingRevision: 0
                }, {
                    status: 'applied',
                    effectId: 'update',
                    operation: 'update',
                    namespace: 'guarded-effect',
                    key: 'update',
                    resultingRevision: 1
                }, {
                    status: 'applied',
                    effectId: 'delete',
                    operation: 'delete',
                    namespace: 'guarded-effect',
                    key: 'delete',
                    matchedRevision: 0
                }, {
                    status: 'applied',
                    effectId: 'put',
                    operation: 'put',
                    namespace: 'guarded-effect',
                    key: 'put',
                    resultingRevision: 1
                }]
            });
            assert.equal(
                (await repository.findEntry('guarded-effect', 'insert'))?.value,
                'inserted-effect'
            );
            const updatedEffect = await repository.findEntry('guarded-effect', 'update');
            assert.equal(updatedEffect?.value, 'updated-effect');
            assert.equal(updatedEffect?.revision, 1);
            assert.equal(await repository.findEntry('guarded-effect', 'delete'), undefined);
            const putEffect = await repository.findEntry('guarded-effect', 'put');
            assert.equal(putEffect?.value, 'put-effect');
            assert.equal(putEffect?.revision, 1);

            const updateBatch: RuntimeStateGuardedBatch = {
                guard: {
                    operation: 'update',
                    namespace: 'guarded-root',
                    key: 'root',
                    expectedRevision: 0,
                    value: 'updated-root',
                    expireAtTimestamp: FUTURE_MS
                },
                effects: [{
                    effectId: 'after-update',
                    operation: 'insert',
                    namespace: 'guarded-effect',
                    key: 'after-update',
                    value: 'after-update',
                    expireAtTimestamp: FUTURE_MS
                }]
            };
            assert.deepEqual(
                await repository.begin(async (transactionRepository) => {
                    if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                        throw new Error('Expected guarded runtime-state batch capability.');
                    }
                    return await transactionRepository.executeGuardedBatch(updateBatch);
                }),
                {
                    guard: {
                        status: 'applied',
                        operation: 'update',
                        namespace: 'guarded-root',
                        key: 'root',
                        resultingRevision: 1
                    },
                    effects: [{
                        status: 'applied',
                        effectId: 'after-update',
                        operation: 'insert',
                        namespace: 'guarded-effect',
                        key: 'after-update',
                        resultingRevision: 0
                    }]
                }
            );

            const deleteBatch: RuntimeStateGuardedBatch = {
                guard: {
                    operation: 'delete',
                    namespace: 'guarded-root',
                    key: 'root',
                    expectedRevision: 1
                },
                effects: [{
                    effectId: 'after-delete',
                    operation: 'insert',
                    namespace: 'guarded-effect',
                    key: 'after-delete',
                    value: 'after-delete',
                    expireAtTimestamp: FUTURE_MS
                }]
            };
            assert.deepEqual(
                await repository.begin(async (transactionRepository) => {
                    if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                        throw new Error('Expected guarded runtime-state batch capability.');
                    }
                    return await transactionRepository.executeGuardedBatch(deleteBatch);
                }),
                {
                    guard: {
                        status: 'applied',
                        operation: 'delete',
                        namespace: 'guarded-root',
                        key: 'root',
                        matchedRevision: 1
                    },
                    effects: [{
                        status: 'applied',
                        effectId: 'after-delete',
                        operation: 'insert',
                        namespace: 'guarded-effect',
                        key: 'after-delete',
                        resultingRevision: 0
                    }]
                }
            );
            assert.equal(await repository.findEntry('guarded-root', 'root'), undefined);
        });
    }
);

Deno.test(
    'guarded runtime-state batch guard conflict skips every effect without writes',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = new PSqlRuntimeStateRepository(sql);
            await repository.insertIfAbsent('guarded-miss', 'root', 'winner', FUTURE_MS);
            await repository.insertIfAbsent('guarded-miss', 'put-target', 'before', FUTURE_MS);
            const batch: RuntimeStateGuardedBatch = {
                guard: {
                    operation: 'insert',
                    namespace: 'guarded-miss',
                    key: 'root',
                    value: 'loser',
                    expireAtTimestamp: FUTURE_MS
                },
                effects: [{
                    effectId: 'insert',
                    operation: 'insert',
                    namespace: 'guarded-miss',
                    key: 'insert-target',
                    value: 'must-not-exist',
                    expireAtTimestamp: FUTURE_MS
                }, {
                    effectId: 'put',
                    operation: 'put',
                    namespace: 'guarded-miss',
                    key: 'put-target',
                    value: 'must-not-change',
                    expireAtTimestamp: FUTURE_MS
                }]
            };

            const result = await repository.begin(async (transactionRepository) => {
                if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                    throw new Error('Expected guarded runtime-state batch capability.');
                }
                return await transactionRepository.executeGuardedBatch(batch);
            });

            assert.deepEqual(result, {
                guard: {
                    status: 'conflict',
                    operation: 'insert',
                    namespace: 'guarded-miss',
                    key: 'root',
                    reason: 'condition-not-met'
                },
                effects: [{
                    status: 'skipped',
                    effectId: 'insert',
                    operation: 'insert',
                    namespace: 'guarded-miss',
                    key: 'insert-target',
                    reason: 'guard-conflict'
                }, {
                    status: 'skipped',
                    effectId: 'put',
                    operation: 'put',
                    namespace: 'guarded-miss',
                    key: 'put-target',
                    reason: 'guard-conflict'
                }]
            });
            assert.equal(await repository.findEntry('guarded-miss', 'insert-target'), undefined);
            const unchangedPut = await repository.findEntry('guarded-miss', 'put-target');
            assert.equal(unchangedPut?.value, 'before');
            assert.equal(unchangedPut?.revision, 0);
        });
    }
);

Deno.test(
    'guarded runtime-state batch preserves sequential physical expiry exactly',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = new PSqlRuntimeStateRepository(sql);
            const fractionalEpochMs = 1_234.75;
            await repository.insertIfAbsent(
                'guarded-expiry',
                'sequential-future',
                'future',
                FUTURE_MS
            );
            await repository.insertIfAbsent(
                'guarded-expiry',
                'sequential-fractional',
                'fractional',
                fractionalEpochMs
            );

            await repository.begin(async (transactionRepository) => {
                if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                    throw new Error('Expected guarded runtime-state batch capability.');
                }
                await transactionRepository.executeGuardedBatch({
                    guard: {
                        operation: 'insert',
                        namespace: 'guarded-expiry',
                        key: 'guarded-future',
                        value: 'future',
                        expireAtTimestamp: FUTURE_MS
                    },
                    effects: [{
                        effectId: 'fractional',
                        operation: 'insert',
                        namespace: 'guarded-expiry',
                        key: 'guarded-fractional',
                        value: 'fractional',
                        expireAtTimestamp: fractionalEpochMs
                    }]
                });
            });

            const rows = await sql<RuntimeStateExpiryRow[]>`
        select store_key, expire_at_ts::text as expire_at_ts
        from runtime_state_store
        where store_namespace = ${'guarded-expiry'}
        order by store_key
      `;
            const expiryByKey = new Map(
                rows.map((row) => [row.store_key, row.expire_at_ts])
            );
            assert.equal(
                expiryByKey.get('guarded-future'),
                expiryByKey.get('sequential-future')
            );
            assert.equal(
                expiryByKey.get('guarded-fractional'),
                expiryByKey.get('sequential-fractional')
            );
        });
    }
);

Deno.test(
    'guarded runtime-state batch rolls back applied siblings when a conditional effect conflicts',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = new PSqlRuntimeStateRepository(sql);
            await repository.insertIfAbsent('guarded-rollback', 'root', 'before', FUTURE_MS);
            let observedResult: RuntimeStateGuardedBatchResult | undefined;

            await assert.rejects(
                async () => {
                    await repository.begin(async (transactionRepository) => {
                        if (!isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)) {
                            throw new Error('Expected guarded runtime-state batch capability.');
                        }
                        observedResult = await transactionRepository.executeGuardedBatch({
                            guard: {
                                operation: 'update',
                                namespace: 'guarded-rollback',
                                key: 'root',
                                expectedRevision: 0,
                                value: 'after',
                                expireAtTimestamp: FUTURE_MS
                            },
                            effects: [{
                                effectId: 'sibling',
                                operation: 'insert',
                                namespace: 'guarded-rollback',
                                key: 'sibling',
                                value: 'inserted',
                                expireAtTimestamp: FUTURE_MS
                            }, {
                                effectId: 'conflict',
                                operation: 'update',
                                namespace: 'guarded-rollback',
                                key: 'missing',
                                expectedRevision: 0,
                                value: 'never',
                                expireAtTimestamp: FUTURE_MS
                            }]
                        });
                        assert.deepEqual(observedResult.effects.map((effect) => effect.status), [
                            'applied',
                            'conflict'
                        ]);
                        throw new Error('roll back guarded batch conflict');
                    });
                },
                /roll back guarded batch conflict/u
            );

            assert.deepEqual(observedResult, {
                guard: {
                    status: 'applied',
                    operation: 'update',
                    namespace: 'guarded-rollback',
                    key: 'root',
                    resultingRevision: 1
                },
                effects: [{
                    status: 'applied',
                    effectId: 'sibling',
                    operation: 'insert',
                    namespace: 'guarded-rollback',
                    key: 'sibling',
                    resultingRevision: 0
                }, {
                    status: 'conflict',
                    effectId: 'conflict',
                    operation: 'update',
                    namespace: 'guarded-rollback',
                    key: 'missing',
                    reason: 'condition-not-met'
                }]
            });
            const rolledBackGuard = await repository.findEntry('guarded-rollback', 'root');
            assert.equal(rolledBackGuard?.value, 'before');
            assert.equal(rolledBackGuard?.revision, 0);
            assert.equal(await repository.findEntry('guarded-rollback', 'sibling'), undefined);
        });
    }
);

Deno.test('PSqlRuntimeStateRepository generic expiry preserves protected namespaces', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlRuntimeStateRepository(sql);
        const protectedNamespaces = [
            'rtc-rtt:receipts',
            'test:second-protected-family'
        ];
        await repository.upsert(protectedNamespaces[0], 'receipt', '{}', PAST_MS);
        await repository.upsert(protectedNamespaces[1], 'intent', '{}', PAST_MS);
        await repository.upsert('ordinary-expired', 'row', '{}', PAST_MS);

        assert.equal(await repository.deleteAllExpired(protectedNamespaces), 1);
        assert.notEqual(
            await repository.findEntry(protectedNamespaces[0], 'receipt'),
            undefined
        );
        assert.notEqual(
            await repository.findEntry(protectedNamespaces[1], 'intent'),
            undefined
        );
        assert.equal(await repository.findEntry('ordinary-expired', 'row'), undefined);
    });
});

Deno.test(
    'PGlite AppGroup retries topology CAS conflicts and commits receipts and outboxes',
    async () => {
        await withPGliteSql(async (sql) => {
            const nowEpochMs = Date.parse('2026-07-23T00:00:00.000Z');
            const runtime = new PSqlRuntimeStateRepository(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            let retryReleaseCount = 0;
            class RetryObservedQueueBox extends PSqlQueueBox {
                override async releaseEntries(
                    ...args: Parameters<PSqlQueueBox['releaseEntries']>
                ): ReturnType<PSqlQueueBox['releaseEntries']> {
                    const released = await super.releaseEntries(...args);
                    if (args[1].status === EntityStatus.RETRY) {
                        retryReleaseCount += 1;
                    }
                    return released;
                }
            }
            const inboxReader = new InboxQueueReader(new RetryObservedQueueBox(resourceInbox));
            const authority: IssuedAuthSession = {
                clientId: 'owner',
                sessionId: 'cross-target-owner-session',
                accessToken: 'cross-target-owner-token',
                username: 'owner',
                issuedAtEpochMs: nowEpochMs - 1_000,
                expiresAtEpochMs: FUTURE_MS
            };
            const authSessions = new AuthSessionRepository(runtime);
            await authSessions.putSession(authority);
            const groupRef = {
                applicationId: 'pglite-topology',
                workspaceId: 'concurrency',
                groupId: 'room'
            };
            const snapshot = topologyGroupSnapshot(groupRef);
            const groupStateRepository = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(runtime.sql));
            assert.equal((await groupStateRepository.insertGroup(snapshot.group)).status, 'applied');
            for (const member of snapshot.members) {
                await groupStateRepository.putMember(member);
            }
            const configRepository = new GroupTopologyConfigRepository(runtime);
            const baselineService = createGroupTopologyOwners({
                findGroupSnapshotByRef: (ref) => groupStateRepository.readSnapshot(ref),
                groupStateRepository,
                configRepository,
                topologyService: new RallarRtcTopologyService(),
                now: () => nowEpochMs
            });
            const staleOverrideRead = await baselineService.configMutation!.read(
                topologyOverrideCommand(groupRef, 'pglite-topology-b', 'mesh')
            );
            let staleReadCount = 0;
            let delegatedReadCount = 0;
            const topology = createGroupTopologyOwners({
                findGroupSnapshotByRef: (ref) => groupStateRepository.readSnapshot(ref),
                groupStateRepository,
                configRepository,
                topologyService: new RallarRtcTopologyService(),
                now: () => nowEpochMs
            });
            const configMutation = topology.configMutation;
            assert.ok(configMutation);
            const readTopologyConfigMutation = configMutation.read.bind(configMutation);
            configMutation.read = async (command: GroupTopologyConfigMutationCommand) => {
                if (command.commandId === 'pglite-topology-b' && staleReadCount === 0) {
                    staleReadCount += 1;
                    return staleOverrideRead;
                }
                delegatedReadCount += 1;
                return await readTopologyConfigMutation(command);
            };
            const groupState = createGroupStateService({
                runtimeRepository: runtime,
                groupStateEventStore: new PSqlGroupStateEventRepository(sql),
                authSessionRepository: authSessions,
                serviceId: 'pglite-topology-cross-target',
                now: () => nowEpochMs
            });
            const appGroup = new TopologyInboxService(
                {
                    inboxQueueReader: inboxReader,
                    resourceInboxRepository: resourceInbox.entries,
                    resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
                    database: sql,
                    groupStateService: groupState,
                    mutationOwners: requireTopologyMutationOwners(topology)
                },
                {
                    serviceId: 'pglite-topology-cross-target',
                    timing: undefined,
                    options: {
                        waitMaxElapsedMsecs: 5_000,
                        waitRetryIntervalMsecs: 1,
                        waitMaxRetryIntervalMsecs: 4,
                        waitJitterRatio: 0,
                        nowEpochMs: () => nowEpochMs
                    }
                }
            );
            const submit = async (
                requestId: string,
                payload: TopologyAppInboxRequestPayload
            ) => {
                const command = await toTopologyAppInboxCommand({
                    actor: { principalId: authority.clientId, sessionId: authority.sessionId },
                    groupRef,
                    requestId,
                    capturedAtEpochMs: nowEpochMs,
                    payload
                });
                const pending = submitPGliteTopologyCommand(appGroup, authority, command);
                await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
                await inboxReader.dequeueInbox(
                    InboxQueueReader.INBOX_DEQUEUE_TYPES,
                    toResilienceDto()
                );
                return await pending;
            };

            assert.ok(
                (await submit(
                    'pglite-topology-a',
                    { operation: 'putConfig', config: { topologyKind: 'tree' } }
                )).right
            );
            assert.ok(
                (await submit(
                    'pglite-topology-b',
                    {
                        operation: 'putOverride',
                        config: { topologyKind: 'mesh' },
                        ttlMs: 60_000,
                        expiresAtEpochMs: null
                    }
                )).right
            );

            const firstReceipt = await configRepository.findMutationRecord(
                groupRef,
                'pglite-topology-a'
            );
            const secondReceipt = await configRepository.findMutationRecord(
                groupRef,
                'pglite-topology-b'
            );
            assert.ok(firstReceipt);
            assert.ok(secondReceipt);
            assert.equal(firstReceipt.receipt.acceptedVersion, 1);
            assert.equal(secondReceipt.receipt.acceptedVersion, 1);
            assert.equal(staleReadCount, 1);
            assert.ok(delegatedReadCount >= 2);
            assert.equal(retryReleaseCount, 1);
            const [retriedEntry] = await sql<ResourceInboxAttemptStatusRow[]>`
      select ri_attempts, ri_status from resource_inbox
      where ri_type_id = 'APP_INBOX'
        and ri_resource_id = 'pglite-topology-b'
    `;
            assert.equal(Number(retriedEntry?.ri_attempts), 2);
            assert.equal(retriedEntry?.ri_status, EntityStatus.COMPLETED);
            const generation = await configRepository.findGenerationEntry(groupRef, 'config');
            assert.deepEqual(generation?.value, { groupRef, target: 'config', version: 1 });
            assert.equal(generation?.entry.revision, 0);
            const overrideGeneration = await configRepository.findGenerationEntry(groupRef, 'override');
            assert.deepEqual(overrideGeneration?.value, {
                groupRef,
                target: 'override',
                version: 1
            });
            assert.equal(overrideGeneration?.entry.revision, 0);
            const invariantGeneration = await configRepository.findInvariantGenerationEntry(groupRef);
            assert.deepEqual(invariantGeneration?.value, { groupRef, version: 2 });
            assert.equal(
                invariantGeneration?.entry.key,
                configRepository.invariantGenerationKey(groupRef)
            );
            assert.equal(invariantGeneration?.entry.revision, 1);
            const outboxRows = await sql<ResourceInboxPayloadRow[]>`
      select ri_resource
      from resource_inbox
      where ri_type_id = 'APP_OUTBOX'
      order by ri_resource_id
    `;
            assert.deepEqual(
                outboxRows.map((row) => (JSON.parse(row.ri_resource) as ALMessage).id.msgId).sort(),
                [firstReceipt.receipt.outboxIds[0], secondReceipt.receipt.outboxIds[0]].sort()
            );
        });
    }
);
