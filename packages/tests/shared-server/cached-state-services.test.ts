import { describe, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { ClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { createCachedClientStateService } from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import type { GroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';

describe('cached state services', () => {
    it('observes a committed group mutation before resolving it', async () => {
        const snapshot = createGroupSnapshot(3);
        const observe = vi.fn();
        const durable = {
            createGroup: vi.fn().mockResolvedValue({
                status: 'created',
                result: Either.ofRight({ snapshot, event: undefined }),
            }),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe,
            },
        });

        const result = await service.createGroup(
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            {} as never,
        );

        expect(observe).toHaveBeenCalledWith(snapshot);
        expect(result.result.right?.snapshot).toBe(snapshot);
    });

    it('rehydrates a legacy group mutation before observing and returning it', async () => {
        const legacy = createGroupSnapshot(undefined);
        const revisioned = createGroupSnapshot(4);
        const observe = vi.fn();
        const durable = {
            updateGroup: vi.fn().mockResolvedValue({
                status: 'ok',
                result: Either.ofRight({ snapshot: legacy, event: undefined }),
            }),
            readSnapshot: vi.fn().mockResolvedValue(revisioned),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe,
            },
        });

        const result = await service.updateGroup(
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            'group-1',
            {} as never,
        );

        expect(durable.readSnapshot).toHaveBeenCalledWith(legacy.group);
        expect(observe).toHaveBeenCalledWith(revisioned);
        expect(result.result.right?.snapshot).toBe(revisioned);
    });

    it('uses client read-through state and observes mutation results', async () => {
        const snapshot = createClientSnapshot(2);
        const findOrLoadByRef = vi.fn().mockResolvedValue(snapshot);
        const observe = vi.fn();
        const durable = {
            readSnapshot: vi.fn(),
            upsertPrincipal: vi.fn().mockResolvedValue({
                status: 'ok',
                result: Either.ofRight({ snapshot, event: undefined }),
            }),
        } as unknown as ClientStateService;
        const service = createCachedClientStateService({
            durable,
            cache: { findOrLoadByRef, observe },
        });

        await expect(service.readSnapshot(snapshot.principal)).resolves.toBe(snapshot);
        const result = await service.upsertPrincipal(
            { applicationId: 'app-1', workspaceId: 'workspace-1' },
            'alice',
            {} as never,
        );

        expect(findOrLoadByRef).toHaveBeenCalledWith(snapshot.principal);
        expect(observe).toHaveBeenCalledWith(snapshot);
        expect(result.result.right?.snapshot).toBe(snapshot);
    });
});

function createGroupSnapshot(stateRevision: number | undefined): GroupSnapshot {
    return {
        stateRevision,
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            displayName: 'Group 1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1 },
            updated: { atEpochMs: 1 },
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}

function createClientSnapshot(stateRevision: number): ClientSnapshot {
    return {
        stateRevision,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
            username: 'alice',
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: 1 },
            updated: { atEpochMs: 1 },
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
    };
}
