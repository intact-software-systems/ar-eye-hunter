import {
    describe,
    expect,
    it
} from 'vitest';

import { createCachedClientStateService } from '@shared-server/rallar-system/client-state/snapshot/cached-client-state-service.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    AuditStamp,
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import { createClientStateServiceFixture } from '../client-state/create-client-state-service-fixture.ts';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import { createGroupStateServiceFixture } from './test-support/create-group-state-service-fixture.ts';

describe('cached state services', () => {
    it('does not expose a direct group mutation from its durable dependency', () => {
        const durable = createGroupStateServiceFixture();
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
        const revisioned = createGroupSnapshot(4, []);
        const durable = {
            ...createGroupStateServiceFixture(),
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
        const durable = createGroupStateServiceFixture();
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
        const snapshot = createGroupSnapshot(6, []);
        const conflict = new StateSnapshotRevisionConflictError(
            'Group',
            snapshot.group.snapshotVersion
        );
        const service = createCachedGroupStateService({
            durable: createGroupStateServiceFixture(),
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
        const durable = { ...createClientStateServiceFixture(), readSnapshot: rejectUnexpectedAsyncOperation };
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
        const snapshot = createClientSnapshot(3);
        const durable = {
            ...createClientStateServiceFixture(),
            readSnapshot: async (ref: ClientPrincipalRef): Promise<ClientSnapshot> => {
                expect(ref).toEqual(snapshot.principal);
                return snapshot;
            }
        };
        const service = createCachedClientStateService({
            durable,
            cache: {
                findOrLoadByRef: rejectUnexpectedCacheAccess,
                observe: rejectUnexpectedCacheAccess
            }
        });

        await expect(
            service.readCurrentSnapshot(snapshot.principal)
        ).resolves.toBe(snapshot);
    });
});

function rejectUnexpectedCacheAccess(): never {
    throw new Error('Current authority reads must not access the projection cache');
}

function rejectUnexpectedAsyncOperation(): Promise<never> {
    return Promise.reject(new Error('Cached state service exposed an unexpected operation'));
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
            snapshotVersion: stateRevision,
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
