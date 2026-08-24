import { Temporal } from '@js-temporal/polyfill';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/create-rallar-middleware.ts';
import type { QueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { RtcRttInboxService } from '@shared-server/rallar-system/rtc-rtt/inbox/rtc-rtt-inbox-service.ts';
import { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { AuditStamp, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
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
    type ALMessage
} from '@shared/mod.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, type ResourceInboxRetryPolicy } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '../create-test-group.ts';

describe('createRallarMiddleware', () => {
    it('constructs queuebox runtime services around supplied repositories', () => {
        const inbox = new InMemoryQueueBox();
        const outbox = new InMemoryQueueBox();
        const clientsRepository = createUnusedClientStateRepository();
        const groupsRepository = createUnusedGroupStateRepository();
        const appInboxResilience = createResilience();
        const appOutboxResilience = createResilience();
        const groupStateInboxService = createUnusedGroupStateInboxService();
        const topologyInboxService = createUnusedTopologyInboxService();
        const rtcRttInboxService = createUnusedRtcRttInboxService();
        const appClientInboxService = createUnusedAppClientInboxService();
        const createGroupStateInboxService = vi.fn(() => groupStateInboxService);
        const createTopologyInboxService = vi.fn(() => topologyInboxService);
        const createRtcRttInboxService = vi.fn(() => rtcRttInboxService);
        const createAppClientInboxService = vi.fn(() => appClientInboxService);
        const runtime = createRallarMiddleware({
            inbox,
            outbox,
            wsRuntimeName: 'server-1',
            createGroupStateInboxService,
            createTopologyInboxService,
            createRtcRttInboxService,
            createAppClientInboxService,
            resilience: {
                inbox: createResilience(),
                outbox: createResilience(),
                appInbox: appInboxResilience,
                appOutbox: appOutboxResilience
            },
            clientsRepository,
            groupsRepository
        });

        expect(runtime.wsQBoxServerService).toBeInstanceOf(WsQueueBoxServerService);
        expect(runtime.wsQBoxServerService.inbox).toBe(inbox);
        expect(runtime.wsQBoxServerService.outbox).toBe(outbox);
        expect(runtime.wsQBoxServerService.name).toBe('server-1');
        expect(runtime.inboxQueueReader).toBeInstanceOf(InboxQueueReader);
        expect(runtime.inboxQueueReader.inbox).toBe(inbox);
        expect(runtime.outboxQueueReader).toBeInstanceOf(OutboxQueueReader);
        expect(runtime.outboxQueueReader.outbox).toBe(outbox);
        expect(runtime.appInboxResilience).toBe(appInboxResilience);
        expect(runtime.appOutboxResilience).toBe(appOutboxResilience);
        expect(runtime.groupStateInboxService).toBe(groupStateInboxService);
        expect(runtime.topologyInboxService).toBe(topologyInboxService);
        expect(runtime.rtcRttInboxService).toBe(rtcRttInboxService);
        expect(runtime.appClientInboxService).toBe(appClientInboxService);
        expect(createGroupStateInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            outboxQueueReader: runtime.outboxQueueReader,
            wsQBoxServerService: runtime.wsQBoxServerService,
            appInboxResilience,
            appOutboxResilience,
            wakeQueueEngine: expect.any(Function)
        });
        expect(createTopologyInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine: expect.any(Function)
        });
        expect(createRtcRttInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine: expect.any(Function)
        });
        expect(createAppClientInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            wsQBoxServerService: runtime.wsQBoxServerService,
            appInboxResilience,
            wakeQueueEngine: expect.any(Function)
        });
        expect(runtime.clientsRepository).toBe(clientsRepository);
        expect(runtime.groupsRepository).toBe(groupsRepository);
        expect(runtime.qboxEngine).toBeDefined();
    });

    it('waits for runtime and queue pubsub subscription readiness', async () => {
        const runtimeStartup = createDeferred();
        const queueSubscription = createDeferred();
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: vi.fn(async () => await queueSubscription.promise)
        };
        const runtime = createRallarMiddleware(
            createReadinessMiddlewareOptions(runtimeStartup.promise, bridge)
        );
        let ready = false;
        void runtime.readiness.then(() => {
            ready = true;
        });

        runtimeStartup.resolve();
        await Promise.resolve();

        expect(bridge.subscribe).toHaveBeenCalledWith(
            'queuebox-events',
            expect.any(Function)
        );
        expect(ready).toBe(false);

        queueSubscription.resolve();
        await runtime.readiness;

        expect(ready).toBe(true);
    });

    it('fails runtime readiness when queue pubsub subscription fails', async () => {
        const failure = new Error('queue subscription failed');
        const bridge: QueueBoxPubSubBridge = {
            publish: async () => undefined,
            subscribe: async () => {
                throw failure;
            }
        };
        const reportFailure = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const runtime = createRallarMiddleware(
            createReadinessMiddlewareOptions(Promise.resolve(), bridge)
        );

        await expect(runtime.readiness).rejects.toBe(failure);
        reportFailure.mockRestore();
    });

    it('exposes the process health failure channel without changing readiness', async () => {
        const healthFailure = new Promise<never>(() => undefined);
        const runtime = createRallarMiddleware({
            ...createReadinessMiddlewareOptions(
                Promise.resolve(),
                {
                    publish: async () => undefined,
                    subscribe: async () => undefined
                }
            ),
            healthFailure
        });

        await expect(runtime.readiness).resolves.toBeUndefined();
        expect(runtime.healthFailure).toBe(healthFailure);
    });

    it('rejects a configured inbox factory that does not construct its service', () => {
        const options = createReadinessMiddlewareOptions(
            Promise.resolve(),
            {
                publish: async () => undefined,
                subscribe: async () => undefined
            }
        );
        Object.defineProperty(options, 'createAppAuthInboxService', {
            enumerable: true,
            value: () => undefined
        });

        expect(() => createRallarMiddleware(options)).toThrow(
            'Rallar middleware inbox service construction is incomplete'
        );
    });

    it('registers an app inbox engine task that drains inbox messages', async () => {
        const inbox = new InMemoryQueueBox();
        const runtime = createRallarMiddleware({
            inbox,
            resilience: {
                inbox: createResilience(),
                appOutbox: createResilience()
            },
            createGroupStateInboxService: createUnusedGroupStateInboxService,
            createTopologyInboxService: createUnusedTopologyInboxService,
            createRtcRttInboxService: createUnusedRtcRttInboxService,
            createAppClientInboxService: createUnusedAppClientInboxService,
            clientsRepository: createUnusedClientStateRepository(),
            groupsRepository: createUnusedGroupStateRepository()
        });
        const receivedMessages: ALMessage[] = [];
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
            'group-state.create.v1',
            { requestId: 'request-1' }
        );

        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedMessages.push(receivedMessage);
            }
        });
        await runtime.inboxQueueReader.enqueueIfAbsent(message);
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(receivedMessages).toEqual([message]));
    });

    it('uses one custom retry budget for app inbox advertisement and reservation', async () => {
        const inbox = new InMemoryQueueBox();
        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2
        };
        const resilience = createResilience(retryPolicy);
        const runtime = createRallarMiddleware({
            inbox,
            resilience: {
                inbox: resilience,
                appInbox: resilience,
                appOutbox: createResilience()
            },
            createGroupStateInboxService: createUnusedGroupStateInboxService,
            createTopologyInboxService: createUnusedTopologyInboxService,
            createRtcRttInboxService: createUnusedRtcRttInboxService,
            createAppClientInboxService: createUnusedAppClientInboxService,
            clientsRepository: createUnusedClientStateRepository(),
            groupsRepository: createUnusedGroupStateRepository()
        });
        const receivedMessages: ALMessage[] = [];
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedMessages.push(receivedMessage);
            }
        });
        const enqueued = await runtime.inboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.group-state', 'group-1', 'request-exhausted'),
                'group-state.create.v1',
                { requestId: 'request-exhausted' }
            )
        );
        await inbox.enqueue({
            ...enqueued,
            dequeueAudit: { ...enqueued.dequeueAudit, attempts: 2 }
        });
        await runtime.qboxEngine.executeOnce();

        expect(receivedMessages).toEqual([]);
        expect(await inbox.getItem(enqueued.key)).toMatchObject({
            status: enqueued.status,
            dequeueAudit: { attempts: 2 }
        });
    });

    it('registers an independent app outbox engine task', async () => {
        const inbox = new InMemoryQueueBox();
        const outbox = new InMemoryQueueBox();
        const runtime = createRallarMiddleware({
            inbox,
            outbox,
            resilience: {
                inbox: createResilience(),
                appInbox: createResilience(),
                appOutbox: createResilience()
            },
            createGroupStateInboxService: createUnusedGroupStateInboxService,
            createTopologyInboxService: createUnusedTopologyInboxService,
            createRtcRttInboxService: createUnusedRtcRttInboxService,
            createAppClientInboxService: createUnusedAppClientInboxService,
            clientsRepository: createUnusedClientStateRepository(),
            groupsRepository: createUnusedGroupStateRepository()
        });
        const receivedMessages: ALMessage[] = [];
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-outbox.rtc-topology', 'group-1', 'group-1'),
            'RTC_TOPOLOGY_RECOMPUTE',
            { groupId: 'group-1' }
        );

        runtime.outboxQueueReader.onOutboxMessageDo(
            'RTC_TOPOLOGY_RECOMPUTE',
            {
                onMessage: async (receivedMessage) => {
                    receivedMessages.push(receivedMessage);
                }
            }
        );
        await runtime.outboxQueueReader.enqueueIfAbsent(message);
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(receivedMessages).toEqual([message]));
    });

    it('continues draining APP_INBOX while an APP_OUTBOX handler is blocked', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRallarMiddleware({
            inbox: queue,
            outbox: queue,
            resilience: {
                inbox: createResilience(),
                appInbox: createResilience(),
                appOutbox: createResilience()
            },
            createGroupStateInboxService: createUnusedGroupStateInboxService,
            createTopologyInboxService: createUnusedTopologyInboxService,
            createRtcRttInboxService: createUnusedRtcRttInboxService,
            createAppClientInboxService: createUnusedAppClientInboxService,
            clientsRepository: createUnusedClientStateRepository(),
            groupsRepository: createUnusedGroupStateRepository()
        });
        const outboxBlocked = createDeferred();
        const receivedInboxMessages: ALMessage[] = [];
        const receivedOutboxMessages: ALMessage[] = [];
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: async (receivedMessage) => {
                receivedInboxMessages.push(receivedMessage);
            }
        });
        runtime.outboxQueueReader.onOutboxMessageDo(
            'RTC_TOPOLOGY_RECOMPUTE',
            {
                onMessage: async (receivedMessage) => {
                    receivedOutboxMessages.push(receivedMessage);
                    await outboxBlocked.promise;
                }
            }
        );
        const outboxEntry = await runtime.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-outbox.rtc-topology', 'group-1', 'group-1'),
                'RTC_TOPOLOGY_RECOMPUTE',
                { groupId: 'group-1' }
            )
        );
        await runtime.qboxEngine.executeOnce();
        await vi.waitFor(() => expect(receivedOutboxMessages).toHaveLength(1));
        await runtime.inboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
                'group-state.create.v1',
                { requestId: 'request-1' }
            )
        );
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(receivedInboxMessages).toHaveLength(1));
        outboxBlocked.resolve();
        await vi.waitFor(async () => {
            expect((await queue.getItem(outboxEntry.key))?.status).toBe(EntityStatus.COMPLETED);
        });
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
            createClientSnapshot('carol', 'session-c', 'app-2', 'workspace-a', 1)
        ]);

        const snapshot = createClientSnapshot(
            'alice',
            'session-a',
            'app-1',
            'workspace-a',
            2
        );
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
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-a', 1),
            createClientSnapshot('carol', 'session-c', 'app-1', 'workspace-b', 1)
        ]);

        const snapshot = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'bob', sessionId: 'session-b', status: 'removed' },
                { principalId: 'carol', sessionId: 'session-c', status: 'active' }
            ],
            2
        );
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
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-a', 1),
            createClientSnapshot('carol', 'session-c', 'app-1', 'workspace-b', 1)
        ]);

        const snapshot = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' }
            ],
            2
        );
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
        const aliceSnapshot = createClientSnapshot(
            'alice',
            'session-a',
            'app-1',
            'workspace-a',
            2
        );
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
            createClientSnapshot('bob', 'session-c', 'app-1', 'workspace-a', 1)
        ]);

        const baseSnapshot = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'bob', sessionId: 'session-c', status: 'removed' }
            ],
            3
        );
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
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-b', 1)
        ]);
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1
        );
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
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1
        );
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
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1
        );
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
        const laggingSnapshot = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            2
        );
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
        const snapshot = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            3
        );
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
        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1
        );
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
            createClientSnapshot('alice', 'session-a', 'app-1', 'workspace-a', 1),
            createClientSnapshot('bob', 'session-b', 'app-1', 'workspace-b', 1)
        ]);

        const workspaceA = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            [{ principalId: 'bob', sessionId: 'session-b', status: 'active' }],
            1
        );
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
        const client = createClientSnapshot(
            'alice',
            'session-a',
            'app-1',
            'workspace-a',
            1,
            expiredAt
        );
        const group = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
            expiredAt
        );
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

function createResilience(
    retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy
    );
}

function createReadinessMiddlewareOptions(
    readiness: Promise<void>,
    bridge: QueueBoxPubSubBridge
) {
    return {
        inbox: new InMemoryQueueBox(),
        resilience: {
            inbox: createResilience(),
            appOutbox: createResilience()
        },
        createGroupStateInboxService: createUnusedGroupStateInboxService,
        createTopologyInboxService: createUnusedTopologyInboxService,
        createRtcRttInboxService: createUnusedRtcRttInboxService,
        createAppClientInboxService: createUnusedAppClientInboxService,
        clientsRepository: createUnusedClientStateRepository(),
        groupsRepository: createUnusedGroupStateRepository(),
        readiness,
        queuePubSubBridge: {
            bridge,
            channel: 'queuebox-events',
            publisherId: 'publisher-1'
        }
    };
}

function createUnusedClientStateRepository(): ClientStateRepository {
    const repository: ClientStateRepository = Object.create(ClientStateRepository.prototype);
    return repository;
}

function createUnusedGroupStateRepository(): GroupStateRepository {
    const repository: GroupStateRepository = Object.create(GroupStateRepository.prototype);
    return repository;
}

function createUnusedGroupStateInboxService(): GroupStateInboxService {
    const service: GroupStateInboxService = Object.create(GroupStateInboxService.prototype);
    return service;
}

function createUnusedTopologyInboxService(): TopologyInboxService {
    const service: TopologyInboxService = Object.create(TopologyInboxService.prototype);
    return service;
}

function createUnusedRtcRttInboxService(): RtcRttInboxService {
    const service: RtcRttInboxService = Object.create(RtcRttInboxService.prototype);
    return service;
}

function createUnusedAppClientInboxService(): AppClientInboxService {
    const service: AppClientInboxService = Object.create(AppClientInboxService.prototype);
    return service;
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve(): void;
}> {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });

    return {
        promise,
        resolve: () => resolvePromise()
    };
}

function addOpenConnection(
    server: JsonWebSocketServer,
    connectionId: string
): void {
    server.addConnection(
        new ConnectionContext(connectionId, createOpenWebSocket())
    );
}

function createOpenWebSocket(): WebSocket {
    const socket: WebSocket = Object.create(WebSocket.prototype);
    Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN });
    return socket;
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
    expiresAtEpochMs = 4_000_000_000_000
): ClientSnapshot {
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
        activeSessions: [
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
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion
    };
}

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    members: readonly [
        {
            principalId: string;
            sessionId: string;
            status: 'active' | 'removed';
        },
        ...Array<{
            principalId: string;
            sessionId: string;
            status: 'active' | 'removed';
        }>
    ],
    snapshotVersion: number,
    expiresAtEpochMs = 4_000_000_000_000
): GroupSnapshot {
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
            createGroupMember(
                applicationId,
                workspaceId,
                groupId,
                member,
                snapshotVersion,
                member.principalId === members[0].principalId
            )
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

function createGroupMember(
    applicationId: string,
    workspaceId: string,
    groupId: string,
    member: Readonly<{
        principalId: string;
        sessionId: string;
        status: 'active' | 'removed';
    }>,
    snapshotVersion: number,
    isOwner: boolean
): GroupMember {
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
