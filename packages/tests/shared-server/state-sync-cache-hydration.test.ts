import { hydrateStateSyncSnapshotCaches } from '@shared-server/mod.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { findClientStateSnapshotByPrincipalId } from '@shared/repository/client-state-snapshots-repository.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '../create-test-group.ts';

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
                groups: [group]
            })
        ).resolves.toEqual({
            clientSnapshotCount: 1,
            groupSnapshotCount: 1
        });

        expect(findClientStateSnapshotByPrincipalId('alice')).toEqual(client);
        expect(findGroupStateSnapshotByRef(group.group)).toEqual(group);
    });
});

function createClientSnapshot(principalId: string): ClientSnapshot {
    const audit: AuditStamp = {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 0,
            snapshotVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: null
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null
    };
}

function createGroupSnapshot(groupId: string): GroupSnapshot {
    const audit: AuditStamp = {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            displayName: groupId,
            activeMemberCount: 0,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: audit,
            updated: audit
        }),
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
}
