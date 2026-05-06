import { ResourceEntry, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
    initResourceInboxExpiryEviction,
    ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    configureServerWsQBoxALRuntimeStores,
    resolveServerWsQBoxALInboundRuntimeStores,
    resolveServerWsQBoxALOutboundRuntimeStores,
} from '@shared-server/postgres/al-runtime/createPSqlALRuntimeStores.ts';
import {
    createRallarMiddleware,
    type RallarMiddlewareRuntime,
} from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import * as dbListen from './db/db-listen.ts';
import * as dbNotify from './db/db-notify.ts';
import { myPublisherId, PublishMessage } from './db/db-notify.ts';
import { toResilienceDto } from './middleware-resilience.ts';
import { createClientStateRepository, createGroupStateRepository, } from './repository/createStateRepositories.ts';
import { sql } from './db/db.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export type Middleware = RallarMiddlewareRuntime;

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
    const dbWsChannelId = 'ws-channel';
    const wsRuntimeName = 'default-qbox-server';
    const postgresSql = sql as unknown as PSqlSql;
    const resourceInboxRepository = new ResourceInboxRepository(postgresSql);
    const queueBox = new PSqlQueueBox(resourceInboxRepository);
    const webSocketServer = new JsonWebSocketServer();
    const resilienceInbox = toResilienceDto();
    const resilienceOutbox = toResilienceDto();

    configureServerWsQBoxALRuntimeStores(wsRuntimeName, { sql: postgresSql });
    initResourceInboxExpiryEviction(queueBox.repo).catch((e) =>
        console.error('Failed to initialise resource inbox expiry eviction:', e)
    );

    const runtime = createRallarMiddleware({
        inbox: queueBox,
        outbox: queueBox,
        webSocketServer,
        wsRuntimeName,
        findGroupSnapshotById: groupStateSnapshotsRepository.findGroupStateSnapshotById,
        inboundStores: resolveServerWsQBoxALInboundRuntimeStores(wsRuntimeName),
        outboundStores: resolveServerWsQBoxALOutboundRuntimeStores(wsRuntimeName),
        resilience: {
            inbox: resilienceInbox,
            outbox: resilienceOutbox,
        },
        clientsRepository: createClientStateRepository(sql),
        groupsRepository: createGroupStateRepository(sql),
    });

    runtime.wsQBoxServerService.onAllInboxMessagesDo({
        onMessage: async (_, entry: ResourceEntry, __) => {
            await dbNotify.notify(dbWsChannelId, {
                key: entry.key,
                channel: dbWsChannelId,
                publisherId: myPublisherId,
                typeId: entry.typeId,
                payload: entry.resource,
            });
        },
    });

    runtime.wsQBoxServerService.onAllOutboxMessagesDo({
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
    });

    dbListen
        .startListening(dbWsChannelId, async (message: PublishMessage) => {
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
                entry = toResourceEntryWithKey(message.key, message.typeId, message.payload);
            }

            await runtime.wsQBoxServerService.inbox.enqueueIfAbsent(entry);
        })
        .finally(() => {
            // is it finished if it reaches here?
        });

    return runtime;
}
