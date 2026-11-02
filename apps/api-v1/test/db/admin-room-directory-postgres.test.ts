import assert from 'node:assert/strict';

import { PSqlAdminStateReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-state-reader.ts';
import { ReadAdminRoomDirectory } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-directory.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import {
    createAdminSession,
    insertRawRuntimeState,
    insertRuntimeState,
    withPGliteSql
} from './admin-operations-postgres-test-runtime.ts';

Deno.test('operator directory uses bounded PostgreSQL pages and isolates corrupt payloads from valid rooms', async () => {
    await withPGliteSql(async (sql) => {
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
        await insertRuntimeState(sql, {
            namespace: 'group-state:groups',
            key: 'app=app-1:ws=workspace-1:group=a-private',
            value: { joinMode: 'invite-only' }
        });
        await insertRawRuntimeState(sql, {
            namespace: 'group-state:groups',
            key: 'app=app-1:ws=workspace-1:group=b-invalid',
            value: { privateValue: 'never return this payload' }
        });
        await insertRuntimeState(sql, {
            namespace: 'group-state:groups',
            key: 'app=app-1:ws=workspace-1:group=c-archived',
            value: { status: 'archived', metadata: { rallarDirectoryListing: 'unlisted' } }
        });
        await insertRuntimeState(sql, {
            namespace: 'group-state:groups',
            key: 'app=app-1:ws=workspace-10:group=foreign',
            value: {}
        });
        const directory = new ReadAdminRoomDirectory({
            repository: new PSqlRuntimeStateRepository(sql),
            nowEpochMs: () => 1_700_000_000_000
        });
        const first = await directory.read({ scope, limit: 2, afterGroupId: null });
        assert.equal(first.completeness, 'partial');
        assert.equal(first.nextAfterGroupId, 'b-invalid');
        assert.equal(first.entries.length, 2);
        assert.deepEqual(first.entries[1], {
            status: 'invalid',
            roomRef: { ...scope, groupId: 'b-invalid' },
            reason: 'invalid-room-record'
        });
        assert.equal(JSON.stringify(first).includes('never return this payload'), false);
        const second = await directory.read({ scope, limit: 2, afterGroupId: first.nextAfterGroupId });
        assert.equal(second.completeness, 'complete');
        assert.equal(second.nextAfterGroupId, null);
        assert.equal(second.entries.length, 1);
        assert.equal(second.entries[0].status, 'valid');
        if (second.entries[0].status === 'valid') {
            assert.equal(second.entries[0].room.status, 'archived');
            assert.equal(second.entries[0].room.directoryListing, 'unlisted');
        }
        await assert.rejects(() =>
            new PSqlAdminStateReader(sql, { nowEpochMs: () => 1_700_000_000_000 })
                .execute({ scope, adminSession: createAdminSession() })
        );
    });
});
