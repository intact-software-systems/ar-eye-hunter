import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts';
import { createGroupRoomWsAuthorizer, type GroupRoomWsAuthorizerDependencies } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { newALBroadcastMessage, newALEventRoute, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { GROUP_LIFECYCLE_STATES } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { AuditStamp, Group, GroupMember, GroupPresenceSummary, GroupSnapshot } from '@shared/api/group-types.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('createGroupRoomWsAuthorizer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('authorizes multicast messages using target groupRef without an external resolver', async () => {
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-1'),
                workspaceB.group,
                'chat.message.v1',
                { text: 'workspace-b' }
            )
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        }));

        expect(decision).toBe(true);
    });

    it('authorizes room broadcasts using target groupRef without an external resolver', async () => {
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' },
            {
                groupRef: workspaceB.group
            }
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        }));

        expect(decision).toBe(true);
    });

    it('hydrates a cold group snapshot cache from durable state before authorizing', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = createTestGroupStateRepository(runtimeRepository);
        const group = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 3
        });
        await putDurableSnapshot(groupRepository, group);

        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository
        });
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion
                })
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'cold cache' },
            {
                groupRef: group.group,
                minSnapshotVersion: 3
            }
        );

        expect(findGroupStateSnapshotByRef(group.group)).toBeUndefined();

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 3
        }));

        expect(decision).toBe(true);
        expect(findGroupStateSnapshotByRef(group.group)?.group.snapshotVersion).toBe(3);
    });

    it('refreshes a stale cached group snapshot when the message requires a newer version', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = createTestGroupStateRepository(runtimeRepository);
        const staleGroup = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const currentGroup = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 4
        });
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository
        });
        await putDurableSnapshot(groupRepository, staleGroup);
        expect(await readThroughCache.findOrLoadByRef(staleGroup.group)).toEqual({
            ...staleGroup,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        expect(
            findGroupStateSnapshotByRef(staleGroup.group)?.group.snapshotVersion
        ).toBe(1);
        await putDurableSnapshot(groupRepository, currentGroup);

        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion
                })
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-2'),
                currentGroup.group,
                'chat.message.v1',
                { text: 'refresh stale cache' },
                {
                    minSnapshotVersion: 4
                }
            )
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 4
        }));

        expect(decision).toBe(true);
        expect(
            findGroupStateSnapshotByRef(currentGroup.group)?.group.snapshotVersion
        ).toBe(4);
    });

    it('refreshes and rejects a warm snapshot when its embedded session has expired', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(0);
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = createTestGroupStateRepository(runtimeRepository);
        const group = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 3,
            expiresAtEpochMs: 1_000
        });
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository
        });
        await putDurableSnapshot(groupRepository, group);
        await expect(readThroughCache.findOrLoadByRef(group.group)).resolves.toEqual({
            ...group,
            causalRevision: { groupRevision: 3, presenceRevision: 3 }
        });

        vi.setSystemTime(1_001);

        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion
                })
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'expired session' },
            {
                groupRef: group.group
            }
        );

        await expect(Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        }))).resolves.toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('member-not-active')
        });
        expect(findGroupStateSnapshotByRef(group.group)?.activeSessions).toEqual([]);
    });

    it('rejects room sends when a summary session is stale behind an authoritative disconnect', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = createTestGroupStateRepository(runtimeRepository);
        const group = createGroupSnapshot({
            groupId: 'stale-disconnect-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 3
        });
        await putDurableSnapshot(groupRepository, group);
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository
        });
        await expect(readThroughCache.findOrLoadByRef(group.group)).resolves
            .toMatchObject({ activeSessions: [{ sessionId: 'session-b' }] });
        const stored = await groupRepository.findPresenceEntry({
            ...group.group,
            sessionId: 'session-b'
        });
        if (!stored) {
            throw new Error('Expected persisted room session');
        }
        expect(
            await groupRepository.updatePresence({
                ...stored.value,
                status: 'disconnected',
                disconnectedAtEpochMs: 1_000,
                disconnectReason: 'client-disconnect'
            }, stored.entry.revision)
        ).toMatchObject({ status: 'applied' });

        const currentService = createCachedGroupStateService({
            durable: createGroupStateService({
                runtimeRepository,
                groupStateEventStore: runtimeRepository.groupStateEventStore,
                authSessionRepository: new AuthSessionRepository(runtimeRepository),
                serviceId: 'ws-room-authorizer-test',
                readPlannedLayoutRow: async () => null,
                readAcceptedLayoutRow: async () => null
            }),
            cache: {
                findOrLoadByRef: (ref, options) => readThroughCache.findOrLoadByRef(ref, options),
                observe: (snapshot) => readThroughCache.observe(snapshot)
            }
        });
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: (ref) => currentService.readCurrentSnapshot(ref)
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', group.group.groupId, 'msg-stale-disconnect'),
            'room',
            'chat.message.v1',
            { text: 'stale disconnect' },
            { groupRef: group.group }
        );

        await expect(Promise.resolve(authorizer({
            message,
            roomId: group.group.groupId,
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        }))).resolves.toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('member-not-active')
        });
        expect(readThroughCache.peek(group.group)?.activeSessions).toHaveLength(1);
    });

    it('denies halted application data without reading pre-activation policy', async () => {
        const snapshot = createGroupSnapshot({
            groupId: 'halted-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 3
        });
        for (const lifecycleState of GROUP_LIFECYCLE_STATES) {
            for (const preActivationAppData of ['allowed', 'blocked-until-active'] as const) {
                const haltedSnapshot: GroupSnapshot = {
                    ...snapshot,
                    group: {
                        ...snapshot.group,
                        lifecycleState,
                        transportState: 'halted'
                    }
                };
                const authorizer = createTestGroupRoomWsAuthorizer({
                    readGroupSnapshot: () => haltedSnapshot,
                    readPreActivationAppData: () => {
                        throw new Error(
                            `Halted application data must not read ${preActivationAppData} policy.`
                        );
                    }
                });
                const message = newALBroadcastMessage(
                    'session-b',
                    newALEventRoute('room.chat', haltedSnapshot.group.groupId, `msg-halted-${lifecycleState}-${preActivationAppData}`),
                    'room',
                    'chat.message.v1',
                    { text: 'halted' },
                    { groupRef: haltedSnapshot.group }
                );

                await expect(Promise.resolve(authorizer({
                    message,
                    roomId: haltedSnapshot.group.groupId,
                    senderId: 'session-b',
                    topicId: 'room.chat',
                    typeId: 'chat.message.v1'
                }))).resolves.toMatchObject({
                    authorized: false,
                    reason: 'unauthorized'
                });
            }
        }
    });

    it('allows CRDT while transport is halted without reading pre-activation policy', async () => {
        const snapshot = createGroupSnapshot({
            groupId: 'halted-crdt-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 3
        });
        const haltedSnapshot: GroupSnapshot = {
            ...snapshot,
            group: { ...snapshot.group, transportState: 'halted' }
        };
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: () => haltedSnapshot,
            readPreActivationAppData: () => {
                throw new Error('CRDT transport must not read pre-activation policy.');
            }
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.crdt', haltedSnapshot.group.groupId, 'msg-halted-crdt'),
            'room',
            'crdt.update.v1',
            { update: 'halted document' },
            { groupRef: haltedSnapshot.group }
        );

        await expect(Promise.resolve(authorizer({
            message,
            roomId: haltedSnapshot.group.groupId,
            senderId: 'session-b',
            topicId: 'room.crdt',
            typeId: 'crdt.update.v1'
        }))).resolves.toBe(true);
    });

    it('rejects archived and deleted room messages with lifecycle policy details', async () => {
        for (const status of ['archived', 'deleted'] as const) {
            const group = createGroupSnapshot({
                groupId: `shared-room-${status}`,
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                sessionIds: ['session-b'],
                snapshotVersion: 3
            });
            const snapshot: GroupSnapshot = {
                ...group,
                group: withGroupStatus(group.group, status)
            };
            const authorizer = createTestGroupRoomWsAuthorizer({
                readGroupSnapshot: () => snapshot
            });
            const message = newALBroadcastMessage(
                'session-b',
                newALEventRoute('room.chat', snapshot.group.groupId, `msg-${status}`),
                'room',
                'chat.message.v1',
                { text: status },
                { groupRef: snapshot.group }
            );

            const decision = await Promise.resolve(authorizer({
                message,
                roomId: snapshot.group.groupId,
                senderId: 'session-b',
                topicId: 'room.chat',
                typeId: 'chat.message.v1'
            }));

            expect(decision).toMatchObject({
                authorized: false,
                reason: 'unauthorized',
                logMessage: expect.stringContaining(`group-${status}`)
            });
        }
    });

    it('returns stable policy details for missing live sessions and blocked members', async () => {
        const cases = [
            {
                name: 'missing-session',
                snapshot: withoutActiveSessions(
                    createGroupSnapshot({
                        groupId: 'room-missing-session',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-b',
                        sessionIds: ['session-b'],
                        snapshotVersion: 3
                    })
                ),
                expectedCode: 'member-not-active'
            },
            {
                name: 'removed-member',
                snapshot: withMemberStatus(
                    createGroupSnapshot({
                        groupId: 'room-removed-member',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-b',
                        sessionIds: ['session-b'],
                        snapshotVersion: 3
                    }),
                    'removed'
                ),
                expectedCode: 'member-removed'
            },
            {
                name: 'banned-member',
                snapshot: withMemberStatus(
                    createGroupSnapshot({
                        groupId: 'room-banned-member',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-b',
                        sessionIds: ['session-b'],
                        snapshotVersion: 3
                    }),
                    'banned'
                ),
                expectedCode: 'member-banned'
            }
        ] as const;

        for (const { name, snapshot, expectedCode } of cases) {
            const authorizer = createTestGroupRoomWsAuthorizer({
                readGroupSnapshot: () => snapshot,
                nowEpochMs: () => 1
            });
            const message = newALBroadcastMessage(
                'session-b',
                newALEventRoute('room.chat', snapshot.group.groupId, `msg-${name}`),
                'room',
                'chat.message.v1',
                { text: name },
                { groupRef: snapshot.group }
            );

            const decision = await Promise.resolve(authorizer({
                message,
                roomId: snapshot.group.groupId,
                senderId: 'session-b',
                topicId: 'room.chat',
                typeId: 'chat.message.v1'
            }));

            expect(decision).toMatchObject({
                authorized: false,
                reason: 'unauthorized',
                logMessage: expect.stringContaining(expectedCode)
            });
        }
    });

    it('refreshes stale snapshots and rejects banned members without a live session', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const groupRepository = createTestGroupStateRepository(runtimeRepository);
        const staleGroup = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const currentGroup = withMemberStatus(
            createGroupSnapshot({
                groupId: 'shared-room',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                sessionIds: ['session-b'],
                snapshotVersion: 4
            }),
            'banned'
        );
        const readThroughCache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: groupRepository
        });
        await putDurableSnapshot(groupRepository, staleGroup);
        await expect(readThroughCache.findOrLoadByRef(staleGroup.group)).resolves.toEqual({
            ...staleGroup,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        await putDurableSnapshot(groupRepository, currentGroup);

        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: async (ref, input) =>
                await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion
                })
        });
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-banned'),
                currentGroup.group,
                'chat.message.v1',
                { text: 'refresh banned member' },
                {
                    minSnapshotVersion: 4
                }
            )
        };

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            minSnapshotVersion: 4
        }));

        expect(decision).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('member-not-active'),
            serverSnapshotVersion: 4
        });
        expect(findGroupStateSnapshotByRef(currentGroup.group)?.group.snapshotVersion).toBe(
            4
        );
    });

    it('returns a stable denial when a scoped target does not match the available snapshot', async () => {
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            sessionIds: ['session-a'],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const authorizer = createTestGroupRoomWsAuthorizer({
            readGroupSnapshot: () => workspaceA
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-scope'),
            'room',
            'chat.message.v1',
            { text: 'wrong scope' },
            {
                groupRef: workspaceB.group
            }
        );

        const decision = await Promise.resolve(authorizer({
            message,
            roomId: 'shared-room',
            senderId: 'session-b',
            topicId: 'room.chat',
            typeId: 'chat.message.v1'
        }));

        expect(decision).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            logMessage: expect.stringContaining('scope')
        });
    });
});

interface TestGroupRoomWsAuthorizerDependencies {
    readonly readGroupSnapshot: GroupRoomWsAuthorizerDependencies['readGroupSnapshot'];
    readonly readPreActivationAppData?: GroupRoomWsAuthorizerDependencies['readPreActivationAppData'];
    readonly nowEpochMs?: GroupRoomWsAuthorizerDependencies['nowEpochMs'];
}

function createTestGroupRoomWsAuthorizer(
    dependencies: TestGroupRoomWsAuthorizerDependencies
) {
    return createGroupRoomWsAuthorizer({
        readGroupSnapshot: dependencies.readGroupSnapshot,
        readPreActivationAppData: dependencies.readPreActivationAppData ?? (() => 'allowed'),
        nowEpochMs: dependencies.nowEpochMs ?? Date.now
    });
}

function withoutActiveSessions(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: [],
        onlineMemberCount: 0
    };
}

function withMemberStatus(
    snapshot: GroupSnapshot,
    status: 'removed' | 'banned'
): GroupSnapshot {
    const target = snapshot.members[0];
    if (!target) {
        throw new Error('Expected member fixture');
    }
    const fixtureOwner: GroupMember = {
        ...target,
        principalId: 'fixture-owner',
        role: 'owner',
        status: 'active',
        joined: target.updated,
        left: null,
        removed: null,
        banned: null
    };
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            ownerPrincipalId: fixtureOwner.principalId,
            activeMemberCount: 1
        },
        members: [
            ...snapshot.members.map((member): GroupMember =>
                status === 'removed'
                    ? {
                        ...member,
                        role: 'member',
                        status: 'removed',
                        left: null,
                        removed: member.updated,
                        banned: null
                    }
                    : {
                        ...member,
                        role: 'member',
                        status: 'banned',
                        left: null,
                        removed: null,
                        banned: member.updated
                    }
            ),
            fixtureOwner
        ],
        memberCount: 1
    };
}

async function putDurableSnapshot(
    repository: GroupStateRepository,
    snapshot: GroupSnapshot
): Promise<void> {
    await repository.putGroup(snapshot.group);
    await Promise.all(snapshot.members.map((member) => repository.putMember(member)));
    await Promise.all(
        snapshot.activeSessions.map((session) => repository.putPresenceSession(session))
    );
    const group = await repository.findGroupEntry(snapshot.group);
    if (!group) {
        throw new Error('Expected persisted group');
    }
    const current = await repository.findPresenceSummaryEntry(snapshot.group);
    const summary: GroupPresenceSummary = {
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId,
        causalRevision: {
            groupRevision: group.value.snapshotVersion,
            presenceRevision: snapshot.group.presenceVersion
        },
        activePrincipalIds: snapshot.activeSessions.map((session) => session.principalId),
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        activeSessions: snapshot.activeSessions,
        activePrincipalCount: snapshot.onlineMemberCount,
        activeSessionCount: snapshot.activeSessions.length,
        computedAtEpochMs: snapshot.group.updated.atEpochMs
    };
    if (current) {
        await repository.updatePresenceSummary(summary, current.entry.revision);
    }
    else {
        await repository.insertPresenceSummary(summary);
    }
}

interface CreateGroupSnapshotInput {
    readonly groupId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly sessionIds: readonly [string, ...string[]];
    readonly snapshotVersion: number;
    readonly expiresAtEpochMs?: number;
}

function createGroupSnapshot(input: CreateGroupSnapshotInput): GroupSnapshot {
    const {
        groupId,
        applicationId,
        workspaceId,
        sessionIds,
        snapshotVersion
    } = input;
    const created = createAuditStamp(1);
    const updated = createAuditStamp(snapshotVersion);
    return {
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            ownerPrincipalId: sessionIds[0],
            activeMemberCount: sessionIds.length,
            created,
            updated
        }),
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: created,
            updated,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: createGroupSessions(input),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function withGroupStatus(group: Group, status: 'archived' | 'deleted'): Group {
    if (status === 'archived') {
        return {
            ...group,
            status: 'archived',
            archived: group.updated,
            deleted: null
        };
    }
    return {
        ...group,
        status: 'deleted',
        archived: null,
        deleted: group.updated
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
function createGroupSessions(input: CreateGroupSnapshotInput): GroupSnapshot['activeSessions'] {
    const { groupId, applicationId, workspaceId, sessionIds, snapshotVersion, expiresAtEpochMs = 4_000_000_000_000 } = input;
    return sessionIds.map((sessionId) => ({
        applicationId,
        workspaceId,
        groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: snapshotVersion,
        expiresAtEpochMs
    }));
}
