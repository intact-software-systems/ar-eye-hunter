import { ResourceEntry, toResourceEntryWithKey, } from '@shared/queuebox/ResourceEntry.ts';
import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import {
    WsQueueBoxServerService,
    type WsServerResolvedRecipient,
    type WsServerTargetResolver,
} from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { PSqlQueueBox } from './queuebox/PSqlQueueBox.ts';
import * as dbListen from './db/db-listen.ts';
import * as dbNotify from './db/db-notify.ts';
import { myPublisherId, PublishMessage } from './db/db-notify.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { toResilienceDto } from './config-repo.ts';
import { initialiseServerCacheRepositories } from './cache/server-cache-repositories.ts';
import {
    configureServerWsQBoxALRuntimeStores,
    resolveServerWsQBoxALInboundRuntimeStores,
    resolveServerWsQBoxALOutboundRuntimeStores,
} from './persistence/createPSqlALRuntimeStores.ts';
import { initResourceInboxExpiryEviction } from './repository/ResourceInboxRepository.ts';
import { createClientStateRepository, createGroupStateRepository, } from './repository/createStateRepositories.ts';
import { sql } from './db/db.ts';
import { ClientStateRepository } from './repository/ClientStateRepository.ts';
import { GroupStateRepository } from './repository/GroupStateRepository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export type Middleware = {
    qboxEngine: InboxOutboxEngine;
    wsQBoxServerService: WsQueueBoxServerService;
    clientsRepository: ClientStateRepository;
    groupsRepository: GroupStateRepository;
};

let middleware: Middleware | undefined = undefined;

export function getMiddleware(): Middleware {
    if (middleware === undefined) {
        throw new Error('Middleware not initialised');
    }
    return middleware;
}

export function initialiseMiddleware() {
    middleware = initialise();
    return middleware;
}

function initialise(): Middleware {
    initialiseServerCacheRepositories();

    const engine = new InboxOutboxEngine();

    const dbWsChannelId = 'ws-channel';
    const wsRuntimeName = 'default-qbox-server';
    const queueBox = new PSqlQueueBox();
    const webSocketServer = new JsonWebSocketServer();
    configureServerWsQBoxALRuntimeStores(wsRuntimeName);
    initResourceInboxExpiryEviction(queueBox.repo)
        .catch((e) =>
            console.error('Failed to initialise resource inbox expiry eviction:', e)
        );

    const wsQBoxServerService: WsQueueBoxServerService =
        new WsQueueBoxServerService(
            queueBox,
            queueBox,
            webSocketServer,
            wsRuntimeName,
            {
                targetResolver: createWsServerTargetResolver(webSocketServer),
                inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
                outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(
                    wsRuntimeName,
                ),
            },
        );

    wsQBoxServerService.onAllInboxMessagesDo(
        {
            onMessage: async (_, entry: ResourceEntry, __) => {
                await dbNotify.notify(
                    dbWsChannelId,
                    {
                        key: entry.key,
                        channel: dbWsChannelId,
                        publisherId: myPublisherId,
                        typeId: entry.typeId,
                        payload: entry.resource,
                    },
                );
            },
        },
    );

    wsQBoxServerService.onAllOutboxMessagesDo(
        {
            onMessage: async (_, entry: ResourceEntry, __) => {
                await dbNotify.notify(
                    dbWsChannelId,
                    {
                        key: entry.key,
                        channel: dbWsChannelId,
                        publisherId: myPublisherId,
                        typeId: entry.typeId,
                        payload: entry.resource,
                    },
                );
            },
        },
    );

    dbListen.startListening(
            dbWsChannelId,
            async (message: PublishMessage) => {
                console.log(`Received message: ${message}`);

                let entry: ResourceEntry;

                try {
                    entry = QueueBoxUtilities.toResourceEntryFromMsg(
                        JSON.parse(message.payload) as ALMessage,
                        message.typeId,
                    );
                } catch (error) {
                    console.warn(
                        'Failed to parse published payload as ALMessage. Falling back to raw queue entry reconstruction.',
                        error,
                    );
                    entry = toResourceEntryWithKey(
                        message.key,
                        message.typeId,
                        message.payload,
                    );
                }

                await wsQBoxServerService.inbox.enqueueIfAbsent(
                    entry,
                );
            },
        )
        .finally(() => {
            // is it finished if it reaches here?
        });

    const resilienceInbox = toResilienceDto();

    engine.includeTask(
        WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                wsQBoxServerService
                    .inbox
                    .isAnyEntryToLock(
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
        },
    );

    const resilienceOutbox = toResilienceDto();

    engine.includeTask(
        WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        {
            name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
            maxConcurrency: () => 1,
            isWork: () =>
                wsQBoxServerService
                    .outbox
                    .isAnyEntryToLock(
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
        },
    );

    return {
        qboxEngine: engine,
        wsQBoxServerService: wsQBoxServerService,
        clientsRepository: createClientStateRepository(sql),
        groupsRepository: createGroupStateRepository(sql),
    };
}

function createWsServerTargetResolver(
    webSocketServer: JsonWebSocketServer,
): WsServerTargetResolver {
    const resolveGroupRecipients = (
        groupId: string,
    ): readonly WsServerResolvedRecipient[] => {
        const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotById(
            groupId,
        );
        if (!snapshot) {
            return [];
        }

        return snapshot.activeSessions
            .filter((session) =>
                webSocketServer.connections.get(session.sessionId)?.isOpen
            )
            .map((session) => ({
                peerId: session.sessionId,
                connectionId: session.sessionId,
            }));
    };

    const resolveAllOpenConnections =
        (): readonly WsServerResolvedRecipient[] => {
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
                ? [{
                    peerId,
                    connectionId: peerId,
                }]
                : [];
        },
        resolveGroupRecipients,
        resolveBroadcastRecipients: (scope, message) => {
            if (scope === 'room') {
                return resolveGroupRecipients(message.route.contextId);
            }

            return resolveAllOpenConnections();
        },
        resolvePeerIdForConnection: (connectionId) => connectionId,
    };
}
