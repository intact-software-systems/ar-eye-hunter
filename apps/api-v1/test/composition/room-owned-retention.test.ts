import assert from 'node:assert/strict';

import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { computeRoomOwnedAppDataSave, RoomOwnedAppData, writeRoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { createTransactionBoundGroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { requireConditionalWrite, RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { createApiV1MutationRuntime, type ApiV1MutationRuntime } from '../../src/composition/create-api-v1-mutation-runtime.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { withPGliteSql } from '../db/pglite-auth-test-harness.ts';

const REF = { applicationId: 'inventory', workspaceId: 'warehouse', groupId: 'stock-room' };
const BINDING = { applicationId: REF.applicationId, workspaceId: REF.workspaceId, namespace: 'inventory', storeName: 'stock' };
const KEY = { namespace: BINDING.namespace, storeName: BINDING.storeName, key: REF.groupId };
const SEVEN_DAYS = 604_800_000;

Deno.test('an API-only process deletes configured saves exactly at seven archived days and preserves other stores and scopes', async () => {
    await withPGliteSql(async (database) => {
        const fixture = await createArchivedRoom(database);
        const otherStore = { ...KEY, storeName: 'independent' };
        const foreignScope = { ...REF, workspaceId: 'other' };
        const archived = await fixture.runtime.groupsRepository.findGroup(REF);
        assert.ok(archived);
        requireConditionalWrite(await fixture.runtime.groupsRepository.insertGroup({ ...archived, ...foreignScope }));
        await fixture.data.insertIfAbsent({ ...otherStore, value: { quantity: 99 }, schemaVersion: 1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        fixture.clock.now -= 1;
        await fixture.reconcile('before-deadline');
        assert.ok(await fixture.data.findEntry(KEY));
        assert.equal((await fixture.runtime.groupsRepository.findGroup(REF))?.status, 'archived');
        fixture.clock.now += 1;
        await fixture.reconcile('deadline');
        assert.equal(await fixture.data.findEntry(KEY), undefined);
        assert.equal(await fixture.runtime.groupsRepository.findGroup(REF), undefined);
        assert.deepEqual((await fixture.data.findEntry(otherStore))?.value, { quantity: 99 });
        assert.ok(await fixture.runtime.groupsRepository.findGroup(foreignScope));
        await fixture.reconcile('deadline');
        assert.equal(await fixture.data.findEntry(KEY), undefined);
    });
});

Deno.test('API-only purge rolls back the group retirement when save CAS loses and retries from a fresh read', async () => {
    await withPGliteSql(async (database) => {
        const fixture = await createArchivedRoom(database);
        const retention = fixture.runtime.groupStateService.retention;
        const ingress = retention.capture({ groupRef: REF, requestId: 'save-first', observedAtEpochMs: fixture.clock.now });
        const stale = retention.compute(await retention.read(ingress, 1));
        const nextSave = computeRoomOwnedAppDataSave({
            read: (await fixture.owned.read(REF))[0],
            value: { quantity: 2 },
            schemaVersion: 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        // Isolate the save fence: the ordinary writer also advances the group fence in the same transaction.
        await database.begin((transaction) => writeRoomOwnedAppData(transaction, nextSave));
        await assert.rejects(database.begin((transaction) => retention.write(transaction, stale)), RuntimeStateWriteConflictError);
        assert.equal((await fixture.runtime.groupsRepository.findGroup(REF))?.status, 'archived');
        assert.deepEqual((await fixture.data.findEntry(KEY))?.value, { quantity: 2 });
        assert.equal(await fixture.runtime.groupsRepository.findIdempotentGroupMutationReceipt(REF, ingress.commandId), undefined);
        const read = await retention.read(ingress, 2);
        const retry = retention.compute(read);
        assert.deepEqual(retention.validate(read, retry), []);
        await database.begin((transaction) => retention.write(transaction, retry));
        assert.equal(await fixture.data.findEntry(KEY), undefined);
        assert.equal(await fixture.runtime.groupsRepository.findGroup(REF), undefined);
    });
});

Deno.test('API-only purge wins the group CAS fence and a stale save cannot resurrect a deleted room or store', async () => {
    await withPGliteSql(async (database) => {
        const fixture = await createArchivedRoom(database);
        const before = await fixture.runtime.groupsRepository.findGroupEntry(REF);
        assert.ok(before);
        const stale = computeRoomOwnedAppDataSave({
            read: (await fixture.owned.read(REF))[0],
            value: { quantity: 2 },
            schemaVersion: 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        await fixture.reconcile('purge-first');
        await assert.rejects(
            database.begin(async (transaction) => {
                requireConditionalWrite(await createTransactionBoundGroupStateRepository(transaction).updateGroup(before.value, before.entry.revision));
                await writeRoomOwnedAppData(transaction, stale);
            }),
            RuntimeStateWriteConflictError
        );
        assert.equal(await fixture.runtime.groupsRepository.findGroup(REF), undefined);
        assert.equal(await fixture.data.findEntry(KEY), undefined);
    });
});

interface ArchivedRoom {
    runtime: ApiV1MutationRuntime;
    data: PSqlAppDataRepository;
    owned: RoomOwnedAppData;
    clock: { now: number; };
    reconcile(requestId: string): Promise<void>;
}

async function createArchivedRoom(database: PSqlSql): Promise<ArchivedRoom> {
    const clock = { now: Date.now() };
    const runtime = createRetentionRuntime(database, () => clock.now);
    await seedArchivedRoom(runtime, clock.now);
    const data = new PSqlAppDataRepository(database);
    const owned = new RoomOwnedAppData(data, [BINDING]);
    await data.insertIfAbsent({ ...KEY, value: { quantity: 1 }, schemaVersion: 1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
    return {
        runtime,
        data,
        owned,
        clock,
        async reconcile(requestId: string) {
            const retention = runtime.groupStateService.retention;
            const ingress = retention.capture({ groupRef: REF, requestId, observedAtEpochMs: clock.now });
            const read = await retention.read(ingress, 1);
            const computed = retention.compute(read);
            assert.deepEqual(retention.validate(read, computed), []);
            await database.begin((transaction) => retention.write(transaction, computed));
        }
    };
}

function createRetentionRuntime(database: PSqlSql, now: () => number): ApiV1MutationRuntime {
    return createApiV1MutationRuntime({
        database,
        serviceId: 'api-only-retention',
        authCredentialSecret: 'retention-test-secret-at-least-32-characters',
        maxConcurrentPasswordDerivations: 1,
        nowEpochMs: now,
        timing: () => {},
        appInboxOptions: { nowEpochMs: now },
        appInboxNewLaneConcurrency: 1,
        appInboxNewLaneHeldRows: 4,
        appInboxFinishedRetentionMs: defaults.appInbox.finishedRetentionMs,
        groupCurrentSnapshotCacheMaxEntries: defaults.group.currentSnapshotCacheMaxEntries,
        disconnectedSessionRetentionMs: SEVEN_DAYS,
        roomOwnedAppDataBindings: [BINDING],
        groupCapacity: { defaultMaxMembers: 10 },
        groupFormationRecomputeDebounceMs: 250,
        groupFormationRecomputeMaxWaitMs: 1000,
        adminClientIds: [],
        crdtPolicies: [{ documentType: '*', rollout: 'disabled' }],
        resilience: { inbox: createApiV1TestQueueResilience(), outbox: createApiV1TestQueueResilience(), appOutbox: createApiV1TestQueueResilience() },
        appInboxCompletionNotices: undefined
    });
}

async function seedArchivedRoom(runtime: ApiV1MutationRuntime, now: number): Promise<void> {
    const owner = {
        clientId: 'owner',
        username: 'owner',
        sessionId: 'owner-session',
        accessToken: 'owner-token',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + SEVEN_DAYS
    };
    await runtime.authSessionRepository.putSession(owner);
    const service = runtime.groupStateService;
    const ingress = await service.captureMutationIngress(
        mutationDescriptor({
            operation: 'createGroup',
            scope: REF,
            groupId: REF.groupId,
            request: {
                requestId: 'create-stock-room',
                groupId: REF.groupId,
                displayName: 'Stock room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                actorPrincipalId: 'owner',
                retention: { mode: 'temporary', reconnectGraceMs: 1000 }
            }
        }),
        owner
    );
    const command = { ...ingress, facts: toGroupMutationAttemptFacts(ingress.facts, 1, now) };
    const read = await service.read(command);
    const computed = service.compute(command, read);
    assert.deepEqual(service.validate(command, read, computed), []);
    if (computed.outcome !== 'write') {
        throw new Error('Expected the initial inventory room');
    }
    await runtime.database.begin((transaction) => service.write(transaction, computed));
    const group = await runtime.groupsRepository.findGroupEntry(REF);
    assert.ok(group);
    requireConditionalWrite(
        await runtime.groupsRepository.updateGroup({
            ...group.value,
            status: 'archived',
            archived: { ...group.value.updated, atEpochMs: now - SEVEN_DAYS },
            deleted: null
        }, group.entry.revision)
    );
}
