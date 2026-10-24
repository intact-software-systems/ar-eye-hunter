import {
    describe,
    expect,
    it
} from 'vitest';

import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import {
    computeRoomOwnedAppDataDelete,
    computeRoomOwnedAppDataSave,
    RoomOwnedAppData,
    writeRoomOwnedAppData
} from '@shared-server/app-data/room-owned-app-data.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';

const binding: RoomOwnedAppData.Binding = {
    applicationId: 'expedition',
    workspaceId: 'default',
    namespace: 'expedition-saves',
    storeName: 'games'
};
const ref = { applicationId: 'expedition', workspaceId: 'default', groupId: 'room-1' };

describe('room-owned AppData conditional persistence', () => {
    it('conflicts with a stale purge, then deletes the newly observed save without touching another scope', async () => {
        const storage = await createResourceInboxTestStorage('room_owned_data');
        try {
            const repository = new PSqlAppDataRepository(storage.sql);
            const data = new RoomOwnedAppData(repository, [binding]);
            const initial = (await data.read(ref))[0];
            const firstSave = computeRoomOwnedAppDataSave({
                read: initial,
                value: { turn: 1 },
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, firstSave));
            await repository.insertIfAbsent({
                namespace: 'other-game',
                storeName: 'games',
                key: ref.groupId,
                value: { turn: 99 },
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            const beforeMove = (await data.read(ref))[0];
            const stalePurge = computeRoomOwnedAppDataDelete(beforeMove);
            if (stalePurge === null) {
                throw new Error('Expected an observed save to delete');
            }
            const nextSave = computeRoomOwnedAppDataSave({
                read: beforeMove,
                value: { turn: 2 },
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, nextSave));
            await expect(storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, stalePurge))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
            expect((await data.read(ref))[0].entry?.value).toEqual({ turn: 2 });
            const freshPurge = computeRoomOwnedAppDataDelete((await data.read(ref))[0]);
            if (freshPurge === null) {
                throw new Error('Expected the fresh save to delete');
            }
            await storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, freshPurge));
            expect((await data.read(ref))[0].entry).toBeNull();
            expect(await data.read({ ...ref, workspaceId: 'other' })).toEqual([]);
            expect((await repository.findEntry({ namespace: 'other-game', storeName: 'games', key: ref.groupId }))?.value)
                .toEqual({ turn: 99 });
        }
        finally {
            await storage.close();
        }
    });

    it('refuses a stale save after deletion and rolls back preceding writes in the same transaction', async () => {
        const storage = await createResourceInboxTestStorage('room_owned_rollback');
        try {
            const repository = new PSqlAppDataRepository(storage.sql);
            const data = new RoomOwnedAppData(repository, [binding]);
            const initial = computeRoomOwnedAppDataSave({
                read: (await data.read(ref))[0],
                value: { turn: 1 },
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, initial));
            const observed = (await data.read(ref))[0];
            const deletion = computeRoomOwnedAppDataDelete(observed);
            if (deletion === null) {
                throw new Error('Expected a save to delete');
            }
            await storage.sql.begin(async (transaction) => await writeRoomOwnedAppData(transaction, deletion));
            const stale = computeRoomOwnedAppDataSave({ read: observed, value: { turn: 2 }, schemaVersion: 1, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP });
            const sentinel = computeRoomOwnedAppDataSave({
                read: { key: { namespace: 'sentinel', storeName: 'games', key: 'rollback' }, entry: null },
                value: null,
                schemaVersion: 1,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
            await expect(storage.sql.begin(async (transaction) => {
                await writeRoomOwnedAppData(transaction, sentinel);
                await writeRoomOwnedAppData(transaction, stale);
            })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await data.read(ref))[0].entry).toBeNull();
            expect(await repository.findEntry({ namespace: 'sentinel', storeName: 'games', key: 'rollback' })).toBeUndefined();
        }
        finally {
            await storage.close();
        }
    });
});
