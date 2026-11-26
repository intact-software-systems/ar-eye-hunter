import { Temporal } from '@js-temporal/polyfill';

import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores,
    toServerWsQBoxALRuntimeStoreId
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { isInstanceLocalRtcSignal } from '@shared-server/rallar-system/communication/is-instance-local-rtc-signal.ts';
import {
    installLiveWsNoticeSubscriber,
    sendReceivedLiveWsNotice
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { installRelayedAckNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice-subscriber.ts';
import {
    createRelayedAckPublisher,
    type RelayedAckNoticeChannel
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import { writeViewResync } from '@shared-server/rallar-system/websocket/write-view-resync.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsServerTargetResolver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import type { ApiV1CircuitBreakerConfiguration } from '../../../src/configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from '../../../src/db/api-v1-database-lifecycle.ts';
import { API_V1_LIVE_WS_NOTICE_CHANNEL } from '../../../src/db/api-v1-live-ws-notice-transport.ts';
import { API_V1_QUEUE_BOX_KEY_CHANNEL } from '../../../src/db/api-v1-queue-pubsub-bridge.ts';
import {
    createPostgresLiveWsNoticeTransport,
    type ManagedLiveWsNoticeTransport
} from '../../../src/db/create-postgres-live-ws-notice-transport.ts';
import { createPostgresQueuePubSubBridge } from '../../../src/db/create-postgres-queue-pub-sub-bridge.ts';
import {
    API_V1_RELAYED_ACK_CHANNEL,
    createPostgresRelayedAckNoticeTransport
} from '../../../src/db/create-postgres-relayed-ack-notice-transport.ts';
import { createApiV1QueueResilience } from '../../../src/middleware-resilience.ts';
import { readAuthorisedWsConnectionEligibility } from '../../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { filterEligibleLiveWsSessionIds } from '../../../src/services/filter-eligible-live-ws-session-ids.ts';

/** What one instance's WS server is wired from. Both database values are the delayed ones, never the lifecycle's own. */
export interface OrderedSendWsServerInput {
    /** Every repository, store and queue of the server sends its statements through this handle. */
    readonly sql: PSqlSql;
    /** Every NOTIFY the server publishes goes through this port, and every LISTEN it holds is this port's. */
    readonly notification: ApiV1DatabaseNotificationPort;
    /** Names the run's store namespace and its NOTIFY channels, so two runs on one database never meet. */
    readonly runId: string;
    /** This instance among the publishers of the run's notices: an instance never takes its own notice back. */
    readonly publisherId: string;
    readonly authorizeRoomMessage: RallarServerWsRoomAuthorizer;
    /** Invoked once each time the server hands a message to its application, before the application runs. */
    readonly recordHandOff: (message: ALMessage) => void;
    /** The circuit breaker of the server's queue reads: the API's `topology.queueResilience`. */
    readonly queueResilience: ApiV1CircuitBreakerConfiguration;
    readonly nowEpochMs: () => number;
}

/** One instance's WS server, wired as the API wires its own and not yet started. */
export interface OrderedSendWsServer {
    readonly service: WsQueueBoxServerService;
    readonly socketServer: JsonWebSocketServer;
    readonly queueEngine: InboxOutboxEngine;
    /** Settles once the server holds its three LISTEN subscriptions: outbox keys, live notices and relayed ACKs. */
    readonly subscriptionsReady: Promise<void>;
    /** Stops the live notice subscription's own timers. */
    stopLiveNotices(): Promise<void>;
}

interface OrderedSendStores {
    readonly inbound: ALInboundRuntimeStores;
    readonly outbound: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly queueBox: PSqlQueueBox;
    readonly volatileNamespace: string;
}

interface OrderedSendNoticeChannels {
    readonly queueBoxKeys: string;
    readonly liveNotices: string;
    readonly relayedAcks: RelayedAckNoticeChannel;
}

interface OrderedSendWsServiceInput {
    readonly stores: OrderedSendStores;
    readonly socketServer: JsonWebSocketServer;
    readonly queueEngine: InboxOutboxEngine;
    readonly targetResolver: WsServerTargetResolver;
    readonly relayedAcks: RelayedAckNoticeChannel;
    readonly queueResilience: ApiV1CircuitBreakerConfiguration;
}

interface OrderedSendRouterInput {
    readonly server: OrderedSendWsServerInput;
    readonly service: WsQueueBoxServerService;
    readonly queueEngine: InboxOutboxEngine;
    readonly grantedTopics: WsGrantedTopicSet;
    readonly channels: OrderedSendNoticeChannels;
}

interface OrderedSendSubscribersInput {
    readonly server: OrderedSendWsServerInput;
    readonly service: WsQueueBoxServerService;
    readonly socketServer: JsonWebSocketServer;
    readonly queueEngine: InboxOutboxEngine;
    readonly targetResolver: WsServerTargetResolver;
    readonly stores: OrderedSendStores;
    readonly channels: OrderedSendNoticeChannels;
    readonly liveNotices: ManagedLiveWsNoticeTransport;
}

/** The peer id every instance of the API answers as: the `wsRuntimeName` its composition root passes. */
export const ORDERED_SEND_SERVER_PEER_ID = 'default-qbox-server';

/** A pub/sub requeue puts a failed remote send's WS outbox row back, as the middleware names it. */
const PUB_SUB_REQUEUE_TYPES: ReadonlySet<string> = new Set([EnqueuedType.WS_OUTBOX]);

const HAND_OFF_OBSERVER_ID = 'ordered-send-cell-hand-off';

/** The namespace of the run's inbound and outbound stores: the API's own store id, and the run's id after it. */
export function toOrderedSendStoreNamespace(runId: string): string {
    return `${toServerWsQBoxALRuntimeStoreId(ORDERED_SEND_SERVER_PEER_ID)}:${runId}`;
}

/**
 * One instance's WS server, wired as `createRallarMiddlewareInfrastructure` and `RallarServerApplication` wire the
 * API's: the service with the middleware's options, the topic router as its application with the API's router
 * options, and the three subscriptions that join the instances through PostgreSQL. What it leaves out, and the one
 * port it replaces, the run's entry states.
 */
export function createOrderedSendWsServer(input: OrderedSendWsServerInput): OrderedSendWsServer {
    const socketServer = new JsonWebSocketServer();
    const queueEngine = new InboxOutboxEngine();
    const grantedTopics = new WsGrantedTopicSet();
    const targetResolver = createWsServerTargetResolver(socketServer, { grantedTopics });
    const stores = createOrderedSendStores(input.sql, input.runId);
    const channels = toOrderedSendNoticeChannels(input);
    const service = createOrderedSendWsService({
        stores,
        socketServer,
        queueEngine,
        targetResolver,
        relayedAcks: channels.relayedAcks,
        queueResilience: input.queueResilience
    });

    // Registered before the router's own observer, which runs the application: a hand-off is read before it starts.
    service.onAnyInboxMessageDo(HAND_OFF_OBSERVER_ID, {
        onMessage: async (message) => input.recordHandOff(message)
    });
    installOrderedSendRouter({ server: input, service, queueEngine, grantedTopics, channels });

    const liveNotices = createPostgresLiveWsNoticeTransport(input.notification, input.nowEpochMs);
    const subscriptionsReady = installOrderedSendSubscribers({
        server: input,
        service,
        socketServer,
        queueEngine,
        targetResolver,
        stores,
        channels,
        liveNotices
    });
    return { service, socketServer, queueEngine, subscriptionsReady, stopLiveNotices: () => liveNotices.stop() };
}

function createOrderedSendStores(sql: PSqlSql, runId: string): OrderedSendStores {
    const repository = new PSqlRuntimeStateRepository(sql);
    const namespace = toOrderedSendStoreNamespace(runId);
    return {
        inbound: createDefaultPSqlALInboundRuntimeStores({ namespace, repository }),
        outbound: createDefaultPSqlALOutboundRuntimeStores({
            namespace,
            repository,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        }),
        queueBox: new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant),
        volatileNamespace: `${namespace}:volatile`
    };
}

/** The API's three channel names, each with the run's id after it. */
function toOrderedSendNoticeChannels(input: OrderedSendWsServerInput): OrderedSendNoticeChannels {
    return {
        queueBoxKeys: `${API_V1_QUEUE_BOX_KEY_CHANNEL}-${input.runId}`,
        liveNotices: `${API_V1_LIVE_WS_NOTICE_CHANNEL}-${input.runId}`,
        relayedAcks: {
            transport: createPostgresRelayedAckNoticeTransport(input.notification),
            channel: `${API_V1_RELAYED_ACK_CHANNEL}-${input.runId}`,
            publisherId: input.publisherId
        }
    };
}

/** The options `createMiddlewareWsQueueBoxServer` passes, with the values the API's composition root gives them. */
function createOrderedSendWsService(input: OrderedSendWsServiceInput): WsQueueBoxServerService {
    const { stores } = input;
    return createDefaultWsQueueBoxServerService({
        queueEngine: input.queueEngine,
        outbox: stores.queueBox,
        socket: input.socketServer,
        name: ORDERED_SEND_SERVER_PEER_ID,
        targetResolver: input.targetResolver,
        readAuthenticatedConnectionScope: readAuthorisedWsConnectionEligibility,
        inboundStores: stores.inbound,
        inboundVolatileStores: createVolatileALInboundRuntimeStores({ namespace: stores.volatileNamespace }, undefined),
        keepsVolatileMessageInMemory: isInstanceLocalRtcSignal,
        outboundStores: stores.outbound,
        dequeueResilience: createApiV1QueueResilience(
            input.queueResilience,
            ResourceInboxResilience.DEFAULT_RESERVATION_LEASE_MS,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY
        ),
        publishRelayedAck: createRelayedAckPublisher(input.relayedAcks),
        forwardsRoomScopedMessages: false
    });
}

/**
 * The application of the service: the topic router, with the options `createDefaultRallarServerWsOptions` and
 * `RallarServerApplication` give the API's, but for the room authorizer, which is the run's.
 */
function installOrderedSendRouter(input: OrderedSendRouterInput): void {
    const { server, queueEngine } = input;
    new RallarServerWsRouter(input.service, {
        grantedTopics: input.grantedTopics,
        authorizeRoomMessage: server.authorizeRoomMessage,
        livePublication: {
            transport: createPostgresLiveWsNoticeTransport(server.notification, server.nowEpochMs),
            channel: input.channels.liveNotices,
            publisherId: server.publisherId
        },
        wakeOutbox: () => queueEngine.wake()
    }).install();
}

/** The subscriptions `createRallarMiddlewareInfrastructure` installs, in its order, each over its LISTEN. */
function installOrderedSendSubscribers(input: OrderedSendSubscribersInput): Promise<void> {
    const { server, service, socketServer, queueEngine, channels } = input;
    const writeResync = () =>
        writeViewResync(service, { messageId: crypto.randomUUID(), createdAtEpochMs: server.nowEpochMs() });
    const targetResolution = new WsQueueBoxServerTargetResolution({
        socket: socketServer,
        targetResolver: input.targetResolver
    });
    const queueBoxBridgeReady = installQueueBoxPubSubBridge({
        bridge: createPostgresQueuePubSubBridge(server.notification),
        channel: channels.queueBoxKeys,
        publisherId: server.publisherId,
        onSubscribed: writeResync,
        wsQBoxServerService: service,
        wakeQueueEngine: () => queueEngine.wakeAfterExternalWrite(PUB_SUB_REQUEUE_TYPES)
    });
    const liveNoticesReady = installLiveWsNoticeSubscriber({
        transport: input.liveNotices,
        channel: channels.liveNotices,
        publisherId: server.publisherId,
        nowMs: server.nowEpochMs,
        filterEligibleRecipientSessionIds: (candidateSessionIds, notice) =>
            filterEligibleLiveWsSessionIds({ socketServer, candidateSessionIds, notice, nowMs: server.nowEpochMs() }),
        onSubscribed: writeResync,
        inboundStores: [input.stores.inbound.admissionStore],
        resolveBroadRecipientSessionIds: (message) =>
            targetResolution.resolveOutboundRecipients(message).map((recipient) => recipient.connectionId),
        sendToTargetsWithResult: (delivery) => sendReceivedLiveWsNotice(service, delivery)
    });
    const relayedAcksReady = installRelayedAckNoticeSubscriber({
        ...channels.relayedAcks,
        acceptRelayedAck: (message, publisherId) => service.acceptRelayedAck(message, publisherId)
    });
    return Promise.all([queueBoxBridgeReady, liveNoticesReady, relayedAcksReady]).then(() => undefined);
}
