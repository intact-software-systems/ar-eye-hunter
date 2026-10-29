import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    commitMutation,
    commitRetention,
    createRetentionDatabaseFixture,
    prepareMutation,
    prepareRetention,
    requireMutationWrite,
    RETENTION_REF,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

describe('permanently retired scoped identities', () => {
    it('rejects fresh creation permanently, fences a stale precreation read and omits retirement from all current reads', async () => {
        fixture = await createRetentionDatabaseFixture();
        const stale = await prepareMutation(fixture, createDescriptor('stale-create'));
        await seedArchivedRoom(fixture);
        const deletion = await prepareRetention(fixture, 'delete-room');
        await commitRetention(fixture, deletion.computed);
        await expect(commitMutation(fixture, requireMutationWrite(stale.computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await prepareMutation(fixture, createDescriptor('fresh-create'))).computed).toMatchObject({
            outcome: 'rejected',
            rejectionCode: 'group-retired'
        });
        expect(await fixture.repository.readSnapshot(RETENTION_REF)).toBeUndefined();
        expect(await fixture.repository.listGroups(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.listSnapshots(RETENTION_REF)).toEqual([]);
        expect((await fixture.repository.listSnapshotsPage(RETENTION_REF, { limit: 1 })).snapshots).toEqual([]);
        expect(await fixture.repository.listGroupsPage({ limit: 1 })).toEqual({ groups: [], nextKey: groupStateGroupStorageKey(RETENTION_REF) });
        expect(await fixture.repository.listGroupsPage({ limit: 1, afterKey: groupStateGroupStorageKey(RETENTION_REF) })).toEqual({
            groups: [],
            nextKey: null
        });
        expect((await fixture.repository.readLifecyclePolicy(RETENTION_REF)).status).toBe('absent');
    }, 30_000);

    it.each(['applicationId', 'workspaceId', 'groupId'] as const)('rejects wrong %s in retirement on point, batch, prefix and page reads', async (field) => {
        fixture = await createRetentionDatabaseFixture();
        await seedArchivedRoom(fixture);
        await commitRetention(fixture, (await prepareRetention(fixture, 'delete')).computed);
        const key = groupStateGroupStorageKey(RETENTION_REF);
        const retired = await fixture.runtime.findEntry(GROUPS_NAMESPACE, key);
        await fixture.runtime.upsert(GROUPS_NAMESPACE, key, JSON.stringify({ ...JSON.parse(retired!.value), [field]: 'foreign' }), NEVER_EXPIRE_AT_TIMESTAMP);
        for (
            const read of [
                () => fixture!.repository.findGroup(RETENTION_REF),
                () => fixture!.repository.readPresenceSummaryEntries(RETENTION_REF),
                () => fixture!.repository.listGroups(RETENTION_REF),
                () => fixture!.repository.listGroupsPage({ limit: 1 }),
                () => fixture!.repository.readSnapshot(RETENTION_REF)
            ]
        ) {
            await expect(read()).rejects.toMatchObject({ code: 'group-state-repository-invariant-corruption' });
        }
    }, 30_000);

    it('fails closed if a retirement row is given physical expiry', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedArchivedRoom(fixture);
        await commitRetention(fixture, (await prepareRetention(fixture, 'delete')).computed);
        const key = groupStateGroupStorageKey(RETENTION_REF);
        const retired = await fixture.runtime.findEntry(GROUPS_NAMESPACE, key);
        await fixture.runtime.upsert(GROUPS_NAMESPACE, key, retired!.value, Date.now() - 1);
        await expect(fixture.repository.findGroup(RETENTION_REF)).rejects.toMatchObject({ code: 'group-state-repository-invariant-corruption' });
        await expect(prepareMutation(fixture, createDescriptor('must-not-recreate'))).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    }, 30_000);

    it('preserves ordinary expired-ID recreation', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const group = await fixture.repository.findGroup(RETENTION_REF);
        await fixture.runtime.upsert(GROUPS_NAMESPACE, groupStateGroupStorageKey(RETENTION_REF), JSON.stringify(group), Date.now() - 1);
        const expired = await fixture.runtime.findEntry(GROUPS_NAMESPACE, groupStateGroupStorageKey(RETENTION_REF));
        const read = await fixture.repository.readMutationExactEntries({
            aggregateRef: RETENTION_REF,
            includeGroup: true,
            includePresenceSummary: true,
            includeLifecyclePolicy: false,
            includeGroupSnapshot: false,
            authSessionId: null,
            requestIds: [],
            memberPrincipalIds: [],
            presenceSessionIds: [],
            admissionPrincipalIds: [],
            publicationGrantPrincipalIds: []
        });
        expect(read.groups).toEqual([]);
        expect(read.expiredGroupEntry).toEqual(expired);
        expect(await fixture.runtime.findEntry(GROUPS_NAMESPACE, groupStateGroupStorageKey(RETENTION_REF))).toEqual(expired);
        const recreated = await prepareMutation(fixture, createDescriptor('recreate-expired'));
        expect(recreated.computed.outcome).toBe('write');
        await commitMutation(fixture, requireMutationWrite(recreated.computed));
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('active');
    }, 30_000);

    it('fences expired-ID recreation when a concurrent writer refreshes the observed group', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const group = await fixture.repository.findGroup(RETENTION_REF);
        const key = groupStateGroupStorageKey(RETENTION_REF);
        await fixture.runtime.upsert(GROUPS_NAMESPACE, key, JSON.stringify(group), Date.now() - 1);
        const recreated = await prepareMutation(fixture, createDescriptor('stale-recreation'));
        await fixture.runtime.upsert(GROUPS_NAMESPACE, key, JSON.stringify(group), NEVER_EXPIRE_AT_TIMESTAMP);
        const refreshed = await fixture.runtime.findEntry(GROUPS_NAMESPACE, key);

        await expect(commitMutation(fixture, requireMutationWrite(recreated.computed)))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await fixture.runtime.findEntry(GROUPS_NAMESPACE, key)).toEqual(refreshed);
        expect(await fixture.repository.findGroup(RETENTION_REF)).toEqual(group);
    }, 30_000);

    it.each(['active', 'persistent'] as const)('keeps %s rooms', async (kind) => {
        fixture = await createRetentionDatabaseFixture();
        await seedArchivedRoom(fixture);
        const stored = await fixture.repository.findGroupEntry(RETENTION_REF);
        if (!stored) {
            throw new Error('Seed missing');
        }
        await fixture.repository.updateGroup({
            ...stored.value,
            ...(kind === 'active' ? { status: 'active', archived: null, deleted: null } as const : { metadata: {} })
        }, stored.entry.revision);
        await commitRetention(fixture, (await prepareRetention(fixture, 'keep')).computed);
        expect(await fixture.repository.findGroup(RETENTION_REF)).toBeDefined();
    }, 30_000);

    it('rolls back retirement and all children when the deletion event collides', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedArchivedRoom(fixture);
        const deletion = await prepareRetention(fixture, 'delete-collision');
        if (deletion.computed.outcome !== 'write') {
            throw new Error('Expected deletion');
        }
        await fixture.repository.appendEvent({ ...deletion.computed.persistence.eventWrite.event, reason: 'foreign-event' });
        const before = await fixture.repository.readRetirementEntries(RETENTION_REF);
        await expect(commitRetention(fixture, deletion.computed)).rejects.toMatchObject({ code: 'group-state-event-collision' });
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
        expect(await fixture.repository.readRetirementEntries(RETENTION_REF)).toEqual(before);
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, deletion.ingress.commandId)).toBeUndefined();
    }, 30_000);
});

async function seedArchivedRoom(fixture: RetentionDatabaseFixture): Promise<void> {
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

function createDescriptor(requestId: string) {
    return mutationDescriptor({
        operation: 'createGroup',
        scope: RETENTION_REF,
        groupId: RETENTION_REF.groupId,
        request: {
            requestId,
            groupId: RETENTION_REF.groupId,
            displayName: 'Room',
            kind: 'room',
            joinMode: 'open',
            createdByPrincipalId: 'owner',
            actorPrincipalId: 'owner'
        }
    });
}
