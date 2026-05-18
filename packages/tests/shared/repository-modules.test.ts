import { beforeEach, describe, expect, it } from 'vitest';
import type { OverlayInfo, RttMeasurementInfo, } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readClientVersion, readGroupVersion } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureClientStateSnapshotRepository,
    findClientStateSnapshotByPrincipalId,
    getAllClientStateSnapshots,
    onClientStateSnapshotChange,
    readableClientStateSnapshotCache,
    setClientStateSnapshotByPrincipalId,
    waitForClientStateSnapshotChangesIdle,
} from '@shared/repository/client-state-snapshots-repository.ts';
import {
    findFirstGroupStateSnapshotIdSessionIdIsIn,
    findGroupStateSnapshotById,
    getAllGroupStateSnapshots,
    onGroupStateSnapshotChange,
    setGroupStateSnapshotById,
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

    it('stores group snapshots by group id, keeps newer versions, and finds memberships', () => {
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
        expect(findGroupStateSnapshotById('group-1')).toEqual(first);
        expect(findGroupStateSnapshotById('group-2')).toEqual(second);
        expect(findFirstGroupStateSnapshotIdSessionIdIsIn('peer-a')).toBe(
            'group-1',
        );
        expect(getAllGroupStateSnapshots()).toEqual([first, second]);

        expect(setGroupStateSnapshotById(first.group.groupId, stale)).toBe(false);
        expect(findGroupStateSnapshotById('group-1')).toEqual(first);
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
        expect(setGroupStateSnapshotById('group-1', first)).toBe(true);
        expect(setGroupStateSnapshotById('group-1', staleBySnapshotVersion)).toBe(false);
        expect(findGroupStateSnapshotById('group-1')).toEqual(first);
        expect(setGroupStateSnapshotById('group-1', newer)).toBe(true);
        expect(findGroupStateSnapshotById('group-1')).toEqual(newer);
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

            expect(setGroupStateSnapshotById('group-1', first)).toBe(true);
            expect(setGroupStateSnapshotById('group-1', first)).toBe(false);
            expect(setGroupStateSnapshotById('group-1', refreshed)).toBe(false);
            expect(setGroupStateSnapshotById('group-1', stale)).toBe(false);
            expect(setGroupStateSnapshotById('group-1', newer)).toBe(true);
            await waitForGroupStateSnapshotChangesIdle();

            expect(findGroupStateSnapshotById('group-1')).toEqual(newer);
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

        createAndSetStarOverlays([group]);

        expect(findOverlayById('group-1')).toEqual({
            overlayId: 'group-1',
            name: 'Alpha',
            createdByClientId: 'owner',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['self', 'peer-a', 'peer-b'],
            overlayVersion: 2,
            updatedAtEpochMs: 2,
        });

        const staleOverlay = {
            ...(findOverlayById('group-1') as OverlayInfo),
            nextHopSessionIds: ['peer-z'],
            overlayVersion: 1,
        };

        setOverlayById('group-1', staleOverlay);
        expect(findOverlayById('group-1')?.nextHopSessionIds).toEqual([
            'self',
            'peer-a',
            'peer-b',
        ]);

        expect(updateNextHopSessionIds('group-1', ['peer-c'])).toMatchObject({
            overlayId: 'group-1',
            nextHopSessionIds: ['self', 'peer-a', 'peer-b'],
        });
        expect(findOverlayById('group-1')?.nextHopSessionIds).toEqual(['peer-c']);
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
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

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
