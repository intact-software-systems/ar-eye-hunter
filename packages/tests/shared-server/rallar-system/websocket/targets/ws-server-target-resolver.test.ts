import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import {
    AppTopics,
    ConnectionContext,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage
} from '@shared/mod.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { configureTestCacheRepositories } from '../../../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createOpenTestWebSocket } from '../test-support/open-test-websocket.ts';

describe('createWsServerTargetResolver state sync routing', () => {
    it('routes client state broadcasts only to open sessions in the same application and workspace', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot({
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'carol',
                sessionId: 'session-c',
                applicationId: 'app-2',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            })
        ]);

        const snapshot = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            snapshotVersion: 2
        });
        const message = {
            ...newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.clientStateSnapshot,
                    snapshot.principal.principalId,
                    snapshot.principal.principalId
                ),
                'all',
                AppTopics.clientStateSnapshot,
                snapshot
            ),
            targets: {
                mode: 'broadcast' as const,
                scope: 'principal' as const,
                principalRef: snapshot.principal
            }
        };
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('all', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-a']);
    });

    it('routes group state broadcasts only to open sessions for group members', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot({
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'carol',
                sessionId: 'session-c',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                snapshotVersion: 1
            })
        ]);

        const snapshot = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'bob', sessionId: 'session-b', status: 'removed' },
                { principalId: 'carol', sessionId: 'session-c', status: 'active' }
            ],
            snapshotVersion: 2
        });
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId
            ),
            'room',
            AppTopics.groupStateSnapshot,
            snapshot,
            { groupRef: snapshot.group }
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-a', 'session-c']);
    });

    it('does not route full group directory broadcasts to directory-only sessions', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot({
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'carol',
                sessionId: 'session-c',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                snapshotVersion: 1
            })
        ]);

        const snapshot = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' }
            ],
            snapshotVersion: 2
        });
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupDirectorySnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId
            ),
            'room',
            AppTopics.groupDirectorySnapshot,
            snapshot,
            { groupRef: snapshot.group }
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-a']);
    });

    it('routes group state broadcasts to each live session for the same principal', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');
        const aliceSnapshot = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            snapshotVersion: 2
        });
        const aliceInstance = requireFirst(aliceSnapshot.instances, 'Alice client instance');
        const aliceSession = requireFirst(aliceSnapshot.activeSessions, 'Alice client session');
        clientStateSnapshotsRepository.setClientStateSnapshots([
            {
                ...aliceSnapshot,
                instances: [
                    aliceInstance,
                    {
                        ...aliceInstance,
                        clientInstanceId: 'alice-instance-b'
                    }
                ],
                activeSessions: [
                    aliceSession,
                    {
                        ...aliceSession,
                        clientInstanceId: 'alice-instance-b',
                        sessionId: 'session-b'
                    }
                ],
                activeSessionCount: 2
            },
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-c',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            })
        ]);

        const baseSnapshot = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'bob', sessionId: 'session-c', status: 'removed' }
            ],
            snapshotVersion: 3
        });
        const baseGroupSession = requireFirst(
            baseSnapshot.activeSessions,
            'Base group session'
        );
        const snapshot: GroupSnapshot = {
            ...baseSnapshot,
            activeSessions: [
                ...baseSnapshot.activeSessions,
                {
                    ...baseGroupSession,
                    sessionId: 'session-b',
                    generationId: 'session-b-generation'
                }
            ]
        };
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId
            ),
            'room',
            AppTopics.groupStateSnapshot,
            snapshot,
            { groupRef: snapshot.group }
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-a', 'session-b']);
    });

    it('routes group events using the event scope when same group id exists in multiple workspaces', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot({
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                snapshotVersion: 1
            })
        ]);
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            members: [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            snapshotVersion: 1
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([workspaceA, workspaceB]);

        const envelope = createGroupEventEnvelope(workspaceB, ['session-b']);
        const event = envelope.event;
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
            'room',
            AppTopics.groupStateEvent,
            envelope,
            { groupRef: event }
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('routes room broadcasts with a scoped group snapshot resolver when same group id exists in multiple workspaces', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            members: [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            snapshotVersion: 1
        });
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' }
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            resolveGroupRef: (groupId) => ({
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId
            }),
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('routes room broadcasts using target groupRef before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            members: [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            snapshotVersion: 1
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
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('routes a fixed room audience without consulting a lagging group snapshot', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const laggingSnapshot = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 2
        });
        const message = {
            ...newALBroadcastMessage(
                'rallar-server',
                newALEventRoute('overlay.topology', 'shared-room', 'topology-3'),
                'room',
                'overlay.topology',
                { version: 3 },
                { groupRef: laggingSnapshot.group }
            ),
            targets: {
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: laggingSnapshot.group,
                minSnapshotVersion: 3,
                recipientPeerIds: ['session-b']
            }
        };
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: () => laggingSnapshot
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
        ).toEqual(['session-b']);
    });

    it('does not let a peer-sent room message bypass membership with a fixed audience', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const snapshot = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 3
        });
        const message = {
            ...newALBroadcastMessage(
                'session-a',
                newALEventRoute('room.chat', 'shared-room', 'message-1'),
                'room',
                'chat.message.v1',
                { text: 'hello' },
                { groupRef: snapshot.group }
            ),
            targets: {
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: snapshot.group,
                recipientPeerIds: ['session-b']
            }
        };
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: () => snapshot
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
        ).toEqual(['session-a']);
    });

    it('routes multicast targets using target groupRef before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            members: [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            snapshotVersion: 1
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
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveGroupRecipients?.('shared-room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('routes state sync group events with the scoped resolver before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot({
                principalId: 'alice',
                sessionId: 'session-a',
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
                snapshotVersion: 1
            }),
            createClientSnapshot({
                principalId: 'bob',
                sessionId: 'session-b',
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                snapshotVersion: 1
            })
        ]);

        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            members: [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            snapshotVersion: 1
        });
        const envelope = createGroupEventEnvelope(workspaceB, ['session-b']);
        const event = envelope.event;
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
            'room',
            AppTopics.groupStateEvent,
            envelope,
            { groupRef: event }
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('fails closed for malformed state sync broadcasts', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');

        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.clientStateSnapshot, 'client-1', 'client-1'),
            'all',
            AppTopics.clientStateSnapshot,
            'not-a-client-snapshot'
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(resolver.resolveBroadcastRecipients?.('all', message)).toEqual([]);
    });

    it('does not route expired cached sessions even when sockets are still open', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        const expiredAt = 1_000;
        const now = 1_001;
        const client = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            snapshotVersion: 1,
            expiresAtEpochMs: expiredAt
        });
        const group = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1,
            expiresAtEpochMs: expiredAt
        });
        clientStateSnapshotsRepository.setClientStateSnapshots([client]);
        const stateSyncMessage = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                group.group.groupId,
                group.group.groupId
            ),
            'all',
            AppTopics.groupStateSnapshot,
            group
        );
        const roomMessage = newALBroadcastMessage(
            'session-a',
            newALEventRoute('room.chat', 'room-a', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'expired session' }
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => group,
            now: () => now
        });

        expect(resolver.resolveBroadcastRecipients?.('all', stateSyncMessage))
            .toEqual([]);
        expect(resolver.resolveBroadcastRecipients?.('room', roomMessage))
            .toEqual([]);
    });
});

function addOpenConnection(
    server: JsonWebSocketServer,
    connectionId: string
): void {
    server.addConnection(
        new ConnectionContext(connectionId, createOpenTestWebSocket())
    );
}

interface CreateClientSnapshotInput {
    readonly principalId: string;
    readonly sessionId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly snapshotVersion: number;
    readonly expiresAtEpochMs?: number;
}

function createClientSnapshot(input: CreateClientSnapshotInput): ClientSnapshot {
    const {
        principalId,
        sessionId,
        applicationId,
        workspaceId,
        snapshotVersion,
        expiresAtEpochMs = 4_000_000_000_000
    } = input;
    const created = createAuditStamp(1, principalId);
    const updated = createAuditStamp(snapshotVersion, principalId);
    return {
        stateRevision: snapshotVersion,
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion,
            profileVersion: snapshotVersion,
            presenceVersion: 1,
            created,
            updated,
            lastSeenAtEpochMs: snapshotVersion
        },
        instances: [
            {
                applicationId,
                workspaceId,
                principalId,
                clientInstanceId: `${principalId}-instance`,
                status: 'active',
                platform: 'web',
                deviceLabel: null,
                appVersion: null,
                userAgent: null,
                capabilities: [],
                registered: created,
                updated,
                revoked: null
            }
        ],
        activeSessions: createClientSessions(input),
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion
    };
}

interface GroupSnapshotMember {
    readonly principalId: string;
    readonly sessionId: string;
    readonly status: 'active' | 'removed';
}

interface CreateGroupSnapshotInput {
    readonly groupId: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly members: readonly [GroupSnapshotMember, ...GroupSnapshotMember[]];
    readonly snapshotVersion: number;
    readonly expiresAtEpochMs?: number;
}

function createGroupSnapshot(input: CreateGroupSnapshotInput): GroupSnapshot {
    const {
        groupId,
        applicationId,
        workspaceId,
        members,
        snapshotVersion,
        expiresAtEpochMs = 4_000_000_000_000
    } = input;
    const activeMembers = members.filter((member) => member.status === 'active');
    const created = createAuditStamp(1, 'system');
    const updated = createAuditStamp(snapshotVersion, 'system');
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
            activeMemberCount: activeMembers.length,
            ownerPrincipalId: members[0].principalId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created,
            updated
        }),
        members: members.map((member) =>
            createGroupMember({
                applicationId,
                workspaceId,
                groupId,
                member,
                snapshotVersion,
                isOwner: member.principalId === members[0].principalId
            })
        ),
        activeSessions: activeMembers.map((member) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId: member.sessionId,
            principalId: member.principalId,
            generationId: `${member.sessionId}-generation`,
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs
        })),
        memberCount: activeMembers.length,
        onlineMemberCount: activeMembers.length
    };
}

function createGroupEventEnvelope(
    snapshot: GroupSnapshot,
    audienceSessionIds: readonly string[]
): GroupStateDeltaEnvelope {
    const actorSession = requireFirst(snapshot.activeSessions, 'Group event actor session');
    return {
        event: {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId,
            eventId: 'event-1',
            eventType: 'session-connected',
            snapshotVersion: snapshot.group.snapshotVersion,
            causalRevision: snapshot.causalRevision,
            occurredAtEpochMs: 2,
            actor: {
                kind: 'session',
                sessionId: actorSession.sessionId,
                principalId: actorSession.principalId
            },
            reason: null,
            traceId: null,
            requestId: null,
            payload: {}
        },
        predecessorCausalRevision: {
            groupRevision: Math.max(0, snapshot.causalRevision.groupRevision - 1),
            presenceRevision: Math.max(0, snapshot.causalRevision.presenceRevision - 1)
        },
        resultingCausalRevision: snapshot.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: snapshot.activeSessions,
        removedSessionIds: [],
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds
    };
}

function requireFirst<Value>(values: readonly Value[], label: string): Value {
    const first = values[0];
    if (first === undefined) {
        throw new TypeError(`${label} is required`);
    }
    return first;
}

interface CreateGroupMemberInput {
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly groupId: string;
    readonly member: GroupSnapshotMember;
    readonly snapshotVersion: number;
    readonly isOwner: boolean;
}

function createGroupMember(input: CreateGroupMemberInput): GroupMember {
    const { applicationId, workspaceId, groupId, member, snapshotVersion, isOwner } = input;
    if (member.status === 'active') {
        return {
            applicationId,
            workspaceId,
            groupId,
            principalId: member.principalId,
            role: isOwner ? 'owner' : 'member',
            joined: createAuditStamp(1, member.principalId),
            updated: createAuditStamp(snapshotVersion, member.principalId),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            status: 'active',
            left: null,
            removed: null,
            banned: null
        };
    }
    return {
        applicationId,
        workspaceId,
        groupId,
        principalId: member.principalId,
        role: 'member',
        joined: createAuditStamp(1, member.principalId),
        updated: createAuditStamp(snapshotVersion, member.principalId),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        status: 'removed',
        left: null,
        removed: createAuditStamp(snapshotVersion, 'system'),
        banned: null
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}
function createClientSessions(input: CreateClientSnapshotInput): ClientSnapshot['activeSessions'] {
    const { principalId, sessionId, applicationId, workspaceId, snapshotVersion, expiresAtEpochMs = 4_000_000_000_000 } = input;
    return [
        {
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            presenceState: 'online',
            transport: 'ws',
            connectionId: sessionId,
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs
        }
    ];
}
