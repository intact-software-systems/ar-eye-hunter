import {
    describe,
    expect,
    it
} from 'vitest';

import { AdminStateCorruptionError } from '@shared-server/rallar-system/admin-operations/postgres/admin-state-corruption-error.ts';
import { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupScope } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const namespace = 'group-state:groups';
const futureMs = Date.parse('9999-12-31T23:59:59.999Z');

describe('PostgreSQL operator room directory', () => {
    postgresIt('pages canonical identities without crossing lookalike scopes and preserves corrupt evidence', async () => {
        const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        const scope = { applicationId: `directory-${crypto.randomUUID()}`, workspaceId: 'a:b' };
        const repository = new PSqlRuntimeStateRepository(sql);
        const directory = new ReadAdminRoomDirectory({ repository, nowEpochMs: () => 10_000 });
        try {
            await seedDirectory(repository, scope);
            const first = await directory.read({ scope, limit: 1, afterGroupId: null });
            expect(first.completeness).toBe('partial');
            expect(first.nextAfterGroupId).toBe('a-invalid');
            expect(first.entries).toEqual([{
                status: 'invalid',
                roomRef: { ...scope, groupId: 'a-invalid' },
                reason: 'invalid-room-record'
            }]);
            const second = await directory.read({ scope, limit: 1, afterGroupId: first.nextAfterGroupId });
            expect(second.completeness).toBe('complete');
            expect(second.nextAfterGroupId).toBeNull();
            expect(second.entries).toEqual([{
                status: 'valid',
                room: expect.objectContaining({
                    roomRef: { ...scope, groupId: 'b-private' },
                    joinMode: 'invite-only'
                })
            }]);
            const invalidKey = groupStateGroupStorageKey({ ...scope, groupId: 'a-invalid' });
            expect((await repository.findEntry(namespace, invalidKey))?.value).toBe('{"private":"payload"}');
            await repository.upsert({ namespace, key: `${groupStateScopeStorageKey(scope)}:group=c%zz`, value: '{}', expireAtTimestamp: futureMs });
            await expect(directory.read({ scope, limit: 10, afterGroupId: null }))
                .rejects.toBeInstanceOf(AdminStateCorruptionError);
        }
        finally {
            try {
                const prefix = `app=${scope.applicationId}:`;
                await sql`delete from runtime_state_store where store_namespace = ${namespace}
                    and left(store_key, char_length(${prefix})) = ${prefix}`;
            }
            finally {
                await sql.end();
            }
        }
    });
});

async function seedDirectory(repository: PSqlRuntimeStateRepository, scope: GroupScope): Promise<void> {
    await repository.upsert({
        namespace,
        key: groupStateGroupStorageKey({ ...scope, groupId: 'a-invalid' }),
        value: '{"private":"payload"}',
        expireAtTimestamp: futureMs
    });
    for (
        const room of [
            createTestGroup({ ...scope, groupId: 'b-private', joinMode: 'invite-only' }),
            createTestGroup({ ...scope, workspaceId: 'a%3Ab', groupId: 'foreign' }),
            createTestGroup({ ...scope, workspaceId: 'a:b-more', groupId: 'foreign' })
        ]
    ) {
        await repository.upsert({ namespace, key: groupStateGroupStorageKey(room), value: JSON.stringify(room), expireAtTimestamp: futureMs });
    }
}
