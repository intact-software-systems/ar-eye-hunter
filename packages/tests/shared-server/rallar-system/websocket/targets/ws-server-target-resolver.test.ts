import {
    describe,
    expect,
    it
} from 'vitest';

import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { computeStateSnapshotPages, type StateSnapshotScope } from '@shared/api/state-snapshot-page.ts';
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

import { configureTestCacheRepositories } from '../../../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../../../create-test-group.ts';
import { createOpenTestWebSocket } from '../test-support/open-test-websocket.ts';

describe('createWsServerTargetResolver state sync routing', () => {
    it.each(['applicationId', 'workspaceId', 'groupId'] as const)('rejects a scoped lookup that returns another %s', (field) => {
        const snapshot = createGroupSnapshot({
            groupId: 'room',
            applicationId: 'app',
            workspaceId: 'workspace',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 1
        });
        const server = new JsonWebSocketServer();
        addOpenConnection(server, 'session-a');
        const message = newALMulticastMessage('session-a', newALEventRoute('room.chat', 'room', 'message'), snapshot.group, 'chat.message.v1', {});
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => ({ ...snapshot, group: { ...snapshot.group, [field]: 'another' } })
        });

        expect(resolver.resolveGroupRecipients?.('room', message)).toEqual([]);
    });

    it.each(['cold', 'older', 'newer', 'newer-retained-presence', 'wrong-scope'] as const)(
        'uses a frozen page audience with a %s current snapshot',
        (cacheState) => {
            const published = createGroupSnapshot({
                groupId: 'room',
                applicationId: 'app',
                workspaceId: 'workspace',
                members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
                snapshotVersion: 2
            });
            const current = createGroupSnapshot({
                groupId: 'room',
                applicationId: 'app',
                workspaceId: cacheState === 'wrong-scope' ? 'another' : 'workspace',
                members: [{ principalId: 'alice', sessionId: 'session-a', status: 'removed' }],
                snapshotVersion: cacheState === 'older' ? 1 : 3
            });
            const server = new JsonWebSocketServer();
            addOpenConnection(server, 'session-a');
            addOpenConnection(server, 'joined-after-publication');
            const resolver = createWsServerTargetResolver(server, {
                findGroupSnapshotByRef: () =>
                    cacheState === 'cold'
                        ? undefined
                        : cacheState === 'newer-retained-presence'
                        ? { ...current, activeSessions: published.activeSessions }
                        : current
            });
            const page = createSnapshotPage(published, AppTopics.groupStateSnapshot);

            expect(resolver.resolveBroadcastRecipients?.('room', page)).toEqual(
                cacheState === 'cold' || cacheState === 'older' ? [{ peerId: 'session-a', connectionId: 'session-a' }] : []
            );
        }
    );

    it.each(['cache', 'provider'] as const)('retains current member device fanout from the %s without group presence for ordinary pages', (source) => {
        configureTestCacheRepositories();
        const snapshot = createGroupSnapshot({
            groupId: 'room',
            applicationId: 'app',
            workspaceId: 'workspace',
            members: [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            snapshotVersion: 2
        });
        const current = { ...snapshot, activeSessions: [] };
        const client = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: 'app',
            workspaceId: 'workspace',
            snapshotVersion: 2
        });
        clientStateSnapshotsRepository.setClientStateSnapshots(source === 'cache' ? [client] : []);
        const server = new JsonWebSocketServer();
        addOpenConnection(server, 'session-a');
        const resolver = createWsServerTargetResolver(server, {
            findGroupSnapshotByRef: () => current,
            findClientSnapshotByRef: source === 'provider' ? () => client : undefined
        });

        expect(resolver.resolveBroadcastRecipients?.('room', createSnapshotPage(snapshot, AppTopics.groupStateSnapshot, 'current')))
            .toEqual([{ peerId: 'alice', connectionId: 'session-a' }]);
    });

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
        const message = createSnapshotPage(snapshot, AppTopics.clientStateSnapshot);
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
        const message = createSnapshotPage(snapshot, AppTopics.groupStateSnapshot);
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
        const message = createSnapshotPage(snapshot, AppTopics.groupDirectorySnapshot);
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
        const message = createSnapshotPage(snapshot, AppTopics.groupStateSnapshot);
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

    it('rejects an unscoped room broadcast without consulting a scoped snapshot resolver', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
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
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual([]);
    });

    it('routes room broadcasts using target groupRef', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
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
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('rejects a fixed topology audience whose route names another room', () => {
        const server = new JsonWebSocketServer();
        addOpenConnection(server, 'session-a');
        const message = newALBroadcastMessage(
            'rallar-server',
            newALEventRoute('overlay.topology', 'wrong-room', 'topology'),
            'room',
            'overlay.topology',
            { version: 1 },
            { groupRef: { applicationId: 'app-1', workspaceId: 'workspace-a', groupId: 'room-a' } }
        );
        const resolver = createWsServerTargetResolver(server);
        expect(
            resolver.resolveBroadcastRecipients?.('room', {
                ...message,
                targets: { ...message.targets, mode: 'broadcast', scope: 'room', recipientPeerIds: ['session-a'] }
            })
        ).toEqual([]);
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
                'api-node-17',
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

    it('routes multicast targets using target groupRef', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
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
            findGroupSnapshotByRef: (ref) => ref.workspaceId === 'workspace-b' ? workspaceB : undefined
        });

        expect(
            resolver
                .resolveGroupRecipients?.('shared-room', message)
                .map((recipient) => recipient.connectionId)
                .sort()
        ).toEqual(['session-b']);
    });

    it('routes state sync group events with the scoped resolver', () => {
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
        const stateSyncMessage = createSnapshotPage(group, AppTopics.groupStateSnapshot);
        const roomMessage = newALBroadcastMessage(
            'session-a',
            newALEventRoute('room.chat', 'room-a', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'expired session' },
            { groupRef: group.group }
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: () => group,
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
        new ConnectionContext({ id: connectionId, socket: createOpenTestWebSocket() })
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

function createSnapshotPage(snapshot: GroupSnapshot | ClientSnapshot, topicId: string, audience: 'fixed' | 'current' = 'fixed'): ALMessage {
    const group = 'group' in snapshot ? snapshot.group : undefined;
    const principal = 'principal' in snapshot ? snapshot.principal : undefined;
    const ref = group ?? principal!;
    const scope: StateSnapshotScope = {
        kind: group ? 'group' : 'principal',
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        resourceId: group ? group.groupId : principal!.principalId
    };
    const original = newALBroadcastMessage('api-node-17', newALEventRoute(topicId, scope.resourceId, 'snapshot'), 'all', topicId, {});
    const envelope = {
        ...original,
        delivery: original.delivery,
        audit: original.audit,
        ordering: original.ordering,
        constraints: { expiresAtMs: original.id.ts + 60_000 },
        targets: group
            ? {
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: { applicationId: scope.applicationId, workspaceId: scope.workspaceId, groupId: scope.resourceId },
                ...(audience === 'fixed' ? { recipientPeerIds: snapshot.activeSessions.map((session) => session.sessionId) } : {})
            }
            : {
                mode: 'broadcast' as const,
                scope: 'principal' as const,
                principalRef: { applicationId: scope.applicationId, workspaceId: scope.workspaceId, principalId: scope.resourceId }
            }
    };
    const revision = 'causalRevision' in snapshot
        ? `group=${snapshot.causalRevision.groupRevision};presence=${snapshot.causalRevision.presenceRevision}`
        : `client=${snapshot.stateRevision}`;
    const result = computeStateSnapshotPages({ envelope, scope, revision, resource: JSON.stringify(snapshot) });
    if (!result.right?.[0]) {
        throw new Error(result.left?.message ?? 'Expected snapshot page');
    }
    return result.right[0];
}
