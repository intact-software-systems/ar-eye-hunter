import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    GroupMember,
    GroupPresenceSession,
    GroupRole,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-policy.ts';
import { SpaStatisticsService } from '@shared-server/rallar-system/spa-statistics/SpaStatisticsService.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('SpaStatisticsService', () => {
    it('summarizes only full-readable workspace groups and redacts other session ids', async () => {
        const service = createService({
            clients: {
                alice: createClientSnapshot('alice', ['alice-session', 'alice-phone']),
            },
            groups: [
                createGroupSnapshot('room-1', [
                    ['alice', 'member'],
                    ['bob', 'member'],
                ], [
                    ['alice', 'alice-session'],
                    ['bob', 'bob-session'],
                ]),
                createGroupSnapshot('room-2', [
                    ['carol', 'owner'],
                ], [
                    ['carol', 'carol-session'],
                ]),
                createGroupSnapshot('room-3', [
                    ['alice', 'owner'],
                ], [
                    ['alice', 'alice-phone'],
                ]),
            ],
            groupEventCounts: {
                'room-1': 2,
                'room-3': 1,
            },
        });

        const summary = await service.readWorkspaceSummary({
            scope: TEST_SCOPE,
            authSession: createAuthSession('alice', 'alice-session'),
        });

        expect(summary).toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            scope: TEST_SCOPE,
            actor: {
                principalId: 'alice',
                sessionId: 'alice-session',
                activeClientSessionCount: 2,
                groupPresenceCount: 2,
            },
            groups: {
                fullReadableCount: 2,
                joinedCount: 2,
                onlineMemberCount: 3,
            },
            activity: {
                recentVisibleGroupEventCount: {
                    count: 3,
                    limit: 20,
                    bounded: true,
                },
            },
        });
        expect(summary.warnings.map((warning) => warning.code)).toEqual([
            'policy-filtered-scan',
            'bounded-snapshot-scan',
            'bounded-recent-events',
        ]);
        expect(summary.topGroups).toEqual([
            {
                groupRef: {
                    ...TEST_SCOPE,
                    groupId: 'room-1',
                },
                displayName: 'Room room-1',
                kind: 'room',
                status: 'active',
                joinMode: 'invite-only',
                memberCount: 2,
                onlineMemberCount: 2,
                activeSessionCount: 2,
                snapshotVersion: 1,
                presenceVersion: 1,
            },
            {
                groupRef: {
                    ...TEST_SCOPE,
                    groupId: 'room-3',
                },
                displayName: 'Room room-3',
                kind: 'room',
                status: 'active',
                joinMode: 'invite-only',
                memberCount: 1,
                onlineMemberCount: 1,
                activeSessionCount: 1,
                snapshotVersion: 1,
                presenceVersion: 1,
            },
        ]);
        expect(JSON.stringify(summary)).not.toContain('bob-session');
        expect(JSON.stringify(summary)).not.toContain('carol-session');
    });

    it('returns group stats for active members and denies non-members', async () => {
        const service = createService({
            groups: [
                createGroupSnapshot('room-1', [
                    ['alice', 'member'],
                    ['owner', 'owner'],
                ], [
                    ['alice', 'alice-session'],
                    ['owner', 'owner-session'],
                ]),
            ],
            groupEventCounts: {
                'room-1': 4,
            },
        });

        const stats = await service.readGroupStats({
            scope: TEST_SCOPE,
            groupId: 'room-1',
            authSession: createAuthSession('alice', 'alice-session'),
        });

        expect(stats).toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            scope: TEST_SCOPE,
            groupRef: {
                ...TEST_SCOPE,
                groupId: 'room-1',
            },
            actor: {
                principalId: 'alice',
                sessionId: 'alice-session',
                role: 'member',
                activePresenceSessionCount: 1,
            },
            group: {
                groupId: 'room-1',
                displayName: 'Room room-1',
                kind: 'room',
                status: 'active',
                joinMode: 'invite-only',
                memberCount: 2,
                onlineMemberCount: 2,
                activeSessionCount: 2,
                snapshotVersion: 1,
                presenceVersion: 1,
            },
            activity: {
                recentGroupEventCount: {
                    count: 4,
                    limit: 20,
                    bounded: true,
                },
            },
        });
        expect(stats.owner).toBeUndefined();
        expect(JSON.stringify(stats)).not.toContain('owner-session');

        await expect(service.readGroupStats({
            scope: TEST_SCOPE,
            groupId: 'room-1',
            authSession: createAuthSession('carol', 'carol-session'),
        })).rejects.toBeInstanceOf(GroupPolicyDeniedError);
    });

    it('returns self-only realtime readiness without leaking unreadable groups', async () => {
        const service = createService({
            clients: {
                alice: createClientSnapshot('alice', ['alice-session', 'alice-phone']),
            },
            groups: [
                createGroupSnapshot('room-1', [
                    ['alice', 'member'],
                    ['bob', 'member'],
                ], [
                    ['alice', 'alice-session'],
                    ['bob', 'bob-session'],
                ]),
                createGroupSnapshot('room-2', [
                    ['bob', 'owner'],
                ], [
                    ['bob', 'bob-session'],
                ]),
                createGroupSnapshot('room-3', [
                    ['alice', 'owner'],
                ], [
                    ['alice', 'alice-phone'],
                ]),
            ],
            openConnectionIds: ['alice-session', 'bob-session'],
        });

        const status = await service.readMyRealtimeStatus({
            scope: TEST_SCOPE,
            authSession: createAuthSession('alice', 'alice-session'),
        });

        expect(status).toMatchObject({
            generatedAtEpochMs: NOW_EPOCH_MS,
            scope: TEST_SCOPE,
            actor: {
                principalId: 'alice',
                sessionId: 'alice-session',
            },
            realtime: {
                processLocal: true,
                currentSessionOpen: true,
            },
            clientState: {
                activeClientSessionCount: 2,
                currentSessionInClientState: true,
            },
            groupPresence: {
                activeGroupPresenceCount: 1,
                groups: [
                    {
                        groupRef: {
                            ...TEST_SCOPE,
                            groupId: 'room-1',
                        },
                        displayName: 'Room room-1',
                        kind: 'room',
                        status: 'active',
                        joinMode: 'invite-only',
                        actorSessionPresent: true,
                    },
                ],
            },
        });
        expect(status.warnings.map((warning) => warning.code)).toEqual([
            'process-local-realtime',
            'group-presence-filtered',
        ]);
        expect(JSON.stringify(status)).not.toContain('bob-session');
        expect(JSON.stringify(status)).not.toContain('room-2');
        expect(JSON.stringify(status)).not.toContain('room-3');
    });

    it('uses bounded group snapshot pages for workspace and realtime statistics', async () => {
        const groups = [
            createGroupSnapshot('room-1', [
                ['alice', 'member'],
            ], [
                ['alice', 'alice-session'],
            ]),
        ];
        let unboundedScanCount = 0;
        let boundedScanCount = 0;
        const service = new SpaStatisticsService({
            now: () => NOW_EPOCH_MS,
            clientStateService: {
                readSnapshot: () => Promise.resolve(createClientSnapshot('alice', ['alice-session'])),
                readPresenceSnapshot: () => Promise.resolve(undefined),
            },
            groupStateService: {
                listSnapshots: () => {
                    unboundedScanCount += 1;
                    throw new Error('unbounded group snapshot scan');
                },
                listSnapshotsPage: () => {
                    boundedScanCount += 1;
                    return Promise.resolve({
                        snapshots: groups,
                        scannedGroupCount: groups.length,
                        hasMore: true,
                    });
                },
                readSnapshot: (ref: { groupId: string }) =>
                    Promise.resolve(groups.find((group) => group.group.groupId === ref.groupId)),
                listRecentEvents: () => Promise.resolve([]),
            } as never,
            wsStatus: () => ({
                transport: 'ws-server',
                connectionCount: 1,
                openConnectionCount: 1,
                connectionIds: ['alice-session'],
                openConnectionIds: ['alice-session'],
                connections: [{ connectionId: 'alice-session', isOpen: true }],
            }),
        });

        const summary = await service.readWorkspaceSummary({
            scope: TEST_SCOPE,
            authSession: createAuthSession('alice', 'alice-session'),
        });
        const realtime = await service.readMyRealtimeStatus({
            scope: TEST_SCOPE,
            authSession: createAuthSession('alice', 'alice-session'),
        });

        expect(unboundedScanCount).toBe(0);
        expect(boundedScanCount).toBe(2);
        expect(summary.groups.fullReadableCount).toBe(1);
        expect(summary.warnings.map((warning) => warning.code)).toContain(
            'bounded-snapshot-scan',
        );
        expect(realtime.groupPresence.activeGroupPresenceCount).toBe(1);
        expect(realtime.warnings.map((warning) => warning.code)).toContain(
            'bounded-snapshot-scan',
        );
    });

    it('caps visible recent event counts to the advertised workspace limit', async () => {
        const service = createService({
            groups: [
                createGroupSnapshot('room-1', [
                    ['alice', 'member'],
                ]),
                createGroupSnapshot('room-2', [
                    ['alice', 'owner'],
                ]),
            ],
            groupEventCounts: {
                'room-1': 20,
                'room-2': 20,
            },
        });

        const summary = await service.readWorkspaceSummary({
            scope: TEST_SCOPE,
            authSession: createAuthSession('alice', 'alice-session'),
        });

        expect(summary.activity.recentVisibleGroupEventCount).toEqual({
            count: 20,
            limit: 20,
            bounded: true,
        });
    });
});

type TestServiceInput = Readonly<{
    clients?: Readonly<Record<string, ClientSnapshot>>;
    groups?: readonly GroupSnapshot[];
    groupEventCounts?: Readonly<Record<string, number>>;
    openConnectionIds?: readonly string[];
}>;

function createService(input: TestServiceInput): SpaStatisticsService {
    const clients = input.clients ?? {};
    const groups = input.groups ?? [];
    const groupEventCounts = input.groupEventCounts ?? {};
    const openConnectionIds = input.openConnectionIds ?? [];

    return new SpaStatisticsService({
        now: () => NOW_EPOCH_MS,
        clientStateService: {
            readSnapshot: (ref) => Promise.resolve(clients[ref.principalId]),
            readPresenceSnapshot: (ref) =>
                Promise.resolve(
                    clients[ref.principalId]
                        ? {
                            ...TEST_SCOPE,
                            principalId: ref.principalId,
                            presenceVersion: 1,
                            isOnline: clients[ref.principalId]?.isOnline ?? false,
                            presenceState: clients[ref.principalId]?.isOnline ? 'online' : 'offline',
                            activeSessions: clients[ref.principalId]?.activeSessions ?? [],
                        }
                        : undefined,
                ),
        },
        groupStateService: {
            listSnapshots: () => Promise.resolve(groups),
            listSnapshotsPage: (_scope, options) => {
                const selected = groups.slice(0, options.limit);
                return Promise.resolve({
                    snapshots: selected,
                    scannedGroupCount: selected.length,
                    hasMore: groups.length > selected.length,
                    nextGroupKey: selected.at(-1)?.group.groupId,
                });
            },
            readSnapshot: (ref) =>
                Promise.resolve(groups.find((group) => group.group.groupId === ref.groupId)),
            listRecentEvents: (ref, query) =>
                Promise.resolve(Array.from(
                    { length: Math.min(groupEventCounts[ref.groupId] ?? 0, query.limit ?? 20) },
                    (_, index) => ({
                        ...TEST_SCOPE,
                        groupId: ref.groupId,
                        eventId: `${ref.groupId}-event-${index}`,
                        eventType: 'session-connected' as const,
                        snapshotVersion: index + 1,
                        occurredAtEpochMs: NOW_EPOCH_MS + index,
                        actor: {},
                    }),
                )),
        },
        wsStatus: () => ({
            transport: 'ws-server',
            connectionCount: openConnectionIds.length,
            openConnectionCount: openConnectionIds.length,
            connectionIds: openConnectionIds,
            openConnectionIds,
            connections: openConnectionIds.map((connectionId) => ({
                connectionId,
                isOpen: true,
            })),
        }),
    });
}

function createAuthSession(clientId: string, sessionId: string): AuthSession {
    return {
        clientId,
        username: clientId,
        accessToken: `${clientId}-token`,
        sessionId,
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
    };
}

function createClientSnapshot(
    principalId: string,
    sessionIds: readonly string[],
): ClientSnapshot {
    const sessions: readonly ClientSession[] = sessionIds.map((sessionId) => ({
        ...TEST_SCOPE,
        principalId,
        clientInstanceId: `${principalId}-instance`,
        sessionId,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: sessionId,
        authenticatedAtEpochMs: NOW_EPOCH_MS,
        connectedAtEpochMs: NOW_EPOCH_MS,
        lastHeartbeatAtEpochMs: NOW_EPOCH_MS,
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
    }));

    return {
        principal: {
            ...TEST_SCOPE,
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: NOW_EPOCH_MS },
            updated: { atEpochMs: NOW_EPOCH_MS },
            lastSeenAtEpochMs: NOW_EPOCH_MS,
        },
        instances: [],
        activeSessions: sessions,
        isOnline: sessions.length > 0,
        activeSessionCount: sessions.length,
        lastSeenAtEpochMs: NOW_EPOCH_MS,
    };
}

function createGroupSnapshot(
    groupId: string,
    members: readonly (readonly [string, GroupRole])[],
    sessions: readonly (readonly [string, string])[] = [],
): GroupSnapshot {
    const groupMembers: readonly GroupMember[] = members.map(([principalId, role]) => ({
        ...TEST_SCOPE,
        groupId,
        principalId,
        role,
        status: 'active',
        joined: { atEpochMs: NOW_EPOCH_MS },
        updated: { atEpochMs: NOW_EPOCH_MS },
    }));
    const activeSessions: readonly GroupPresenceSession[] = sessions.map((
        [principalId, sessionId],
    ) => ({
        ...TEST_SCOPE,
        groupId,
        principalId,
        sessionId,
        connectedAtEpochMs: NOW_EPOCH_MS,
        lastHeartbeatAtEpochMs: NOW_EPOCH_MS,
        expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
    }));

    return {
        group: {
            ...TEST_SCOPE,
            groupId,
            displayName: `Room ${groupId}`,
            kind: 'room',
            status: 'active',
            joinMode: 'invite-only',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: { atEpochMs: NOW_EPOCH_MS },
            updated: { atEpochMs: NOW_EPOCH_MS },
        },
        members: groupMembers,
        activeSessions,
        memberCount: groupMembers.length,
        onlineMemberCount: new Set(activeSessions.map((session) => session.principalId)).size,
    };
}
