import { describe, expect, it, vi } from 'vitest';
import {
    AppTopics,
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
    newALRoute,
    newALUntargetedMessage,
} from '@shared/mod.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import {
    createRallarMiddleware,
    createWsServerTargetResolver,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type { AppClientInboxService } from '@shared-server/rallar-system/services/AppClientInboxService.ts';
import type { AppGroupInboxService } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import type { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { GroupSnapshot } from '@shared/api/group-types.ts';

describe('createRallarMiddleware', () => {
    it('constructs queuebox runtime services around supplied repositories', () => {
        const inbox = new InMemoryQueueBox();
        const outbox = new InMemoryQueueBox();
        const clientsRepository = {} as ClientStateRepository;
        const groupsRepository = {} as GroupStateRepository;
        const appInboxResilience = createResilience();
        const appGroupInboxService = {} as AppGroupInboxService;
        const appClientInboxService = {} as AppClientInboxService;
        const createAppGroupInboxService = vi.fn(() => appGroupInboxService);
        const createAppClientInboxService = vi.fn(() => appClientInboxService);
        const runtime = createRallarMiddleware({
            inbox,
            outbox,
            wsRuntimeName: 'server-1',
            createAppGroupInboxService,
            createAppClientInboxService,
            resilience: {
                inbox: createResilience(),
                outbox: createResilience(),
                appInbox: appInboxResilience,
            },
            clientsRepository,
            groupsRepository,
        });

        expect(runtime.wsQBoxServerService).toBeInstanceOf(WsQueueBoxServerService);
        expect(runtime.wsQBoxServerService.inbox).toBe(inbox);
        expect(runtime.wsQBoxServerService.outbox).toBe(outbox);
        expect(runtime.wsQBoxServerService.name).toBe('server-1');
        expect(runtime.inboxQueueReader).toBeInstanceOf(InboxQueueReader);
        expect(runtime.inboxQueueReader.inbox).toBe(inbox);
        expect(runtime.appInboxResilience).toBe(appInboxResilience);
        expect(runtime.appGroupInboxService).toBe(appGroupInboxService);
        expect(runtime.appClientInboxService).toBe(appClientInboxService);
        expect(createAppGroupInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            wsQBoxServerService: runtime.wsQBoxServerService,
            appInboxResilience,
        });
        expect(createAppClientInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            wsQBoxServerService: runtime.wsQBoxServerService,
            appInboxResilience,
        });
        expect(runtime.clientsRepository).toBe(clientsRepository);
        expect(runtime.groupsRepository).toBe(groupsRepository);
        expect(runtime.qboxEngine).toBeDefined();
    });

    it('registers an app inbox engine task that drains inbox messages', async () => {
        const inbox = new InMemoryQueueBox();
        const runtime = createRallarMiddleware({
            inbox,
            resilience: {
                inbox: createResilience(),
            },
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });
        const onMessage = vi.fn(async () => undefined);
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
            'group-state.create.v1',
            { requestId: 'request-1' },
        );

        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage,
        });
        await runtime.inboxQueueReader.enqueueIfAbsent(message);
        const appInboxTask = readOnlyEngineTask(
            runtime.qboxEngine,
            InboxQueueReader.INBOX_ENQUEUE_TYPE,
        );

        expect(appInboxTask).toBeDefined();
        expect(await appInboxTask?.isWork()).toBe(true);
        await appInboxTask?.runnable();

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage.mock.calls[0][0]).toEqual(message);
    });
});

describe('createWsServerTargetResolver state sync routing', () => {
    it('routes client state broadcasts only to open sessions in the same application and workspace', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-b', 1),
            createClientSnapshot('carol', 'session-c', 'app-2', 'workspace-a', 1),
        ]);

        const snapshot = createClientSnapshot(
            'alice',
            'session-a',
            'app-1',
            'workspace-a',
            2,
        );
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.clientStateSnapshot,
                snapshot.principal.principalId,
                snapshot.principal.principalId,
            ),
            'all',
            AppTopics.clientStateSnapshot,
            snapshot,
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('all', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-a']);
    });

    it('routes group state broadcasts only to open sessions for group members', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        addOpenConnection(webSocketServer, 'session-c');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-a', 1),
            createClientSnapshot('carol', 'session-c', 'app-1', 'workspace-b', 1),
        ]);

        const snapshot = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'bob', sessionId: 'session-b', status: 'removed' },
                { principalId: 'carol', sessionId: 'session-c', status: 'active' },
            ],
            2,
        );
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
            ),
            'all',
            AppTopics.groupStateSnapshot,
            snapshot,
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('all', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-a']);
    });

    it('routes group events using the event scope when same group id exists in multiple workspaces', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-b', 1),
        ]);
        groupStateSnapshotsRepository.setGroupStateSnapshots([
            createGroupSnapshot(
                'shared-room',
                'app-1',
                'workspace-a',
                [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
                1,
            ),
            createGroupSnapshot(
                'shared-room',
                'app-1',
                'workspace-b',
                [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
                1,
            ),
        ]);

        const event = {
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            groupId: 'shared-room',
            eventId: 'event-1',
            eventType: 'member-joined',
            snapshotVersion: 1,
            occurredAtEpochMs: 2,
            actor: {
                principalId: 'bob',
            },
        };
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
            'all',
            AppTopics.groupStateEvent,
            event,
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(
            resolver
                .resolveBroadcastRecipients?.('all', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-b']);
    });

    it('routes room broadcasts with a scoped group snapshot resolver when same group id exists in multiple workspaces', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1,
        );
        const message = newALBroadcastMessage(
            'session-b',
            newALEventRoute('room.chat', 'shared-room', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'workspace-b' },
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            resolveGroupRef: (groupId) => ({
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId,
            }),
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-b']);
    });

    it('routes room broadcasts using target groupRef before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1,
        );
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
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('room', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-b']);
    });

    it('routes multicast targets using target groupRef before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1,
        );
        const message = {
            ...newALMulticastMessage(
                'session-b',
                newALEventRoute('room.chat', 'shared-room', 'msg-1'),
                workspaceB.group,
                'chat.message.v1',
                { text: 'workspace-b' },
            ),
        };
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });

        expect(
            resolver
                .resolveGroupRecipients?.('shared-room', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
        ).toEqual(['session-b']);
    });

    it('routes state sync group events with the scoped resolver before the group id fallback', () => {
        configureTestCacheRepositories();

        const webSocketServer = new JsonWebSocketServer();
        addOpenConnection(webSocketServer, 'session-a');
        addOpenConnection(webSocketServer, 'session-b');

        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-b', 1),
        ]);

        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1,
        );
        const event = {
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            groupId: 'shared-room',
            eventId: 'event-1',
            eventType: 'member-joined',
            snapshotVersion: 1,
            occurredAtEpochMs: 2,
            actor: {
                principalId: 'bob',
            },
        };
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, event.groupId, event.eventId),
            'all',
            AppTopics.groupStateEvent,
            event,
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => workspaceA,
            findGroupSnapshotByRef: (ref) =>
                ref.workspaceId === 'workspace-b' ? workspaceB : undefined,
        });

        expect(
            resolver
                .resolveBroadcastRecipients?.('all', message)
                .map((recipient) => recipient.connectionId)
                .sort(),
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
            'not-a-client-snapshot',
        );
        const resolver = createWsServerTargetResolver(webSocketServer);

        expect(resolver.resolveBroadcastRecipients?.('all', message)).toEqual([]);
    });
});

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}

function readOnlyEngineTask(
    engine: unknown,
    id: string,
):
    | {
    isWork: () => Promise<boolean> | boolean;
    runnable: () => Promise<void> | void;
}
    | undefined {
    const tasks = (
        engine as {
            tasks: Map<
                string,
                {
                    isWork: () => Promise<boolean> | boolean;
                    runnable: () => Promise<void> | void;
                }
            >;
        }
    ).tasks;

    return tasks.get(id);
}

function addOpenConnection(
    server: JsonWebSocketServer,
    connectionId: string,
): void {
    server.addConnection(
        new ConnectionContext(connectionId, {
            readyState: WebSocket.OPEN,
            addEventListener: () => undefined,
            send: () => undefined,
        } as never),
    );
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
): ClientSnapshot {
    return {
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion,
            profileVersion: snapshotVersion,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        instances: [],
        activeSessions: [
            {
                applicationId,
                workspaceId,
                principalId,
                clientInstanceId: `${principalId}-instance`,
                sessionId,
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: 1,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: snapshotVersion,
                expiresAtEpochMs: 60_000,
            },
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion,
    };
}

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    members: Readonly<
        {
            principalId: string;
            sessionId: string;
            status: 'active' | 'removed';
        }
    >,
    snapshotVersion: number,
): GroupSnapshot {
    const activeMembers = members.filter((member) => member.status === 'active');
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
        members: members.map((member) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: member.principalId,
            role: 'member',
            status: member.status,
            joined: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        })),
        activeSessions: activeMembers.map((member) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId: member.sessionId,
            principalId: member.principalId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: activeMembers.length,
        onlineMemberCount: activeMembers.length,
    };
}
