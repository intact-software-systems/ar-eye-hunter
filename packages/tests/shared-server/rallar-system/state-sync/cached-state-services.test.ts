import { type ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createCachedClientStateService } from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import { describe, expect, it } from 'vitest';
import { createTestGroup } from '../../../create-test-group.ts';
import { createClientStateServiceStub } from '../../client-state/test-support/client-state-service-stub.ts';
import { createGroupStateServiceStub } from './test-support/group-state-service-stub.ts';

describe('cached state services', () => {
    it('does not expose a direct group mutation from its durable dependency', () => {
        const durable = {
            ...createGroupStateServiceStub(),
            createGroup: rejectUnexpectedAsyncOperation
        };
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: rejectUnexpectedCacheAccess
            }
        });

        expect('createGroup' in service).toBe(false);
    });

    it('reads current group authority durably without caching an equal-revision projection', async () => {
        const revisioned = createGroupSnapshot(4);
        const durable = {
            ...createGroupStateServiceStub(),
            readSnapshot: async (ref: GroupRef): Promise<GroupSnapshot> => {
                expect(ref).toEqual(revisioned.group);
                return revisioned;
            }
        };
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: rejectUnexpectedCacheAccess
            }
        });

        const result = await service.readCurrentSnapshot(revisioned.group);

        expect(result).toBe(revisioned);
    });

    it('does not expose direct group presence mutations', () => {
        const durable = {
            ...createGroupStateServiceStub(),
            connectPresenceSession: rejectUnexpectedAsyncOperation,
            heartbeatPresenceSession: rejectUnexpectedAsyncOperation,
            disconnectPresenceSession: rejectUnexpectedAsyncOperation
        };
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: rejectUnexpectedCacheAccess
            }
        });

        expect('connectPresenceSession' in service).toBe(false);
        expect('heartbeatPresenceSession' in service).toBe(false);
        expect('disconnectPresenceSession' in service).toBe(false);
    });

    it('keeps explicit canonical group observation fail-closed', async () => {
        const snapshot = createGroupSnapshot(6);
        const conflict = new StateSnapshotRevisionConflictError(
            'Group',
            snapshot.group.snapshotVersion
        );
        const service = createCachedGroupStateService({
            durable: createGroupStateServiceStub(),
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: () => {
                    throw conflict;
                }
            }
        });

        await expect(service.observeSnapshot(snapshot)).rejects.toBe(conflict);
    });

    it('uses client read-through state and explicitly observes committed snapshots', async () => {
        const snapshot = createClientSnapshot(2);
        let observed: ClientSnapshot | undefined;
        const durable = createClientStateServiceStub({
            readSnapshot: rejectUnexpectedAsyncOperation
        });
        const service = createCachedClientStateService({
            durable,
            cache: {
                findOrLoadByRef: async (ref): Promise<ClientSnapshot> => {
                    expect(ref).toEqual(snapshot.principal);
                    return snapshot;
                },
                observe: (committed) => {
                    observed = committed;
                    return 'inserted';
                }
            }
        });

        await expect(service.readSnapshot(snapshot.principal)).resolves.toBe(snapshot);
        await expect(service.observeSnapshot(snapshot)).resolves.toBe(snapshot);

        expect(observed).toBe(snapshot);
    });

    it('reads current client authority durably without touching the cache', async () => {
        type DurableCurrentClientReader = Readonly<{
            readCurrentSnapshot?: ClientStateService['readSnapshot'];
        }>;
        const snapshot = createClientSnapshot(3);
        const durable = createClientStateServiceStub({
            readSnapshot: async (ref): Promise<ClientSnapshot> => {
                expect(ref).toEqual(snapshot.principal);
                return snapshot;
            }
        });
        const service = createCachedClientStateService({
            durable,
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: rejectUnexpectedCacheAccess
            }
        }) as DurableCurrentClientReader;

        await expect(
            service.readCurrentSnapshot?.(snapshot.principal)
        ).resolves.toBe(snapshot);
    });
});

function rejectUnexpectedCacheAccess(): never {
    throw new Error('Current authority reads must not access the projection cache');
}

function rejectUnexpectedAsyncOperation(): Promise<never> {
    return Promise.reject(new Error('Cached state service exposed an unexpected operation'));
}

function createGroupSnapshot(groupRevision: number): GroupSnapshot {
    const audit = createAuditStamp(1);
    return {
        causalRevision: {
            groupRevision,
            presenceRevision: 1
        },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            displayName: 'Group 1',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: 0,
            ownerPrincipalId: 'alice',
            created: audit,
            updated: audit
        }),
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
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
            lastSeenAtEpochMs: null
        },
        instances: [],
        activeSessions: [],
        isOnline: false,
        activeSessionCount: 0,
        lastSeenAtEpochMs: null
    };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
