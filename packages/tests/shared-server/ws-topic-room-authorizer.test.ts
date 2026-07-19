import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { GroupPresenceSummary, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    findGroupStateSnapshotByRef,
    setGroupStateSnapshot,
} from '@shared/repository/group-state-snapshots-repository.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('createGroupRoomWsAuthorizer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('authorizes room messages with a scoped group snapshot resolver when same group id exists in multiple workspaces', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            resolveGroupRef: (input) => ({
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: input.roomId,
            }),
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' },
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toBe(true);
    });

    it('authorizes multicast messages using target groupRef without an external resolver', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-1'),
                workspaceB.group,
                'chat.message.v1',
                { text: 'workspace-b' },
            ),
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toBe(true);
    });

    it('authorizes room broadcasts using target groupRef without an external resolver', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' },
            {
                groupRef: workspaceB.group,
            },
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toBe(true);
    });

    it('hydrates a cold group snapshot cache from durable state before authorizing', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(runtimeRepository);
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            3,
        );
        await putDurableSnapshot(groupRepository, group);

        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository,
        });
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotByRef: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion,
                }),
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'cold cache' },
            {
                groupRef: group.group,
                minSnapshotVersion: 3,
            },
        );

        expect(findGroupStateSnapshotByRef(group.group)).toBeUndefined();

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 3,
        }));

        expect(decision).toBe(true);
        expect(findGroupStateSnapshotByRef(group.group)?.group.snapshotVersion).toBe(3);
    });

    it('refreshes a stale cached group snapshot when the message requires a newer version', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(runtimeRepository);
        const staleGroup = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const currentGroup = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            4,
        );
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository,
        });
        await putDurableSnapshot(groupRepository, staleGroup);
        expect(await readThroughCache.findOrLoadByRef(staleGroup.group)).toEqual({
            ...staleGroup,
            stateRevision: 2,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        expect(
            findGroupStateSnapshotByRef(staleGroup.group)?.group.snapshotVersion,
        ).toBe(1);
        await putDurableSnapshot(groupRepository, currentGroup);

        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotByRef: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion,
                }),
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-2'),
                currentGroup.group,
                'chat.message.v1',
                { text: 'refresh stale cache' },
                {
                    minSnapshotVersion: 4,
                },
            ),
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 4,
        }));

        expect(decision).toBe(true);
        expect(
            findGroupStateSnapshotByRef(currentGroup.group)?.group.snapshotVersion,
        ).toBe(4);
    });

    it('refreshes and rejects a warm snapshot when its embedded session has expired', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(0);
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(runtimeRepository);
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            3,
            1_000,
        );
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository,
        });
        await putDurableSnapshot(groupRepository, group);
        await expect(readThroughCache.findOrLoadByRef(group.group)).resolves.toEqual({
            ...group,
            stateRevision: 4,
            causalRevision: { groupRevision: 1, presenceRevision: 3 },
        });

        vi.setSystemTime(1_001);

        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotByRef: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion,
                }),
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'expired session' },
            {
                groupRef: group.group,
            },
        );

        await expect(Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }))).resolves.toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('member-not-active'),
        });
        expect(findGroupStateSnapshotByRef(group.group)?.activeSessions).toEqual([]);
    });

    it('rejects archived and deleted room messages with lifecycle policy details', async () => {
        for (const status of ['archived', 'deleted'] as const) {
            const group = createGroupSnapshot(
                `shared-room-${status}`,
                'app-1',
                'workspace-b',
                ['session-b'],
                3,
            );
            const snapshot: GroupSnapshot = {
                ...group,
                group: {
                    ...group.group,
                    status,
                },
            };
            const authorizer = createGroupRoomWsAuthorizer({
                findGroupSnapshotById: () => snapshot,
            });
            const message = newALBroadcastMessage(
                'session-b',
                newALEventRoute('room.chat', snapshot.group.groupId, `msg-${status}`),
                'room',
                'chat.message.v1',
                { text: status },
            );

            const decision = await Promise.resolve(authorizer({
                message,
                roomId: snapshot.group.groupId,
                senderId: 'session-b',
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
            }));

            expect(decision).toMatchObject({
                authorized: false,
                reason: 'unauthorized',
                logMessage: expect.stringContaining(`group-${status}`),
            });
        }
    });

    it('returns stable policy details for missing live sessions and blocked members', async () => {
        const cases = [
            {
                name: 'missing-session',
                snapshot: withoutActiveSessions(
                    createGroupSnapshot(
                        'room-missing-session',
                        'app-1',
                        'workspace-b',
                        ['session-b'],
                        3,
                    ),
                ),
                expectedCode: 'member-not-active',
            },
            {
                name: 'removed-member',
                snapshot: withMemberStatus(
                    createGroupSnapshot(
                        'room-removed-member',
                        'app-1',
                        'workspace-b',
                        ['session-b'],
                        3,
                    ),
                    'removed',
                ),
                expectedCode: 'member-removed',
            },
            {
                name: 'banned-member',
                snapshot: withMemberStatus(
                    createGroupSnapshot(
                        'room-banned-member',
                        'app-1',
                        'workspace-b',
                        ['session-b'],
                        3,
                    ),
                    'banned',
                ),
                expectedCode: 'member-banned',
            },
        ] as const;

        for (const { name, snapshot, expectedCode } of cases) {
            const authorizer = createGroupRoomWsAuthorizer({
                findGroupSnapshotById: () => snapshot,
                now: () => 1,
            });
            const message = newALBroadcastMessage(
                'session-b',
                newALEventRoute('room.chat', snapshot.group.groupId, `msg-${name}`),
                'room',
                'chat.message.v1',
                { text: name },
            );

            const decision = await Promise.resolve(authorizer({
                message,
                roomId: snapshot.group.groupId,
                senderId: 'session-b',
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
            }));

            expect(decision).toMatchObject({
                authorized: false,
                reason: 'unauthorized',
                logMessage: expect.stringContaining(expectedCode),
            });
        }
    });

    it('refreshes stale snapshots and rejects banned members without a live session', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(runtimeRepository);
        const staleGroup = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const currentGroup = withMemberStatus(
            createGroupSnapshot(
                'shared-room',
                'app-1',
                'workspace-b',
                ['session-b'],
                4,
            ),
            'banned',
        );
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository,
        });
        await putDurableSnapshot(groupRepository, staleGroup);
        await expect(readThroughCache.findOrLoadByRef(staleGroup.group)).resolves.toEqual({
            ...staleGroup,
            stateRevision: 2,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        });
        await putDurableSnapshot(groupRepository, currentGroup);

        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotByRef: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion,
                }),
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-banned'),
                currentGroup.group,
                'chat.message.v1',
                { text: 'refresh banned member' },
                {
                    minSnapshotVersion: 4,
                },
            ),
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 4,
        }));

        expect(decision).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('member-not-active'),
            serverSnapshotVersion: 4,
        });
        expect(findGroupStateSnapshotByRef(currentGroup.group)?.group.snapshotVersion).toBe(
            4,
        );
    });

    it('returns a stable denial when a scoped target does not match the available snapshot', async () => {
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            ['session-a'],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const authorizer = createGroupRoomWsAuthorizer({
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: () => undefined,
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-scope'),
            'room',
            'chat.message.v1',
            { text: 'wrong scope' },
            {
                groupRef: workspaceB.group,
            },
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
        }));

        expect(decision).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('scope'),
        });
    });
});

function withoutActiveSessions(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: [],
        onlineMemberCount: 0,
    };
}

function withMemberStatus(
    snapshot: GroupSnapshot,
    status: GroupSnapshot['members'][number]['status'],
): GroupSnapshot {
    if (status === 'active') {
        return snapshot;
    }
    const target = snapshot.members[0]!;
    const fixtureOwner = {
        ...target,
        principalId: 'fixture-owner',
        role: 'owner' as const,
        status: 'active' as const,
    };
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            ownerPrincipalId: fixtureOwner.principalId,
            activeMemberCount: 1,
        },
        members: [...snapshot.members.map((member) => ({
            ...member,
            role: 'member' as const,
            status,
        })), fixtureOwner],
        memberCount: 1,
    };
}

async function putDurableSnapshot(
    repository: GroupStateRepository,
    snapshot: GroupSnapshot,
): Promise<void> {
    await repository.putGroup(snapshot.group);
    await Promise.all(snapshot.members.map((member) => repository.putMember(member)));
    await Promise.all(
        snapshot.activeSessions.map((session) =>
            repository.putPresenceSession(session)
        ),
    );
    const group = await repository.findGroupEntry(snapshot.group);
    if (!group) {
        throw new Error('Expected persisted group');
    }
    const current = await repository.findPresenceSummaryEntry(snapshot.group);
    const summary: GroupPresenceSummary = {
        ...snapshot.group,
        causalRevision: {
            groupRevision: group.entry.revision + 1,
            presenceRevision: snapshot.group.presenceVersion,
        },
        activePrincipalIds: snapshot.activeSessions.map((session) =>
            session.principalId
        ),
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        activeSessions: snapshot.activeSessions,
        activePrincipalCount: snapshot.onlineMemberCount,
        activeSessionCount: snapshot.activeSessions.length,
        computedAtEpochMs: snapshot.group.updated.atEpochMs,
    };
    if (current) {
        await repository.updatePresenceSummary(summary, current.entry.revision);
    } else {
        await repository.insertPresenceSummary(summary);
    }
}

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    sessionIds: readonly string[],
    snapshotVersion: number,
    expiresAtEpochMs = 4_000_000_000_000,
): GroupSnapshot {
    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            ownerPrincipalId: sessionIds[0]!,
            activeMemberCount: sessionIds.length,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
