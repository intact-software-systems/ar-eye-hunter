import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    findClientStateSnapshotByPrincipalId,
} from '@shared/repository/client-state-snapshots-repository.ts';
import {
    findGroupStateSnapshotByRef,
} from '@shared/repository/group-state-snapshots-repository.ts';
import { hydrateStateSyncSnapshotCaches } from '@shared-server/mod.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('state sync cache hydration', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('hydrates process client and group caches from supplied snapshots', async () => {
        const client = createClientSnapshot('alice');
        const group = createGroupSnapshot('room-1');

        await expect(
            hydrateStateSyncSnapshotCaches({
                clients: [client],
                groups: [group],
            }),
        ).resolves.toEqual({
            clientSnapshotCount: 1,
            groupSnapshotCount: 1,
        });

        expect(findClientStateSnapshotByPrincipalId('alice')).toEqual(client);
        expect(findGroupStateSnapshotByRef(group.group)).toEqual(group);
    });
});

function createClientSnapshot(principalId: string): ClientSnapshot {
    return {
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            profileVersion: 1,
            presenceVersion: 0,
            snapshotVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        instances: [],
        activeSessions: [],
        instanceCount: 0,
        activeSessionCount: 0,
    };
}

function createGroupSnapshot(groupId: string): GroupSnapshot {
    return {
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}
