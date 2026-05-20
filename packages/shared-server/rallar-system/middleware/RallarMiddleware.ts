import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import { type ALMessage, readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    WsQueueBoxServerService,
    type WsServerResolvedRecipient,
    type WsServerTargetResolver,
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { initialiseServerCacheRepositories } from '../cache-repositories.ts';
import type { ClientStateRepository } from '../repositories/ClientStateRepository.ts';
import type { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import { resolveStateSyncRecipients } from '../state-sync-routing.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';

export type RallarMiddlewareRuntime = Readonly<{
    qboxEngine: InboxOutboxEngine;
    wsQBoxServerService: WsQueueBoxServerService;
    inboxQueueReader: InboxQueueReader;
    appInboxResilience: ResilienceDto;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
}>;

export type RallarGroupSnapshotResolverOptions = Readonly<{
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        message: ALMessage,
    ) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    resolveGroupRef?: (
        groupId: string,
        message: ALMessage,
    ) => GroupRef | undefined;
}>;

export type CreateRallarMiddlewareOptions = Readonly<{
    inbox: QueueBoxResourceEntryRepository;
    outbox?: QueueBoxResourceEntryRepository;
    webSocketServer?: JsonWebSocketServer;
    wsRuntimeName?: string;
    targetResolver?: WsServerTargetResolver;
    findGroupSnapshotByRef?: RallarGroupSnapshotResolverOptions['findGroupSnapshotByRef'];
    findGroupSnapshotById?: RallarGroupSnapshotResolverOptions['findGroupSnapshotById'];
    resolveGroupRef?: RallarGroupSnapshotResolverOptions['resolveGroupRef'];
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    resilience: Readonly<{
        inbox: ResilienceDto;
        outbox?: ResilienceDto;
        appInbox?: ResilienceDto;
    }>;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
}>;

export function createRallarMiddleware(
    options: CreateRallarMiddlewareOptions,
): RallarMiddlewareRuntime {
    initialiseServerCacheRepositories();

    const qboxEngine = new InboxOutboxEngine();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver = options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findGroupSnapshotById: options.findGroupSnapshotById,
            resolveGroupRef: options.resolveGroupRef,
        });

    const wsQBoxServerService = new WsQueueBoxServerService(
        options.inbox,
        options.outbox ?? options.inbox,
        webSocketServer,
        options.wsRuntimeName ?? 'default-qbox-server',
        {
            targetResolver,
            inboundStores: options.inboundStores,
            outboundStores: options.outboundStores,
        },
    );
    const inboxQueueReader = new InboxQueueReader(options.inbox);
    const appInboxResilience = options.resilience.appInbox ?? options.resilience.inbox;

    includeWsQueueBoxEngineTasks(
        qboxEngine,
        wsQBoxServerService,
        options.resilience.inbox,
        options.resilience.outbox ?? options.resilience.inbox,
    );
    includeInboxQueueReaderEngineTasks(
        qboxEngine,
        inboxQueueReader,
        appInboxResilience,
    );

    return {
        qboxEngine,
        wsQBoxServerService,
        inboxQueueReader,
        appInboxResilience,
        clientsRepository: options.clientsRepository,
        groupsRepository: options.groupsRepository,
    };
}

export function includeWsQueueBoxEngineTasks(
    engine: InboxOutboxEngine,
    wsQBoxServerService: WsQueueBoxServerService,
    resilienceInbox: ResilienceDto,
    resilienceOutbox: ResilienceDto,
): void {
    engine.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.inbox.isAnyEntryToLock(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox.checkReserveTimeouts.isEntryRateLimiter,
                resilienceInbox.checkFailed.isEntryRateLimiter,
            ),
        runnable: () =>
            wsQBoxServerService.dequeueInbox(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                resilienceInbox,
            ),
        ongoingTasks: [],
    });

    engine.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            wsQBoxServerService.outbox.isAnyEntryToLock(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox.checkReserveTimeouts.isEntryRateLimiter,
                resilienceOutbox.checkFailed.isEntryRateLimiter,
            ),
        runnable: () =>
            wsQBoxServerService.dequeueOutbox(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilienceOutbox,
            ),
        ongoingTasks: [],
    });
}

export function includeInboxQueueReaderEngineTasks(
    engine: InboxOutboxEngine,
    inboxQueueReader: InboxQueueReader,
    resilience: ResilienceDto,
): void {
    engine.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
        name: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            inboxQueueReader.inbox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience.checkReserveTimeouts.isEntryRateLimiter,
                resilience.checkFailed.isEntryRateLimiter,
            ),
        runnable: () =>
            inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                resilience,
            ),
        ongoingTasks: [],
    });
}

export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: RallarGroupSnapshotResolverOptions = {},
): WsServerTargetResolver {
    const resolveGroupSnapshot = (
        groupId: string,
        message: ALMessage,
    ): GroupSnapshot | undefined => {
        const groupRef = readALTargetGroupRef(message) ??
            options.resolveGroupRef?.(groupId, message);
        const scopedSnapshot = groupRef
            ? options.findGroupSnapshotByRef?.(groupRef, message)
            : undefined;
        if (scopedSnapshot) {
            return scopedSnapshot;
        }

        const byIdSnapshot = options.findGroupSnapshotById?.(groupId);
        if (!byIdSnapshot) {
            return undefined;
        }

        return groupRef === undefined || isSameGroupScope(byIdSnapshot.group, groupRef)
            ? byIdSnapshot
            : undefined;
    };

    const resolveGroupRecipients = (
        groupId: string,
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] => {
        const snapshot = resolveGroupSnapshot(groupId, message);
        if (!snapshot) {
            return [];
        }

        return snapshot.activeSessions
            .filter((session) => webSocketServer.connections.get(session.sessionId)?.isOpen)
            .map((session) => ({
                peerId: session.sessionId,
                connectionId: session.sessionId,
            }));
    };

    const resolveAllOpenConnections = (
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] => {
        const stateSyncRecipients = resolveStateSyncRecipients(
            webSocketServer,
            message,
            {
                findGroupSnapshotByRef: (ref) =>
                    options.findGroupSnapshotByRef?.(ref, message),
                findGroupSnapshotById: options.findGroupSnapshotById,
            },
        );
        if (stateSyncRecipients) {
            return stateSyncRecipients;
        }

        return [...webSocketServer.connections.values()]
            .filter((ctx) => ctx.isOpen)
            .map((ctx) => ({
                peerId: ctx.id,
                connectionId: ctx.id,
            }));
    };

    return {
        resolvePeerRecipients: (peerId) => {
            const ctx = webSocketServer.connections.get(peerId);
            return ctx?.isOpen
                ? [
                    {
                        peerId,
                        connectionId: peerId,
                    },
                ]
                : [];
        },
        resolveGroupRecipients: (groupId, _message: ALMessage) =>
            resolveGroupRecipients(groupId, _message),
        resolveBroadcastRecipients: (scope, message) => {
            if (scope === 'room') {
                return resolveGroupRecipients(
                    readALTargetGroupRef(message)?.groupId ?? message.route.contextId,
                    message,
                );
            }

            return resolveAllOpenConnections(message);
        },
        resolvePeerIdForConnection: (connectionId) => connectionId,
    };
}
