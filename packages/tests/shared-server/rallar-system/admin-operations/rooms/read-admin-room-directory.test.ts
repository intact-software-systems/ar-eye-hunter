import {
    describe,
    expect,
    it
} from 'vitest';

import { decodeAdminGroupRuntimeRow } from '@shared-server/rallar-system/admin-operations/postgres/decode-admin-group-runtime-row.ts';
import { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { Group } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

function createDirectory(repository = new FakeRuntimeStateRepository()): ReadAdminRoomDirectory {
    return new ReadAdminRoomDirectory({ repository, nowEpochMs: () => 10_000 });
}

async function storeGroup(repository: FakeRuntimeStateRepository, group: Group): Promise<void> {
    await repository.upsert({
        namespace: 'group-state:groups',
        key: groupStateGroupStorageKey(group),
        value: JSON.stringify(group),
        expireAtTimestamp: 20_000
    });
}

describe('Operator room directory inspection', () => {
    it('pages private and archived rooms in the exact scope without returning raw metadata or credentials', async () => {
        const repository = new FakeRuntimeStateRepository();
        const privateRoom = createTestGroup({
            groupId: 'a-private',
            joinMode: 'code',
            metadata: { privateSecret: 'never-publish' }
        });
        await storeGroup(repository, privateRoom);
        await storeGroup(
            repository,
            createTestGroup({
                groupId: 'b-archived',
                status: 'archived',
                archived: privateRoom.updated,
                metadata: { rallarDirectoryListing: 'unlisted' }
            })
        );
        await storeGroup(repository, createTestGroup({ workspaceId: 'workspace-10', groupId: 'foreign' }));
        const reader = createDirectory(repository);

        const first = await reader.read({ scope, limit: 1, afterGroupId: null });
        expect(first).toEqual({
            scope,
            observedAtEpochMs: 10_000,
            completeness: 'complete',
            nextAfterGroupId: 'a-private',
            entries: [{
                status: 'valid',
                room: {
                    roomRef: { ...scope, groupId: 'a-private' },
                    displayName: 'Room 1',
                    kind: 'room',
                    status: 'active',
                    joinMode: 'code',
                    directoryListing: 'listed',
                    activeMemberCount: 1,
                    maxMembers: null,
                    expiresAtEpochMs: null
                }
            }]
        });
        const second = await reader.read({ scope, limit: 1, afterGroupId: first.nextAfterGroupId });
        expect(second.nextAfterGroupId).toBeNull();
        expect(second.entries).toEqual([{
            status: 'valid',
            room: {
                roomRef: { ...scope, groupId: 'b-archived' },
                displayName: 'Room 1',
                kind: 'room',
                status: 'archived',
                joinMode: 'open',
                directoryListing: 'unlisted',
                activeMemberCount: 1,
                maxMembers: null,
                expiresAtEpochMs: null
            }
        }]);
        expect(JSON.stringify([first, second])).not.toContain('never-publish');
    });

    it('reports a corrupt row without accepting it or weakening the authoritative decoder', async () => {
        const repository = new FakeRuntimeStateRepository();
        const key = 'app=app-1:ws=workspace-1:group=a-invalid';
        const value = JSON.stringify({ ...createTestGroup(), applicationId: 'secret-foreign-app' });
        await repository.upsert({ namespace: 'group-state:groups', key, value, expireAtTimestamp: 20_000 });
        await storeGroup(repository, createTestGroup({ groupId: 'b-valid' }));

        const result = await createDirectory(repository).read({ scope, limit: 10, afterGroupId: null });
        expect(result.completeness).toBe('partial');
        expect(result.entries[0]).toEqual({
            status: 'invalid',
            roomRef: { ...scope, groupId: 'a-invalid' },
            reason: 'invalid-room-record'
        });
        expect(result.entries[1].status).toBe('valid');
        expect(JSON.stringify(result)).not.toContain('secret-foreign-app');
        expect(() => decodeAdminGroupRuntimeRow('group', { store_key: key, store_value: value }, scope))
            .toThrow();
        expect((await repository.findEntry('group-state:groups', key))?.value).toBe(value);
    });

    it('continues past deleted and expired storage rows without claiming the scan is exhausted', async () => {
        const repository = new FakeRuntimeStateRepository();
        const group = createTestGroup({ groupId: 'a-deleted' });
        await storeGroup(repository, { ...group, status: 'deleted', deleted: group.updated });
        await repository.upsert({ namespace: 'group-state:groups', key: 'app=app-1:ws=workspace-1:group=b-expired', value: '{}', expireAtTimestamp: 10_000 });
        await storeGroup(repository, createTestGroup({ groupId: 'c-current' }));
        const reader = createDirectory(repository);
        const first = await reader.read({ scope, limit: 2, afterGroupId: null });
        expect(first.entries).toEqual([]);
        expect(first.nextAfterGroupId).toBe('b-expired');
        const next = await reader.read({ scope, limit: 2, afterGroupId: first.nextAfterGroupId });
        expect(next.entries).toHaveLength(1);
        expect(next.nextAfterGroupId).toBeNull();
    });

    it('fails the page when a storage identity is not trustworthy', async () => {
        const repository = new FakeRuntimeStateRepository();
        await repository.upsert({ namespace: 'group-state:groups', key: 'app=app-1:ws=workspace-1:group=%zz', value: '{}', expireAtTimestamp: 20_000 });
        await expect(createDirectory(repository).read({ scope, limit: 10, afterGroupId: null }))
            .rejects.toThrow('Room directory storage identity is invalid');
    });

    it('preserves repository failure instead of reporting an empty or partially successful directory', async () => {
        const outage = new Error('database unavailable');
        const reader = new ReadAdminRoomDirectory({
            repository: { findEntriesByPrefixPage: () => Promise.reject(outage) },
            nowEpochMs: () => 10_000
        });
        await expect(reader.read({ scope, limit: 10, afterGroupId: null })).rejects.toBe(outage);
    });

    it('bounds page sizes and rejects empty cursor identities', async () => {
        for (const limit of [0, 101, 1.5, Number.NaN]) {
            await expect(createDirectory().read({ scope, limit, afterGroupId: null })).rejects.toThrow('limit');
        }
        await expect(createDirectory().read({ scope, limit: 10, afterGroupId: '' })).rejects.toThrow('cursor');
    });
});
