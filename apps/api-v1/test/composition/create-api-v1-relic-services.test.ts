import assert from 'node:assert/strict';

import { createRelicGame, toRelicRoomGroupRef } from '@relic-hunters/mod.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createApiV1MutationRuntime, type ApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import { createApiV1RelicServices, type CreateApiV1RelicServicesInput } from '../../src/composition/create-api-v1-relic-services.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { withPGliteSql } from '../db/pglite-auth-test-harness.ts';

Deno.test('a cold API worker completes a Relic command admitted by another worker and retention deletes its save', async () => {
    await withPGliteSql(async (database) => {
        const now = Date.now();
        const producer = createMutationRuntime(database, now);
        await seedRoom(producer, now);
        const firstRuntime = createQueueRuntime(producer);
        const first = createApiV1RelicServices({
            mutation: producer,
            runtime: firstRuntime,
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
        const reservation = await first.relicGameInboxService.enqueue(command, async () => createRelicGame(command.gameId, command.gameId, now));
        const worker = createMutationRuntime(database, now);
        const coldRuntime = createQueueRuntime(worker);
        const reader = coldRuntime.inboxQueueReader;
        const cold = createApiV1RelicServices({
            mutation: worker,
            runtime: coldRuntime,
            wsRuntimeName: 'default-qbox-server',
            nowEpochMs: () => now,
            timing: () => {}
        });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
        assert.deepEqual(await cold.relicGameInboxService.wait(reservation), { status: 'initialized', gameId: 'cold-expedition' });
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
        await coldRuntime.qboxEngine.stop();
        await firstRuntime.qboxEngine.stop();
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
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        disconnectedSessionRetentionMs: 86400000,
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

function createQueueRuntime(mutation: ApiV1MutationRuntime): CreateApiV1RelicServicesInput['runtime'] {
    const qboxEngine = new InboxOutboxEngine();
    const inboxQueueReader = new InboxQueueReader(mutation.queueBox, {
        ...mutation.appInboxDequeueOptions,
        flightEntryListener: (settlement) => qboxEngine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement)
    });
    return { inboxQueueReader, qboxEngine };
}
