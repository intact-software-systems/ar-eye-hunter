import { beforeEach, describe, expect, it } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { OverlayInfo, RttMeasurementInfo, } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientVersion, readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureClientStateSnapshotRepository,
    findClientStateSnapshotByRef,
    findClientStateSnapshotByPrincipalId,
    getAllClientStateSnapshots,
    onClientStateSnapshotChange,
    readableClientStateSnapshotCache,
    setClientStateSnapshotByPrincipalId,
    waitForClientStateSnapshotChangesIdle,
} from '@shared/repository/client-state-snapshots-repository.ts';
import {
    findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotsBySessionIds,
    findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots,
    onGroupStateSnapshotChange,
    removeGroupStateSnapshotByRef,
    setGroupStateSnapshot,
    setGroupStateSnapshots,
    waitForGroupStateSnapshotChangesIdle,
} from '@shared/repository/group-state-snapshots-repository.ts';
import {
    createAndSetStarOverlays,
    findOverlayById,
    getAllOverlays,
    onOverlayChange,
    removeOverlayById,
    setOverlayById,
    updateNextHopSessionIds,
    waitForOverlayChangesIdle,
} from '@shared/repository/overlays-repository.ts';
import { getAllRtt, pairKey, setRtt, setRttById, } from '@shared/repository/rtt-repository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('repository modules', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('stores client snapshots by principal id and preserves online state', () => {
        const online = createClientSnapshot('client-1', 'session-1', 1);
        const offline = createClientSnapshot('client-2', undefined, 1);

        setClientStateSnapshotByPrincipalId(online.principal.principalId, online);
        setClientStateSnapshotByPrincipalId(offline.principal.principalId, offline);

        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(online);
        expect(getAllClientStateSnapshots().filter((snapshot) => snapshot.isOnline))
            .toEqual([
                online,
            ]);
    });

    it('stores same-principal client snapshots by fully scoped ref', () => {
        const workspaceA = createClientSnapshot('client-1', 'session-a', 1);
        const workspaceB = {
            ...createClientSnapshot('client-1', 'session-b', 1),
            principal: {
                ...createClientSnapshot('client-1', 'session-b', 1).principal,
                workspaceId: 'workspace-2',
            },
            instances: createClientSnapshot('client-1', 'session-b', 1).instances
                .map((instance) => ({ ...instance, workspaceId: 'workspace-2' })),
            activeSessions: createClientSnapshot('client-1', 'session-b', 1)
                .activeSessions
                .map((session) => ({ ...session, workspaceId: 'workspace-2' })),
        } satisfies ClientSnapshot;

        expect(setClientStateSnapshotByPrincipalId('client-1', workspaceA)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', workspaceB)).toBe(true);

        expect(findClientStateSnapshotByRef(workspaceA.principal)).toEqual(workspaceA);
        expect(findClientStateSnapshotByRef(workspaceB.principal)).toEqual(workspaceB);
        expect(getAllClientStateSnapshots()).toHaveLength(2);
    });

    it('emits client snapshot changes only for accepted writes', async () => {
        const changes: string[] = [];
        const unsubscribe = onClientStateSnapshotChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = createClientSnapshot('client-1', 'session-1', 1);
            const refreshed = {
                ...first,
                principal: {
                    ...first.principal,
                    updated: {
                        ...first.principal.updated,
                        atEpochMs: first.principal.updated.atEpochMs + 1,
                    },
                },
            } satisfies ClientSnapshot;
            const stale = createClientSnapshot('client-1', 'session-1', 0);
            const newer = createClientSnapshot('client-1', 'session-1', 2);

            expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(true);
            expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(false);
            expect(setClientStateSnapshotByPrincipalId('client-1', refreshed)).toBe(false);
            expect(setClientStateSnapshotByPrincipalId('client-1', stale)).toBe(false);
            expect(setClientStateSnapshotByPrincipalId('client-1', newer)).toBe(true);
            await waitForClientStateSnapshotChangesIdle();

            expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(newer);
            expect(changes).toEqual(['created', 'refreshed', 'updated']);
        } finally {
            unsubscribe();
        }
    });

    it('uses client principal snapshotVersion for cache ordering', () => {
        const first = {
            ...createClientSnapshot('client-1', 'session-1', 1),
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 1).principal,
                snapshotVersion: 10,
            },
        } satisfies ClientSnapshot;
        const staleBySnapshotVersion = {
            ...createClientSnapshot('client-1', 'session-1', 99),
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 99).principal,
                snapshotVersion: 9,
            },
        } satisfies ClientSnapshot;
        const newer = {
            ...createClientSnapshot('client-1', 'session-1', 2),
            principal: {
                ...createClientSnapshot('client-1', 'session-1', 2).principal,
                snapshotVersion: 11,
            },
        } satisfies ClientSnapshot;

        expect(readClientVersion(first)).toBe(10);
        expect(setClientStateSnapshotByPrincipalId('client-1', first)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', staleBySnapshotVersion)).toBe(false);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(first);
        expect(setClientStateSnapshotByPrincipalId('client-1', newer)).toBe(true);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(newer);
    });

    it('uses client stateRevision before legacy snapshotVersion', () => {
        const accepted = {
            ...createClientSnapshot('client-1', 'session-new', 1),
            stateRevision: 2,
        } satisfies ClientSnapshot;
        const stale = {
            ...createClientSnapshot('client-1', 'session-stale', 99),
            stateRevision: 1,
        } satisfies ClientSnapshot;
        const conflict = {
            ...accepted,
            activeSessionCount: 0,
        } satisfies ClientSnapshot;

        expect(setClientStateSnapshotByPrincipalId('client-1', accepted)).toBe(true);
        expect(setClientStateSnapshotByPrincipalId('client-1', stale)).toBe(false);
        expect(findClientStateSnapshotByPrincipalId('client-1')).toEqual(accepted);
        expect(() => setClientStateSnapshotByPrincipalId('client-1', conflict))
            .toThrow('Client snapshot revision conflict');
    });

    it('stores group snapshots by scoped ref, keeps newer versions, and finds memberships', () => {
        const first = createGroupSnapshot('group-1', 'Alpha', 1, [
            'self',
            'peer-a',
        ]);
        const stale = createGroupSnapshot('group-1', 'Alpha', 0, ['self']);
        const second = createGroupSnapshot('group-2', 'Beta', 1, [
            'self',
            'peer-b',
        ]);

        expect(setGroupStateSnapshots([first, second])).toBe(true);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
        expect(findGroupStateSnapshotByRef(second.group)).toEqual(second);
        expect(findFirstGroupStateSnapshotRefSessionIdIsIn('peer-a')).toEqual(
            first.group,
        );
        expect(getAllGroupStateSnapshots()).toEqual([first, second]);

        expect(setGroupStateSnapshot(stale)).toBe(false);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
    });

    it('finds group snapshots by all active session ids using current memberships', () => {
        const first = createGroupSnapshot('group-1', 'Alpha', 1, [
            'self',
            'peer-a',
        ]);
        const second = createGroupSnapshot('group-2', 'Beta', 1, [
            'self',
            'peer-b',
        ]);
        const updatedFirst = createGroupSnapshot('group-1', 'Alpha', 2, [
            'self',
            'peer-c',
        ]);

        expect(setGroupStateSnapshots([first, second])).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-a']))
            .toEqual([first]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-b']))
            .toEqual([second]);

        expect(setGroupStateSnapshot(updatedFirst)).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-a']))
            .toEqual([]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-c']))
            .toEqual([updatedFirst]);

        expect(removeGroupStateSnapshotByRef(updatedFirst.group)).toBe(true);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-c']))
            .toEqual([]);
        expect(findGroupStateSnapshotsBySessionIds(['self', 'peer-b']))
            .toEqual([second]);
    });

    it('keeps same group id snapshots isolated across workspaces', () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'Workspace A',
            1,
            ['session-a'],
            {
                workspaceId: 'workspace-a',
            },
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'Workspace B',
            1,
            ['session-b'],
            {
                workspaceId: 'workspace-b',
            },
        );

        expect(setGroupStateSnapshots([workspaceA, workspaceB])).toBe(true);

        expect(
            getAllGroupStateSnapshots()
                .map((snapshot) => ({
                    workspaceId: snapshot.group.workspaceId,
                    displayName: snapshot.group.displayName,
                }))
                .sort((left, right) =>
                    (left.workspaceId ?? '').localeCompare(right.workspaceId ?? '')
                ),
        ).toEqual([
            {
                workspaceId: 'workspace-a',
                displayName: 'Workspace A',
            },
            {
                workspaceId: 'workspace-b',
                displayName: 'Workspace B',
            },
        ]);
        expect(findGroupStateSnapshotByRef(workspaceA.group)).toEqual(workspaceA);
        expect(findGroupStateSnapshotByRef(workspaceB.group)).toEqual(workspaceB);
        expect(findFirstGroupStateSnapshotRefSessionIdIsIn('session-b')).toEqual(
            workspaceB.group,
        );
    });

    it('uses group aggregate snapshotVersion for cache ordering', () => {
        const first = {
            ...createGroupSnapshot('group-1', 'Alpha', 1, ['self']),
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 1, ['self']).group,
                snapshotVersion: 10,
            },
        } satisfies GroupSnapshot;
        const staleBySnapshotVersion = {
            ...createGroupSnapshot('group-1', 'Alpha', 99, ['self', 'peer-stale']),
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 99, ['self', 'peer-stale']).group,
                snapshotVersion: 9,
            },
        } satisfies GroupSnapshot;
        const newer = {
            ...createGroupSnapshot('group-1', 'Alpha', 2, ['self', 'peer-a']),
            group: {
                ...createGroupSnapshot('group-1', 'Alpha', 2, ['self', 'peer-a']).group,
                snapshotVersion: 11,
            },
        } satisfies GroupSnapshot;

        expect(readGroupVersion(first)).toBe(10);
        expect(setGroupStateSnapshot(first)).toBe(true);
        expect(setGroupStateSnapshot(staleBySnapshotVersion)).toBe(false);
        expect(findGroupStateSnapshotByRef(first.group)).toEqual(first);
        expect(setGroupStateSnapshot(newer)).toBe(true);
        expect(findGroupStateSnapshotByRef(newer.group)).toEqual(newer);
    });

    it('uses group stateRevision before legacy snapshotVersion', () => {
        const accepted = {
            ...createGroupSnapshot('group-1', 'Alpha', 1, ['session-new']),
            stateRevision: 2,
        } satisfies GroupSnapshot;
        const stale = {
            ...createGroupSnapshot('group-1', 'Stale', 99, ['session-stale']),
            stateRevision: 1,
        } satisfies GroupSnapshot;
        const conflict = {
            ...accepted,
            onlineMemberCount: 0,
        } satisfies GroupSnapshot;

        expect(setGroupStateSnapshot(accepted)).toBe(true);
        expect(setGroupStateSnapshot(stale)).toBe(false);
        expect(findGroupStateSnapshotByRef(accepted.group)).toEqual(accepted);
        expect(() => setGroupStateSnapshot(conflict))
            .toThrow('Group snapshot revision conflict');
    });

    it('emits group snapshot changes only for accepted writes', async () => {
        const changes: string[] = [];
        const unsubscribe = onGroupStateSnapshotChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = createGroupSnapshot('group-1', 'Alpha', 1, ['self']);
            const refreshed = {
                ...first,
                group: {
                    ...first.group,
                    updated: {
                        ...first.group.updated,
                        atEpochMs: first.group.updated.atEpochMs + 1,
                    },
                },
            } satisfies GroupSnapshot;
            const stale = createGroupSnapshot('group-1', 'Alpha', 0, ['self']);
            const newer = createGroupSnapshot('group-1', 'Alpha', 2, [
                'self',
                'peer-a',
            ]);

            expect(setGroupStateSnapshot(first)).toBe(true);
            expect(setGroupStateSnapshot(first)).toBe(false);
            expect(setGroupStateSnapshot(refreshed)).toBe(false);
            expect(setGroupStateSnapshot(stale)).toBe(false);
            expect(setGroupStateSnapshot(newer)).toBe(true);
            await waitForGroupStateSnapshotChangesIdle();

            expect(findGroupStateSnapshotByRef(newer.group)).toEqual(newer);
            expect(changes).toEqual(['created', 'refreshed', 'updated']);
        } finally {
            unsubscribe();
        }
    });

    it('stores overlays by overlay id and preserves newer versions', () => {
        const group = createGroupSnapshot('group-1', 'Alpha', 2, [
            'self',
            'peer-a',
            'peer-b',
        ]);
        const overlayId = toScopedOverlayId(group.group);

        createAndSetStarOverlays([group]);

        expect(findOverlayById(overlayId)).toEqual({
            overlayId,
            groupRef: group.group,
            topology: 'star',
            name: 'Alpha',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['self', 'peer-a', 'peer-b'],
            overlayVersion: 2,
            updatedAtEpochMs: 2,
        });

        const staleOverlay = {
            ...(findOverlayById(overlayId) as OverlayInfo),
            nextHopSessionIds: ['peer-z'],
            overlayVersion: 1,
        };

        setOverlayById(overlayId, staleOverlay);
        expect(findOverlayById(overlayId)?.nextHopSessionIds).toEqual([
            'self',
            'peer-a',
            'peer-b',
        ]);

        expect(updateNextHopSessionIds(overlayId, ['peer-c'])).toMatchObject({
            overlayId,
            nextHopSessionIds: ['self', 'peer-a', 'peer-b'],
        });
        expect(findOverlayById(overlayId)?.nextHopSessionIds).toEqual(['peer-c']);
        expect(getAllOverlays()).toHaveLength(1);
    });

    it('emits overlay changes only for accepted writes and deletes', async () => {
        const changes: string[] = [];
        const unsubscribe = onOverlayChange((change) => {
            changes.push(change.kind);
        });

        try {
            const first = {
                overlayId: 'group-1',
                name: 'Alpha',
                createdByClientId: 'owner',
                createdAtEpochMs: 1,
                nextHopSessionIds: ['self'],
                overlayVersion: 1,
                updatedAtEpochMs: 1,
            } satisfies OverlayInfo;
            const stale = {
                ...first,
                nextHopSessionIds: ['peer-stale'],
                overlayVersion: 0,
            } satisfies OverlayInfo;
            const newer = {
                ...first,
                nextHopSessionIds: ['self', 'peer-a'],
                overlayVersion: 2,
                updatedAtEpochMs: 2,
            } satisfies OverlayInfo;

            setOverlayById('group-1', first);
            setOverlayById('group-1', first);
            setOverlayById('group-1', stale);
            setOverlayById('group-1', newer);
            expect(removeOverlayById('group-1')).toBe(true);
            await waitForOverlayChangesIdle();

            expect(changes).toEqual(['created', 'updated', 'deleted']);
            expect(findOverlayById('group-1')).toBeUndefined();
        } finally {
            unsubscribe();
        }
    });

    it('orders revisioned overlays by source group revision and retains removal tombstones', () => {
        const first = {
            overlayId: 'overlay-1',
            sourceGroupStateRevision: 2,
            state: 'active',
            name: 'Room',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['peer-a'],
            overlayVersion: 1,
            updatedAtEpochMs: 2,
        } satisfies OverlayInfo;
        setOverlayById(first.overlayId, first);
        setOverlayById(first.overlayId, {
            ...first,
            sourceGroupStateRevision: 1,
            overlayVersion: 99,
            nextHopSessionIds: ['stale-peer'],
        });
        expect(findOverlayById(first.overlayId)).toEqual(first);

        const removed = {
            ...first,
            sourceGroupStateRevision: 3,
            state: 'removed',
            nextHopSessionIds: [],
        } satisfies OverlayInfo;
        setOverlayById(first.overlayId, removed);
        expect(findOverlayById(first.overlayId)).toBeUndefined();
        expect(getAllOverlays()).toEqual([]);

        setOverlayById(first.overlayId, first);
        expect(findOverlayById(first.overlayId)).toBeUndefined();
    });

    it('normalizes RTT pair keys and keeps only newer measurements', () => {
        const older = createRttMeasurement('peer-b', 'peer-a', 1, 10);
        const newer = createRttMeasurement('peer-a', 'peer-b', 2, 20);

        expect(pairKey('peer-a', 'peer-b')).toBe(pairKey('peer-b', 'peer-a'));
        expect(setRtt(older)).toBe(true);
        expect(setRttById(pairKey('peer-a', 'peer-b'), older)).toBe(false);
        expect(setRtt(newer)).toBe(true);
        expect(getAllRtt()).toEqual([newer]);
    });

    it('requires explicit configuration and isolates custom managers', () => {
        const isolatedManager = new RepositoryManager();

        expect(() => readableClientStateSnapshotCache(isolatedManager)).toThrow(
            'Repository not found: shared.repository.client-state-snapshots',
        );

        configureClientStateSnapshotRepository({ ttlMs: 5_000 }, isolatedManager);
        setClientStateSnapshotByPrincipalId(
            'client-iso',
            createClientSnapshot('client-iso', 'session-iso', 1),
            isolatedManager,
        );

        expect(
            findClientStateSnapshotByPrincipalId('client-iso', isolatedManager)
                ?.activeSessions[0]
                ?.sessionId,
        ).toBe('session-iso');
        expect(findClientStateSnapshotByPrincipalId('client-iso')).toBeUndefined();
    });
});

function createClientSnapshot(
    principalId: string,
    sessionId: string | undefined,
    version: number,
): ClientSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const activeSessions = sessionId
        ? [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            status: 'active' as const,
            presenceState: 'online' as const,
            transport: 'ws' as const,
            authenticatedAtEpochMs: version,
            connectedAtEpochMs: version,
            lastHeartbeatAtEpochMs: version,
            expiresAtEpochMs: version + 60_000,
        }]
        : [];

    return {
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: version,
            profileVersion: 0,
            presenceVersion: version,
            created: {
                atEpochMs: 1,
                byPrincipalId: principalId,
            },
            updated: {
                atEpochMs: version,
                byPrincipalId: principalId,
            },
            lastSeenAtEpochMs: sessionId ? version : undefined,
        },
        instances: sessionId
            ? [{
                applicationId,
                workspaceId,
                principalId,
                clientInstanceId: `${principalId}-instance`,
                status: 'active',
                platform: 'web',
                capabilities: [],
                registered: {
                    atEpochMs: 1,
                    byPrincipalId: principalId,
                },
                updated: {
                    atEpochMs: version,
                    byPrincipalId: principalId,
                },
            }]
            : [],
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs: sessionId ? version : undefined,
    };
}

function createGroupSnapshot(
    groupId: string,
    displayName: string,
    membershipVersion: number,
    memberSessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';

    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'owner',
            },
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member' as const,
            status: 'active' as const,
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: membershipVersion,
            expiresAtEpochMs: membershipVersion + 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function createRttMeasurement(
    sessionIdFrom: string,
    sessionIdTo: string,
    version: number,
    rttMs: number,
): RttMeasurementInfo {
    return {
        sessionIdFrom,
        sessionIdTo,
        version,
        rttMs,
        createdAtEpochMs: version,
    };
}
