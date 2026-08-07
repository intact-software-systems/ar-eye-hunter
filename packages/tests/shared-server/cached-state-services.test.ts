import { describe, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import {
    createCachedClientStateService as createPackageCachedClientStateService,
    createClientStateSnapshotReadThroughCache as createPackageClientStateSnapshotReadThroughCache,
} from '@shared-server/mod.ts';
import type { ClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import { createCachedClientStateService } from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import {
    createClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';
import {
    createCachedClientStateService as createLegacyCachedClientStateService,
} from '@shared-server/rallar-system/services/cached-client-state-service.ts';
import {
    createClientStateSnapshotReadThroughCache as createLegacyClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import type { GroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';

describe('cached state services', () => {
    it('keeps client cache compatibility exports on the canonical factories', () => {
        expect(createLegacyCachedClientStateService)
            .toBe(createCachedClientStateService);
        expect(createLegacyClientStateSnapshotReadThroughCache)
            .toBe(createClientStateSnapshotReadThroughCache);
        expect(createPackageCachedClientStateService)
            .toBe(createCachedClientStateService);
        expect(createPackageClientStateSnapshotReadThroughCache)
            .toBe(createClientStateSnapshotReadThroughCache);
    });

    it('does not expose a legacy direct group mutation from its durable dependency', () => {
        const durable = {
            ...createGroupPhaseService(),
            createGroup: vi.fn(),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe: vi.fn(),
            },
        });

        expect('createGroup' in service).toBe(false);
    });

    it('reads current group authority durably without caching an equal-revision projection', async () => {
        const revisioned = createGroupSnapshot(4);
        const observe = vi.fn();
        const findOrLoadByRef = vi.fn();
        const durable = {
            ...createGroupPhaseService(),
            readSnapshot: vi.fn().mockResolvedValue(revisioned),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef,
                observe,
            },
        });

        const result = await service.readCurrentSnapshot(revisioned.group);

        expect(durable.readSnapshot).toHaveBeenCalledWith(revisioned.group);
        expect(findOrLoadByRef).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(result).toBe(revisioned);
    });

    it('does not expose legacy direct group presence mutations', () => {
        const durable = {
            ...createGroupPhaseService(),
            connectPresenceSession: vi.fn(),
            heartbeatPresenceSession: vi.fn(),
            disconnectPresenceSession: vi.fn(),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe: vi.fn(),
            },
        });

        expect('connectPresenceSession' in service).toBe(false);
        expect('heartbeatPresenceSession' in service).toBe(false);
        expect('disconnectPresenceSession' in service).toBe(false);
    });

    it('keeps explicit canonical group observation fail-closed', async () => {
        const snapshot = createGroupSnapshot(6);
        const conflict = new StateSnapshotRevisionConflictError(
            'Group',
            snapshot.stateRevision,
        );
        const service = createCachedGroupStateService({
            durable: createGroupPhaseService(),
            cache: {
                findOrLoadByRef: vi.fn(),
                observe: vi.fn(() => {
                    throw conflict;
                }),
            },
        });

        await expect(service.observeSnapshot(snapshot)).rejects.toBe(conflict);
    });

    it('uses client read-through state and explicitly observes committed snapshots', async () => {
        const snapshot = createClientSnapshot(2);
        const findOrLoadByRef = vi.fn().mockResolvedValue(snapshot);
        const observe = vi.fn();
        const durable = {
            readSnapshot: vi.fn(),
        } as unknown as ClientStateService;
        const service = createCachedClientStateService({
            durable,
            cache: { findOrLoadByRef, observe },
        });

        await expect(service.readSnapshot(snapshot.principal)).resolves.toBe(snapshot);
        await expect(service.observeSnapshot(snapshot)).resolves.toBe(snapshot);

        expect(findOrLoadByRef).toHaveBeenCalledWith(snapshot.principal);
        expect(observe).toHaveBeenCalledWith(snapshot);
    });

    it('reads current client authority durably without touching the cache', async () => {
        type DurableCurrentClientReader = Readonly<{
            readCurrentSnapshot?: ClientStateService['readSnapshot'];
        }>;
        const snapshot = createClientSnapshot(3);
        const findOrLoadByRef = vi.fn();
        const observe = vi.fn();
        const durable = {
            readSnapshot: vi.fn().mockResolvedValue(snapshot),
        } as unknown as ClientStateService;
        const service = createCachedClientStateService({
            durable,
            cache: { findOrLoadByRef, observe },
        }) as DurableCurrentClientReader;

        await expect(
            service.readCurrentSnapshot?.(snapshot.principal),
        ).resolves.toBe(snapshot);
        expect(durable.readSnapshot).toHaveBeenCalledOnce();
        expect(durable.readSnapshot).toHaveBeenCalledWith(snapshot.principal);
        expect(findOrLoadByRef).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
    });
});

function createGroupPhaseService(): GroupStateService {
    return {
        prepareMutation: vi.fn(),
        prepareExpiredPresenceMutations: vi.fn(),
        prepareSessionCleanupMutations: vi.fn(),
        read: vi.fn(),
        compute: vi.fn(),
        validate: vi.fn(),
        write: vi.fn(),
        listSnapshots: vi.fn(),
        listSnapshotsPage: vi.fn(),
        readSnapshot: vi.fn(),
        readStateRevision: vi.fn(),
        readCausalRevision: vi.fn(),
        listEvents: vi.fn(),
        listEventPage: vi.fn(),
    } as unknown as GroupStateService;
}

function createGroupSnapshot(stateRevision: number): GroupSnapshot {
    const audit = createAuditStamp(1);
    return {
        stateRevision,
        causalRevision: {
            groupRevision: stateRevision,
            presenceRevision: 1,
        },
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            slug: null,
            displayName: 'Group 1',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: 0,
            ownerPrincipalId: 'alice',
            created: audit,
            updated: audit,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
        },
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0,
    };
}

function createClientSnapshot(stateRevision: number): ClientSnapshot {
    const audit = createAuditStamp(1);
    return {
        stateRevision,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'alice',
            username: 'alice',
            displayName: 'Alice',
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: null,
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null,
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
