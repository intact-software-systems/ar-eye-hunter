import { describe, expect, it, vi } from 'vitest';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
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
            {
                version: 1,
                principalId: 'alice',
                sessionId: 'session-1',
                sessionIssuedAtEpochMs: 1,
                sessionExpiresAtEpochMs: 2,
                commandMac: 'test-command-mac',
            },
        );

        expect(observe).toHaveBeenCalledWith(snapshot);
        expect(result.result.right?.snapshot).toBe(snapshot);
    });

    it('reads current group authority durably without caching an equal-revision projection', async () => {
        const revisioned = createGroupSnapshot(4);
        const observe = vi.fn();
        const findOrLoadByRef = vi.fn();
        const durable = {
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

    it('returns every session-only compatibility mutation without observing its projection', async () => {
        const snapshot = createGroupSnapshot(5);
        const written = {
            status: 'ok' as const,
            result: Either.ofRight({ snapshot, event: undefined }),
        };
        const observe = vi.fn(() => {
            throw new Error('session projection must not be observed');
        });
        const durable = {
            connectPresenceSession: vi.fn().mockResolvedValue(written),
            heartbeatPresenceSession: vi.fn().mockResolvedValue(written),
            disconnectPresenceSession: vi.fn().mockResolvedValue(written),
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe,
            },
        });
        const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

        await expect(service.connectPresenceSession(
            scope,
            'group-1',
            'session-1',
            {} as never,
            {} as never,
        )).resolves.toBe(written);
        await expect(service.heartbeatPresenceSession(
            scope,
            'group-1',
            'session-1',
            {} as never,
            {} as never,
        )).resolves.toBe(written);
        await expect(service.disconnectPresenceSession(
            scope,
            'group-1',
            'session-1',
            {} as never,
            {} as never,
        )).resolves.toBe(written);

        expect(observe).not.toHaveBeenCalled();
    });

    it('keeps explicit canonical group observation fail-closed', () => {
        const snapshot = createGroupSnapshot(6);
        const conflict = new StateSnapshotRevisionConflictError(
            'Group',
            snapshot.stateRevision,
        );
        const service = createCachedGroupStateService({
            durable: {} as GroupStateService,
            cache: {
                findOrLoadByRef: vi.fn(),
                observe: vi.fn(() => {
                    throw conflict;
                }),
            },
        });

        expect(() => service.observeSnapshot(snapshot)).toThrow(conflict);
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
