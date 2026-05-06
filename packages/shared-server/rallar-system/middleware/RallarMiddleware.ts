import type { ALInboundRuntimeStores } from '@shared/alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/ALOutboundMessageRuntime.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
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

export type RallarMiddlewareRuntime = Readonly<{
    qboxEngine: InboxOutboxEngine;
    wsQBoxServerService: WsQueueBoxServerService;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
}>;

export type CreateRallarMiddlewareOptions = Readonly<{
    inbox: QueueBoxResourceEntryRepository;
    outbox?: QueueBoxResourceEntryRepository;
    webSocketServer?: JsonWebSocketServer;
    wsRuntimeName?: string;
    targetResolver?: WsServerTargetResolver;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    resilience: Readonly<{
        inbox: ResilienceDto;
        outbox?: ResilienceDto;
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
            findGroupSnapshotById: options.findGroupSnapshotById,
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

    includeWsQueueBoxEngineTasks(
        qboxEngine,
        wsQBoxServerService,
        options.resilience.inbox,
        options.resilience.outbox ?? options.resilience.inbox,
    );

    return {
        qboxEngine,
        wsQBoxServerService,
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

export function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
    options: Readonly<{
        findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    }> = {},
): WsServerTargetResolver {
    const resolveGroupRecipients = (
        groupId: string,
    ): readonly WsServerResolvedRecipient[] => {
        const snapshot = options.findGroupSnapshotById?.(groupId);
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

    const resolveAllOpenConnections = (): readonly WsServerResolvedRecipient[] => {
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
            resolveGroupRecipients(groupId),
        resolveBroadcastRecipients: (scope, message) => {
            if (scope === 'room') {
                return resolveGroupRecipients(message.route.contextId);
            }

            return resolveAllOpenConnections();
        },
        resolvePeerIdForConnection: (connectionId) => connectionId,
    };
}
