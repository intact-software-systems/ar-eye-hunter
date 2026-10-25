import assert from 'node:assert/strict';

import { createRelicGame, toRelicRoomGroupRef } from '@relic-hunters/mod.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import {
    createRallarServerApplication,
    type RallarServerAppInbox,
    type RallarServerApplication,
    type RallarServerRuntime
} from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { InMemoryQueueBox } from '@shared/mod.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import defaults from '@api-v1/resources/configuration/defaults-config.json' with { type: 'json' };
import { createApiV1AppInbox, type CreateApiV1AppInboxInput } from '@api-v1/src/composition/create-api-v1-app-inbox.ts';
import { createApiV1MutationRuntime, type ApiV1MutationRuntime } from '@api-v1/src/composition/create-api-v1-mutation-runtime.ts';
import { startApiProcess } from '@api-v1/src/runtime/api-process-startup.ts';
import { createApiV1TestQueueResilience } from '@api-v1/test/api-v1-test-queue-resilience.ts';
import { withPGliteSql } from '@api-v1/test/db/pglite-auth-test-harness.ts';
import { RELIC_ROOM_DATA_BINDING } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { createRelicGameServices } from '../src/create-relic-game-services.ts';

Deno.test('a passive Relic producer admits new work and pending/completed replay while a cold active claimant owns execution and retention', async () => {
    await withPGliteSql(async (database) => {
        const now = Date.now();
        const producer = createMutationRuntime(database, now);
        await seedRoom(producer, now);
        const firstRuntime = createQueueRuntime(producer);
        const firstAppInbox = createApiV1AppInbox({ mutation: producer, runtime: firstRuntime, timing: () => {} });
        const first = createRelicGameServices({
            database,
            groups: producer.groupsRepository,
            sessions: new AuthSessionPersistence(producer.runtimeStateRepository),
            serviceId: producer.serviceId,
            roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
            appInbox: firstAppInbox,
            wakeQueue: () => firstRuntime.qboxEngine.wake(),
            wsRuntimeName: 'default-qbox-server',
            nowEpochMs: () => now,
            timing: () => {}
        });
        const command = {
            operation: 'ensure' as const,
            gameId: 'cold-expedition',
            requestId: 'cold-initialize',
            actor: { clientId: 'owner', sessionId: 'owner-session', issuedAtEpochMs: now },
            authorization: 'group-policy' as const,
            move: null
        };
        const worker = createMutationRuntime(database, now);
        const coldRuntime = createQueueRuntime(worker);
        const reader = coldRuntime.inboxQueueReader;
        const coldAppInbox = createApiV1AppInbox({ mutation: worker, runtime: coldRuntime, timing: () => {} });
        const cold = createRelicGameServices({
            database,
            groups: worker.groupsRepository,
            sessions: new AuthSessionPersistence(worker.runtimeStateRepository),
            serviceId: worker.serviceId,
            roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
            appInbox: coldAppInbox,
            wakeQueue: () => coldRuntime.qboxEngine.wake(),
            wsRuntimeName: 'default-qbox-server',
            nowEpochMs: () => now,
            timing: () => {}
        });
        const firstApplication = createApplication(producer, firstRuntime, firstAppInbox);
        const coldApplication = createApplication(worker, coldRuntime, coldAppInbox);
        let producerWorkerStarts = 0;
        const originalStart = firstRuntime.qboxEngine.start.bind(firstRuntime.qboxEngine);
        firstRuntime.qboxEngine.start = () => {
            producerWorkerStarts += 1;
            originalStart();
        };
        try {
            await startApiProcess({
                runtimeReadiness: Promise.resolve(),
                listen: () => ({ name: 'passive-http-listener' }),
                startApplication: () => firstApplication.start({ queueWorkers: 'disabled' }),
                stopAfterStartupFailure: async () => {
                    await firstRuntime.qboxEngine.stop();
                }
            });
            assert.equal(producerWorkerStarts, 0);
            const proposal = async () => createRelicGame(command.gameId, command.gameId, now);
            const admission = await first.relicGameInboxService.enqueue(command, proposal);
            const pending = await first.relicGameInboxService.enqueue(command, async () => {
                throw new Error('Pending replay must not create another proposal');
            });
            assert.equal(
                await new PSqlAppDataRepository(database).findEntry({ namespace: 'relic-hunter-v1', storeName: 'relic-hunter-games', key: command.gameId }),
                undefined
            );
            coldApplication.start({ queueWorkers: 'enabled' });
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
            assert.deepEqual(await cold.relicGameInboxService.wait(admission), { status: 'initialized', gameId: 'cold-expedition' });
            assert.deepEqual(await first.relicGameInboxService.wait(pending), { status: 'initialized', gameId: command.gameId });
            assert.deepEqual(
                await first.relicGameInboxService.execute(command, async () => {
                    throw new Error('Completed replay must not create another proposal');
                }),
                { status: 'initialized', gameId: command.gameId }
            );
            assert.equal(producerWorkerStarts, 0);
            const [durable] = await database<{ status: string; }[]>`
                select ris_status as status from resource_inbox_results where ris_resource_id = 'cold-initialize'
            `;
            assert.equal(durable.status, 'COMPLETED');
            const saves = new PSqlAppDataRepository(database);
            const saveKey = { namespace: 'relic-hunter-v1', storeName: 'relic-hunter-games', key: 'cold-expedition' };
            assert.ok(await saves.findEntry(saveKey));

            const reset = await first.relicGameInboxService.enqueue(
                { ...command, operation: 'reset', requestId: 'cold-reset' },
                async () => createRelicGame(command.gameId, command.gameId, now)
            );
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
            assert.deepEqual(await cold.relicGameInboxService.wait(reset), { status: 'applied', gameId: 'cold-expedition' });
            const [publication] = await database<{ sender: string; }[]>`
                select ri_resource::jsonb #>> '{id,senderId}' as sender from resource_inbox where ri_type_id = 'WS_OUTBOX' and ri_resource_id like 'relic:%'
            `;
            assert.equal(publication.sender, 'default-qbox-server');

            const ref = toRelicRoomGroupRef(command.gameId);
            const stored = await worker.groupsRepository.findGroupEntry(ref);
            assert.ok(stored);
            const archived = { ...stored.value.updated, atEpochMs: now - 604800000 };
            await worker.groupsRepository.updateGroup({ ...stored.value, status: 'archived', archived, deleted: null }, stored.entry.revision);
            const retention = worker.groupStateService.retention;
            const ingress = retention.capture({ groupRef: ref, requestId: 'cold-delete', observedAtEpochMs: now });
            const observed = await retention.read(ingress, 1);
            const computed = retention.compute(observed);
            assert.deepEqual(retention.validate(observed, computed), []);
            await database.begin((transaction) => retention.write(transaction, computed));
            assert.equal(await saves.findEntry(saveKey), undefined);
            assert.equal(await worker.groupsRepository.findGroupEntry(ref), undefined);
        }
        finally {
            await coldRuntime.qboxEngine.stop();
            await firstRuntime.qboxEngine.stop();
            await coldApplication.runtime.wsQBoxServerService.dispose();
            await firstApplication.runtime.wsQBoxServerService.dispose();
        }
    });
});

function createMutationRuntime(database: PSqlSql, now: number): ApiV1MutationRuntime {
    return createApiV1MutationRuntime({
        database,
        serviceId: 'cold-worker',
        authCredentialSecret: 'test-secret-for-cold-composition-12345',
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: () => now,
        timing: () => {},
        appInboxOptions: { nowEpochMs: Date.now, waitMaxElapsedMsecs: 1000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 2, waitJitterRatio: 0 },
        appInboxFinishedRetentionMs: defaults.appInbox.finishedRetentionMs,
        groupCurrentSnapshotCacheMaxEntries: defaults.group.currentSnapshotCacheMaxEntries,
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        disconnectedSessionRetentionMs: 86400000,
        roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
        groupCapacity: { defaultMaxMembers: 10 },
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1000,
        adminClientIds: [],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: { inbox: createApiV1TestQueueResilience(), outbox: createApiV1TestQueueResilience(), appOutbox: createApiV1TestQueueResilience() },
        appInboxCompletionNotices: undefined
    });
}

async function seedRoom(mutation: ApiV1MutationRuntime, now: number): Promise<void> {
    const owner = {
        clientId: 'owner',
        username: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 86400000
    };
    await new AuthSessionPersistence(mutation.runtimeStateRepository).putSession(owner);
    const ref = toRelicRoomGroupRef('cold-expedition');
    const descriptor = mutationDescriptor({
        operation: 'createGroup',
        scope: ref,
        groupId: ref.groupId,
        request: {
            requestId: 'cold-room',
            groupId: ref.groupId,
            displayName: 'Cold expedition',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'owner',
            actorPrincipalId: 'owner',
            retention: { mode: 'temporary', reconnectGraceMs: 1000 }
        }
    });
    const service = mutation.groupStateService;
    const ingress = await service.captureMutationIngress(descriptor, owner);
    const command = { ...ingress, facts: toGroupMutationAttemptFacts(ingress.facts, 1, now) };
    const read = await service.read(command);
    const computed = service.compute(command, read);
    assert.deepEqual(service.validate(command, read, computed), []);
    assert.equal(computed.outcome, 'write');
    if (computed.outcome !== 'write') {
        throw new Error('Expected a new cold-worker room');
    }
    await mutation.database.begin((transaction) => service.write(transaction, computed));
}

function createQueueRuntime(mutation: ApiV1MutationRuntime): CreateApiV1AppInboxInput['runtime'] {
    const qboxEngine = new InboxOutboxEngine();
    const inboxQueueReader = new InboxQueueReader(mutation.queueBox, {
        ...mutation.appInboxDequeueOptions,
        flightEntryListener: (settlement) => qboxEngine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement)
    });
    return { inboxQueueReader, qboxEngine };
}

function createApplication(
    mutation: ApiV1MutationRuntime,
    runtime: CreateApiV1AppInboxInput['runtime'],
    appInbox: RallarServerAppInbox
): RallarServerApplication<RallarServerRuntime, void> {
    return createRallarServerApplication<RallarServerRuntime, void>({
        appInbox,
        runtime: {
            qboxEngine: runtime.qboxEngine,
            wsQBoxServerService: createDefaultWsQueueBoxServerService({
                name: 'cold-worker',
                outbox: new InMemoryQueueBox(),
                socket: mutation.webSocketServer,
                inboundVolatileStores: undefined,
                readAuthenticatedConnectionScope: () => undefined,
                queueEngine: runtime.qboxEngine
            })
        },
        repositories: new RepositoryManager(),
        appDataRepository: new PSqlAppDataRepository(mutation.database),
        nowEpochMs: Date.now,
        ws: {},
        systemInstallers: { installSystemTopics: () => {}, installWebSocketLifecycle: () => {} },
        routeInstallers: { webSocket: () => {}, rest: [] }
    });
}
