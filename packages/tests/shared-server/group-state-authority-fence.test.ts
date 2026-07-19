import { describe, expect, it } from 'vitest';
import type { Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import {
    GroupStateRepository,
} from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('GroupStateRepository authority fence', () => {
    it('preserves the exact raw group bytes, physical expiry, and every domain field', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const inserted = await repository.findGroupEntry(group);
        const semanticallyValidLegacyRaw = JSON.stringify(group, null, 2);
        await runtime.upsert(
            'group-state:groups',
            inserted!.entry.key,
            semanticallyValidLegacyRaw,
            inserted!.entry.expireAtTimestamp,
        );
        const observation = await repository.readSnapshotWithAuthorityGuard(group);
        const before = observation!.authorityGuard.entry;
        expect(before.value).toBe(semanticallyValidLegacyRaw);

        await expect(repository.advanceAuthorityFence(observation!.authorityGuard))
            .resolves.toEqual({ status: 'applied', revision: before.revision + 1 });

        const after = await repository.findGroupEntry(group);
        expect(after!.entry.value).toBe(before.value);
        expect(after!.entry.expireAtTimestamp).toBe(before.expireAtTimestamp);
        expect(after!.entry.revision).toBe(before.revision + 1);
        expect(after!.value).toEqual(group);
    });

    it('conflicts for a stale observed storage revision', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const observation = await repository.readSnapshotWithAuthorityGuard(group);

        expect(await repository.advanceAuthorityFence(observation!.authorityGuard))
            .toMatchObject({ status: 'applied' });
        await expect(repository.advanceAuthorityFence(observation!.authorityGuard))
            .resolves.toEqual({ status: 'conflict' });
    });

    it('reports the post-fence causal group revision without changing snapshot versions', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const { group, owner } = fixture();
        await repository.insertGroup(group);
        await repository.putMember(owner);
        const before = await repository.readSnapshotWithAuthorityGuard(group);
        await repository.advanceAuthorityFence(before!.authorityGuard);
        const after = await repository.readSnapshotWithAuthorityGuard(group);

        expect(after!.snapshot.causalRevision.groupRevision).toBe(
            before!.snapshot.causalRevision.groupRevision + 1,
        );
        expect(after!.snapshot.group).toEqual(before!.snapshot.group);
    });
});

function fixture(): Readonly<{ group: Group; owner: GroupMember }> {
    const ref: GroupRef = {
        applicationId: 'authority-fence-app',
        workspaceId: 'authority-fence-workspace',
        groupId: 'authority-fence-room',
    };
    const audit = { atEpochMs: 1, byPrincipalId: 'owner' } as const;
    return {
        group: {
            ...ref,
            displayName: 'Authority fence room',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit,
            updated: audit,
        },
        owner: {
            ...ref,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: audit,
            updated: audit,
        },
    };
}
