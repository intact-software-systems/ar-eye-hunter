import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import {
    GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE,
    toGroupConnectTriggerStorageKey
} from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    createRetentionDatabaseFixture,
    RETENTION_REF,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

describe('transactional deletion of room-owned rows', () => {
    it('deletes only exact owned AppData and scoped latches while preserving another scope and store', async () => {
        fixture = await createRetentionDatabaseFixture();
        await archive(fixture);
        const appData = new PSqlAppDataRepository(fixture.storage.sql);
        const own = { namespace: 'room-game', storeName: 'saves', key: RETENTION_REF.groupId };
        const other = { ...own, namespace: 'another-game' };
        for (const key of [own, other]) {
            await appData.insertIfAbsent({ ...key, value: { turn: 3 }, schemaVersion: 1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        }
        const foreignRef = { ...RETENTION_REF, workspaceId: 'another-workspace' };
        const group = await fixture.repository.findGroup(RETENTION_REF);
        if (!group) {
            throw new Error('Room missing');
        }
        await fixture.repository.insertGroup({ ...group, ...foreignRef });
        const ownedLatch = await seedLatch(fixture, RETENTION_REF);
        const foreignLatch = await seedLatch(fixture, foreignRef);
        const retention = new GroupRetentionService({
            repository: fixture.repository,
            groupOwnedAppData: new RoomOwnedAppData(appData, [{
                applicationId: RETENTION_REF.applicationId,
                workspaceId: RETENTION_REF.workspaceId,
                namespace: own.namespace,
                storeName: own.storeName
            }])
        }, { serviceId: 'test', now: () => fixture!.nowEpochMs });
        const ingress = retention.capture({ groupRef: RETENTION_REF, requestId: 'delete-owned', observedAtEpochMs: fixture.nowEpochMs });
        const read = await retention.read(ingress, { attemptCount: 1, traceId: 'trace-group-retirement-owned-data' });
        const computed = retention.compute(read);
        expect(retention.validate(read, computed)).toEqual([]);
        await fixture.storage.sql.begin((transaction) => retention.write(transaction, computed));
        expect(await appData.findEntry(own)).toBeUndefined();
        expect((await appData.findEntry(other))?.value).toEqual({ turn: 3 });
        expect(await fixture.runtime.findEntry(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, ownedLatch)).toBeUndefined();
        expect(await fixture.runtime.findEntry(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, foreignLatch)).toBeDefined();
        expect(await fixture.repository.findGroup(foreignRef)).toEqual({ ...group, ...foreignRef });
    }, 30_000);

    it('rolls back group retirement and child deletion when an observed save revision loses', async () => {
        fixture = await createRetentionDatabaseFixture();
        await archive(fixture);
        const appData = new PSqlAppDataRepository(fixture.storage.sql);
        const key = { namespace: 'room-game', storeName: 'saves', key: RETENTION_REF.groupId };
        await appData.insertIfAbsent({ ...key, value: { turn: 1 }, schemaVersion: 1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
        const owned = new RoomOwnedAppData(appData, [{
            applicationId: RETENTION_REF.applicationId,
            workspaceId: RETENTION_REF.workspaceId,
            namespace: key.namespace,
            storeName: key.storeName
        }]);
        const retention = new GroupRetentionService({ repository: fixture.repository, groupOwnedAppData: owned }, {
            serviceId: 'test',
            now: () => fixture!.nowEpochMs
        });
        const ingress = retention.capture({ groupRef: RETENTION_REF, requestId: 'delete-save-race', observedAtEpochMs: fixture.nowEpochMs });
        const computed = retention.compute(await retention.read(ingress, { attemptCount: 1, traceId: 'trace-group-retirement-owned-data' }));
        const before = await fixture.repository.readRetirementEntries(RETENTION_REF);
        expect(
            (await appData.upsertIfRevision({
                ...key,
                value: { turn: 2 },
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
                expectedRevision: 0
            })).status
        ).toBe('written');
        await expect(fixture.storage.sql.begin((transaction) => retention.write(transaction, computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
        expect(await fixture.repository.readRetirementEntries(RETENTION_REF)).toEqual(before);
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, ingress.commandId)).toBeUndefined();
        const fresh = retention.compute(await retention.read(ingress, { attemptCount: 2, traceId: 'trace-group-retirement-owned-data' }));
        await fixture.storage.sql.begin((transaction) => retention.write(transaction, fresh));
        expect(await appData.findEntry(key)).toBeUndefined();
        expect(await fixture.repository.findGroup(RETENTION_REF)).toBeUndefined();
    }, 30_000);
});

async function archive(fixture: RetentionDatabaseFixture): Promise<void> {
    await seedRetentionRoom(fixture);
    const stored = await fixture.repository.findGroupEntry(RETENTION_REF);
    if (!stored) {
        throw new Error('Seed missing');
    }
    await fixture.repository.updateGroup({
        ...stored.value,
        status: 'archived',
        deleted: null,
        archived: { ...stored.value.updated, atEpochMs: fixture.nowEpochMs - 604800000 }
    }, stored.entry.revision);
}

async function seedLatch(fixture: RetentionDatabaseFixture, groupRef: typeof RETENTION_REF): Promise<string> {
    const latch = {
        groupRef,
        formationEpoch: 1,
        triggerGeneration: 'archived',
        state: 'awaiting-publication',
        notBeforeEpochMs: 1,
        supersedesLayoutIdentity: null
    };
    const key = toGroupConnectTriggerStorageKey(latch);
    await fixture.runtime.upsert(GROUP_CONNECT_TRIGGER_LATCHES_NAMESPACE, key, JSON.stringify(latch), NEVER_EXPIRE_AT_TIMESTAMP);
    expect(key.startsWith(groupStateGroupStorageKey(groupRef))).toBe(true);
    return key;
}
