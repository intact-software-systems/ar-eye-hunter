import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import { installQueueBoxPubSubBridge } from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import { decodeStateSyncMessage } from '../state-sync/state-sync-payload.ts';
import { createWsServerTargetResolver } from '../websocket/targets/create-ws-server-target-resolver.ts';
import { initialiseServerCacheRepositories } from './cache-repositories.ts';
import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';

export function createRallarMiddlewareInfrastructure(
    options: CreateRallarMiddlewareOptions,
    wakeQueueEngine: () => void
): RallarMiddlewareInfrastructure {
    initialiseServerCacheRepositories();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver = options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findClientSnapshotByRef: options.findClientSnapshotByRef,
            findGroupSnapshotById: options.findGroupSnapshotById,
            resolveGroupRef: options.resolveGroupRef,
            now: options.now
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
            deliveryDiagnostics: options.wsDeliveryDiagnostics,
            admitInboundMessage: (message) => decodeStateSyncMessage(message).kind === 'unsupported',
            forwardsRoomScopedMessages: false
        }
    );
    const queuePubSubBridgeReadiness = options.queuePubSubBridge
        ? installQueueBoxPubSubBridge({
            ...options.queuePubSubBridge,
            wsQBoxServerService
        })
        : Promise.resolve();

    return {
        wsQBoxServerService,
        inboxQueueReader: new InboxQueueReader(
            options.inbox,
            options.appInboxDequeueOptions
        ),
        outboxQueueReader: new OutboxQueueReader(options.outbox ?? options.inbox),
        appInboxResilience: options.resilience.appInbox ?? options.resilience.inbox,
        appOutboxResilience: options.resilience.appOutbox,
        queuePubSubBridgeReadiness,
        wakeQueueEngine
    };
}
