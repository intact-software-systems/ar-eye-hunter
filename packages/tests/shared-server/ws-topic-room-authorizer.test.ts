import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
} from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
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
        await groupRepository.putGroup(group.group);
        await groupRepository.putMember(group.members[0]!);
        await groupRepository.putPresenceSession(group.activeSessions[0]!);

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
        await groupRepository.putGroup(staleGroup.group);
        await groupRepository.putMember(staleGroup.members[0]!);
        await groupRepository.putPresenceSession(staleGroup.activeSessions[0]!);
        expect(await readThroughCache.findOrLoadByRef(staleGroup.group)).toEqual(
            staleGroup,
        );
        expect(
            findGroupStateSnapshotByRef(staleGroup.group)?.group.snapshotVersion,
        ).toBe(1);
        await groupRepository.putGroup(currentGroup.group);
        await groupRepository.putMember(currentGroup.members[0]!);
        await groupRepository.putPresenceSession(currentGroup.activeSessions[0]!);

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
        await groupRepository.putGroup(group.group);
        await groupRepository.putMember(group.members[0]!);
        await groupRepository.putPresenceSession(group.activeSessions[0]!);
        await expect(readThroughCache.findOrLoadByRef(group.group)).resolves.toEqual(
            group,
        );

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

    it('refreshes stale active snapshots and rejects a newer banned snapshot with policy details', async () => {
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
        await groupRepository.putGroup(staleGroup.group);
        await groupRepository.putMember(staleGroup.members[0]!);
        await groupRepository.putPresenceSession(staleGroup.activeSessions[0]!);
        await expect(readThroughCache.findOrLoadByRef(staleGroup.group)).resolves.toEqual(
            staleGroup,
        );
        await groupRepository.putGroup(currentGroup.group);
        await groupRepository.putMember(currentGroup.members[0]!);
        await groupRepository.putPresenceSession(currentGroup.activeSessions[0]!);

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
            logMessage: expect.stringContaining('member-banned'),
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
    return {
        ...snapshot,
        members: snapshot.members.map((member) => ({
            ...member,
            status,
        })),
        memberCount: status === 'active' ? snapshot.memberCount : 0,
    };
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
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
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
