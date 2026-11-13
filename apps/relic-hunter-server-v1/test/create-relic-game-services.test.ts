import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toRelicRoomGroupRef,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createApiV1AppInbox } from '@api-v1/src/composition/create-api-v1-app-inbox.ts';
import { startApiProcess } from '@api-v1/src/runtime/api-process-startup.ts';
import { createApiV1TestQueueResilience } from '@api-v1/test/api-v1-test-queue-resilience.ts';
import { API_V1_TEST_WS_OUTBOUND_ADMISSION_NAMESPACE } from '@api-v1/test/api-v1-test-ws-outbound-admission-namespace.ts';
import { withPGliteSql } from '@api-v1/test/db/pglite-auth-test-harness.ts';
import { RELIC_ROOM_DATA_BINDING } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';
import { createRelicGameServices } from '../src/create-relic-game-services.ts';
import {
    createRelicTestApplication,
    createRelicTestMutationRuntime,
    createRelicTestQueueRuntime,
    seedRelicTestRoom
} from './relic-game-test-runtime.ts';

test('a passive Relic producer admits new work and pending/completed replay while a cold active claimant owns execution and retention', async () => {
    await withPGliteSql(async (database) => {
        const now = Date.now();
        const producer = createRelicTestMutationRuntime(database, now);
        await seedRelicTestRoom(producer, now);
        const firstRuntime = createRelicTestQueueRuntime(producer);
        const firstAppInbox = createApiV1AppInbox({ mutation: producer, runtime: firstRuntime, timing: () => {} });
        const first = createRelicGameServices({
            database,
            groups: producer.groupsRepository,
            sessions: new AuthSessionPersistence(producer.runtimeStateRepository),
            serviceId: producer.serviceId,
            roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
            appInbox: firstAppInbox,
            outbox: firstRuntime.outboxQueueReader,
            wakeQueue: () => firstRuntime.qboxEngine.wake(),
            wsRuntimeName: 'default-qbox-server',
            nowEpochMs: () => now,
            timing: () => {}
        });
        const command = {
            operation: 'ensure' as const,
            gameId: 'cold-expedition',
            requestId: 'cold-initialize',
            traceId: 'trace-create-relic-game-services',
            actor: { clientId: 'owner', sessionId: 'owner-session', issuedAtEpochMs: now },
            authorization: 'group-policy' as const,
            move: null
        };
        const worker = createRelicTestMutationRuntime(database, now);
        const coldRuntime = createRelicTestQueueRuntime(worker);
        const reader = coldRuntime.inboxQueueReader;
        const coldAppInbox = createApiV1AppInbox({ mutation: worker, runtime: coldRuntime, timing: () => {} });
        const cold = createRelicGameServices({
            database,
            groups: worker.groupsRepository,
            sessions: new AuthSessionPersistence(worker.runtimeStateRepository),
            serviceId: worker.serviceId,
            roomOwnedAppDataBindings: [RELIC_ROOM_DATA_BINDING],
            appInbox: coldAppInbox,
            outbox: coldRuntime.outboxQueueReader,
            wakeQueue: () => coldRuntime.qboxEngine.wake(),
            wsRuntimeName: 'default-qbox-server',
            nowEpochMs: () => now,
            timing: () => {}
        });
        const firstApplication = createRelicTestApplication(producer, firstRuntime, firstAppInbox);
        const coldApplication = createRelicTestApplication(worker, coldRuntime, coldAppInbox);
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

            // A round start the composed services commit indexes its transition under the composed WS runtime's namespace.
            const started = await first.relicGameInboxService.enqueue(
                { ...command, operation: 'reset', requestId: 'cold-round-start' },
                async () => toStartedRelicTestGame(command.gameId, now)
            );
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
            assert.deepEqual(await cold.relicGameInboxService.wait(started), { status: 'applied', gameId: 'cold-expedition' });
            const [transition] = await database<{ msg_id: string; }[]>`
                select ri_resource::jsonb #>> '{id,msgId}' as msg_id from resource_inbox
                where ri_type_id = 'WS_OUTBOX' and ri_resource::jsonb #>> '{payload,typeId}' = 'relic.event.v1'
            `;
            const indexed = await database<{ store_value: string; }[]>`
                select store_value from runtime_state_store
                where store_namespace = ${API_V1_TEST_WS_OUTBOUND_ADMISSION_NAMESPACE}
                    and store_key like '%:ordering-message:%'
            `;
            assert.deepEqual(indexed.map((row) => row.store_value), [JSON.stringify(transition.msg_id)]);

            const ref = toRelicRoomGroupRef(command.gameId);
            const stored = await worker.groupsRepository.findGroupEntry(ref);
            assert.ok(stored);
            const archived = { ...stored.value.updated, atEpochMs: now - 604800000 };
            await worker.groupsRepository.updateGroup({ ...stored.value, status: 'archived', archived, deleted: null }, stored.entry.revision);
            const retention = worker.groupStateService.retention;
            const ingress = retention.capture({ groupRef: ref, requestId: 'cold-delete', observedAtEpochMs: now });
            const observed = await retention.read(ingress, { attemptCount: 1, traceId: 'trace-create-relic-game-services' });
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

/** A one-hunter expedition in its first round, as a reset proposal that moves the stored lobby into round one. */
function toStartedRelicTestGame(gameId: string, now: number): RelicGameState {
    const evaluation = { presentPlayerIds: ['owner-session'], senderId: 'owner-session', now };
    const move = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId, username: 'owner' };
    const joined = requireRelicCommandApplied(
        applyRelicCommand(createRelicGame(gameId, gameId, now), { ...move, kind: 'join-expedition' }, evaluation)
    ).state;
    return requireRelicCommandApplied(applyRelicCommand(joined, { ...move, kind: 'start-expedition' }, evaluation)).state;
}
