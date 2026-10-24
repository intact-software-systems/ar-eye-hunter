import { afterEach, describe, expect, it } from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createRetentionDatabaseFixture, RETENTION_REF, seedRetentionRoom, type RetentionDatabaseFixture } from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

describe('bounded retention repository pages', () => {
    it('visits canonical keys across scopes and advances past a full expired page', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const group = await fixture.repository.findGroup(RETENTION_REF);
        if (!group) {
            throw new Error('Expected the seeded room');
        }
        const other = { ...group, applicationId: 'z:app', workspaceId: '%workspace', groupId: 'same:room' };
        await fixture.repository.insertGroup(other);
        const expiredKey = 'app=aaa:ws=default:group=expired';
        await fixture.runtime.upsert(GROUPS_NAMESPACE, expiredKey, '{}', Date.now() - 1_000);

        const expired = await fixture.repository.listGroupsPage({ limit: 1 });
        expect(expired).toEqual({ groups: [], nextKey: expiredKey });
        const first = await fixture.repository.listGroupsPage({ limit: 1, afterKey: expired.nextKey ?? undefined });
        expect(first).toEqual({ groups: [group], nextKey: groupStateGroupStorageKey(group) });
        const second = await fixture.repository.listGroupsPage({ limit: 1, afterKey: first.nextKey ?? undefined });
        expect(second).toEqual({ groups: [other], nextKey: groupStateGroupStorageKey(other) });
        expect(await fixture.repository.listGroupsPage({ limit: 1, afterKey: second.nextKey ?? undefined }))
            .toEqual({ groups: [], nextKey: null });
        await expect(fixture.repository.listGroupsPage({ limit: 501 })).rejects.toThrow(/page limit/);
    }, 30_000);

    it.each(['applicationId', 'workspaceId', 'groupId'] as const)('rejects a stored value with the wrong %s', async (field) => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const group = await fixture.repository.findGroup(RETENTION_REF);
        await fixture.runtime.upsert(
            GROUPS_NAMESPACE,
            groupStateGroupStorageKey(RETENTION_REF),
            JSON.stringify({ ...group, [field]: 'wrong-slot' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(fixture.repository.listGroupsPage({ limit: 100 })).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    }, 30_000);

    it('reports a noncanonical physical key as typed invariant corruption', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const group = await fixture.repository.findGroup(RETENTION_REF);
        await fixture.runtime.upsert(
            GROUPS_NAMESPACE,
            'app=%72etention-app:ws=retention-workspace:group=temporary-room',
            JSON.stringify(group),
            NEVER_EXPIRE_AT_TIMESTAMP
        );

        await expect(fixture.repository.listGroupsPage({ limit: 100 })).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    }, 30_000);
});
