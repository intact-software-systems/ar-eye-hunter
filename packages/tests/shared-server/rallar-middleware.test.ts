import { Temporal } from '@js-temporal/polyfill';
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
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    type ResourceInboxRetryPolicy,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
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
import type {
    AuditStamp,
    GroupMember,
    GroupSnapshot,
} from '@shared/api/group-types.ts';

describe('createRallarMiddleware', () => {
    it('constructs queuebox runtime services around supplied repositories', () => {
        const inbox = new InMemoryQueueBox();
        const outbox = new InMemoryQueueBox();
        const clientsRepository = {} as ClientStateRepository;
        const groupsRepository = {} as GroupStateRepository;
        const appInboxResilience = createResilience();
        const appOutboxResilience = createResilience();
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
                appOutbox: appOutboxResilience,
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
        expect(runtime.outboxQueueReader).toBeInstanceOf(OutboxQueueReader);
        expect(runtime.outboxQueueReader.outbox).toBe(outbox);
        expect(runtime.appInboxResilience).toBe(appInboxResilience);
        expect(runtime.appOutboxResilience).toBe(appOutboxResilience);
        expect(runtime.appGroupInboxService).toBe(appGroupInboxService);
        expect(runtime.appClientInboxService).toBe(appClientInboxService);
        expect(createAppGroupInboxService).toHaveBeenCalledWith({
            inboxQueueReader: runtime.inboxQueueReader,
            outboxQueueReader: runtime.outboxQueueReader,
            wsQBoxServerService: runtime.wsQBoxServerService,
            appInboxResilience,
            appOutboxResilience,
            wakeQueueEngine: expect.any(Function),
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
                appOutbox: createResilience(),
            },
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });
        const onMessage = vi.fn(async (_message: unknown) => undefined);
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

    it('uses one custom retry budget for app inbox advertisement and reservation', async () => {
        const inbox = new InMemoryQueueBox();
        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2,
        };
        const resilience = createResilience(retryPolicy);
        const runtime = createRallarMiddleware({
            inbox,
            resilience: {
                inbox: resilience,
                appInbox: resilience,
                appOutbox: createResilience(),
            },
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });
        const onMessage = vi.fn(async (_message: unknown) => undefined);
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage,
        });
        const enqueued = await runtime.inboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.group-state', 'group-1', 'request-exhausted'),
                'group-state.create.v1',
                { requestId: 'request-exhausted' },
            ),
        );
        await inbox.enqueue({
            ...enqueued,
            dequeueAudit: { ...enqueued.dequeueAudit, attempts: 2 },
        });
        const appInboxTask = readOnlyEngineTask(
            runtime.qboxEngine,
            InboxQueueReader.INBOX_ENQUEUE_TYPE,
        );

        expect(await appInboxTask?.isWork()).toBe(false);
        await appInboxTask?.runnable();

        expect(onMessage).not.toHaveBeenCalled();
        expect(await inbox.getItem(enqueued.key)).toMatchObject({
            status: enqueued.status,
            dequeueAudit: { attempts: 2 },
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
                appOutbox: createResilience(),
            },
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });
        const onMessage = vi.fn(async (_message: unknown) => undefined);
        const message = newALUntargetedMessage(
            'api-v1',
            newALRoute('app-outbox.rtc-topology', 'group-1', 'group-1'),
            'RTC_TOPOLOGY_RECOMPUTE',
            { groupId: 'group-1' },
        );

        runtime.outboxQueueReader.onOutboxMessageDo(
            'RTC_TOPOLOGY_RECOMPUTE',
            { onMessage },
        );
        await runtime.outboxQueueReader.enqueueIfAbsent(message);
        const appOutboxTask = readOnlyEngineTask(
            runtime.qboxEngine,
            OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        );

        expect(appOutboxTask).toBeDefined();
        expect(await appOutboxTask?.isWork()).toBe(true);
        await appOutboxTask?.runnable();

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage.mock.calls[0][0]).toEqual(message);
    });

    it('continues draining APP_INBOX while an APP_OUTBOX handler is blocked', async () => {
        const queue = new InMemoryQueueBox();
        const runtime = createRallarMiddleware({
            inbox: queue,
            outbox: queue,
            resilience: {
                inbox: createResilience(),
                appInbox: createResilience(),
                appOutbox: createResilience(),
            },
            createAppGroupInboxService: () => ({}) as AppGroupInboxService,
            createAppClientInboxService: () => ({}) as AppClientInboxService,
            clientsRepository: {} as ClientStateRepository,
            groupsRepository: {} as GroupStateRepository,
        });
        let releaseOutbox!: () => void;
        const outboxBlocked = new Promise<void>((resolve) => {
            releaseOutbox = resolve;
        });
        const onInbox = vi.fn(async () => undefined);
        const onOutbox = vi.fn(async () => await outboxBlocked);
        runtime.inboxQueueReader.onInboxMessageDo('group-state.create.v1', {
            onMessage: onInbox,
        });
        runtime.outboxQueueReader.onOutboxMessageDo(
            'RTC_TOPOLOGY_RECOMPUTE',
            { onMessage: onOutbox },
        );
        await runtime.outboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-outbox.rtc-topology', 'group-1', 'group-1'),
                'RTC_TOPOLOGY_RECOMPUTE',
                { groupId: 'group-1' },
            ),
        );
        const appOutboxTask = readOnlyEngineTask(
            runtime.qboxEngine,
            OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        )!;

        await runtime.qboxEngine.executeOnce();
        await vi.waitFor(() => expect(onOutbox).toHaveBeenCalledOnce());
        await runtime.inboxQueueReader.enqueueIfAbsent(
            newALUntargetedMessage(
                'api-v1',
                newALRoute('app-inbox.group-state', 'group-1', 'request-1'),
                'group-state.create.v1',
                { requestId: 'request-1' },
            ),
        );
        await runtime.qboxEngine.executeOnce();

        await vi.waitFor(() => expect(onInbox).toHaveBeenCalledOnce());
        releaseOutbox();
        await vi.waitFor(async () => {
            expect(await appOutboxTask.isWork()).toBe(false);
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

    it('does not route full group directory broadcasts to directory-only sessions', () => {
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
            ],
            2,
        );
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupDirectorySnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
            ),
            'all',
            AppTopics.groupDirectorySnapshot,
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
            2,
        );
        clientStateSnapshotsRepository.setClientStateSnapshots([
            {
                ...aliceSnapshot,
                activeSessions: [
                    aliceSnapshot.activeSessions[0]!,
                    {
                        ...aliceSnapshot.activeSessions[0]!,
                        clientInstanceId: 'alice-instance-b',
                        sessionId: 'session-b',
                    },
                ],
                activeSessionCount: 2,
            },
            createClientSnapshot('bob', 'session-c', 'app-1', 'workspace-a', 1),
        ]);

        const snapshot = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [
                { principalId: 'alice', sessionId: 'session-a', status: 'active' },
                { principalId: 'alice', sessionId: 'session-b', status: 'active' },
                { principalId: 'bob', sessionId: 'session-c', status: 'removed' },
            ],
            3,
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
        ).toEqual(['session-a', 'session-b']);
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
            expiredAt,
        );
        const group = createGroupSnapshot(
            'room-a',
            'app-1',
            'workspace-a',
            [{ principalId: 'alice', sessionId: 'session-a', status: 'active' }],
            1,
            expiredAt,
        );
        clientStateSnapshotsRepository.setClientStateSnapshots([client]);
        const stateSyncMessage = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                group.group.groupId,
                group.group.groupId,
            ),
            'all',
            AppTopics.groupStateSnapshot,
            group,
        );
        const roomMessage = newALBroadcastMessage(
            'session-a',
            newALEventRoute('room.chat', 'room-a', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'expired session' },
        );
        const resolver = createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotById: () => group,
            now: () => now,
        });

        expect(resolver.resolveBroadcastRecipients?.('all', stateSyncMessage))
            .toEqual([]);
        expect(resolver.resolveBroadcastRecipients?.('room', roomMessage))
            .toEqual([]);
    });
});

function createResilience(
    retryPolicy: ResourceInboxRetryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy,
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
    expiresAtEpochMs = 4_000_000_000_000,
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
            lastSeenAtEpochMs: snapshotVersion,
        },
        instances: [],
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
                expiresAtEpochMs,
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
        }>,
    ],
    snapshotVersion: number,
    expiresAtEpochMs = 4_000_000_000_000,
): GroupSnapshot {
    const activeMembers = members.filter((member) => member.status === 'active');
    const created = createAuditStamp(1, 'system');
    const updated = createAuditStamp(snapshotVersion, 'system');
    return {
        stateRevision: snapshotVersion,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        group: {
            applicationId,
            workspaceId,
            groupId,
            slug: null,
            displayName: groupId,
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: activeMembers.length,
            ownerPrincipalId: members[0].principalId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created,
            updated,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
        },
        members: members.map((member) => createGroupMember(
            applicationId,
            workspaceId,
            groupId,
            member,
            snapshotVersion,
        )),
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
            expiresAtEpochMs,
        })),
        memberCount: activeMembers.length,
        onlineMemberCount: activeMembers.length,
    };
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
): GroupMember {
    if (member.status === 'active') {
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
            status: 'active',
            left: null,
            removed: null,
            banned: null,
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
        banned: null,
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
