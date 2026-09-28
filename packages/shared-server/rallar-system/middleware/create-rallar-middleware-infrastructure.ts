import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { WsServerTargetResolver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { validateRtcSignalingMessage } from '../communication/decode-rtc-signaling-route.ts';
import { installLiveWsNoticeSubscriber } from '../queue-pubsub/live-ws-notice-subscriber.ts';
import { installQueueBoxPubSubBridge } from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import { createWsServerTargetResolver } from '../websocket/targets/create-ws-server-target-resolver.ts';
import { initialiseRallarServerCacheRepositories } from './cache-repositories.ts';
import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';

interface InstallMiddlewareLiveWsNoticeSubscriberInput {
    readonly options: CreateRallarMiddlewareOptions;
    readonly webSocketServer: JsonWebSocketServer;
    readonly targetResolver: WsServerTargetResolver;
    readonly wsQBoxServerService: RallarMiddlewareInfrastructure['wsQBoxServerService'];
}

export function createRallarMiddlewareInfrastructure(
    options: CreateRallarMiddlewareOptions,
    queueEngine: InboxOutboxEngine
): RallarMiddlewareInfrastructure {
    initialiseRallarServerCacheRepositories();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver = options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findClientSnapshotByRef: options.findClientSnapshotByRef,
            now: options.now
        });
    const wsQBoxServerService = createDefaultWsQueueBoxServerService({
        queueEngine,
        outbox: options.outbox ?? options.inbox,
        socket: webSocketServer,
        name: options.wsRuntimeName ?? 'default-qbox-server',
        targetResolver,
        readAuthenticatedConnectionScope: options.readAuthenticatedConnectionScope,
        inboundStores: options.inboundStores,
        outboundStores: options.outboundStores,
        dequeueResilience: options.resilience.outbox ?? options.resilience.inbox,
        deliveryDiagnostics: options.wsDeliveryDiagnostics,
        outboundDiagnostics: options.wsOutboundDiagnostics,
        outboundSettlements: options.wsOutboundSettlements,
        inboundDiagnostics: options.wsInboundDiagnostics,
        validateInboundMessage: validateMiddlewareALIngress,
        forwardsRoomScopedMessages: false
    });
    const queuePubSubBridgeReadiness = options.queuePubSubBridge
        ? installQueueBoxPubSubBridge({
            ...options.queuePubSubBridge,
            wsQBoxServerService,
            wakeQueueEngine: () => queueEngine.wakeAfterExternalWrite()
        })
        : Promise.resolve();
    const liveWsNoticeSubscriberReadiness = installMiddlewareLiveWsNoticeSubscriber({
        options,
        webSocketServer,
        targetResolver,
        wsQBoxServerService
    });

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
        liveWsNoticeSubscriberReadiness,
        wakeQueueEngine: () => queueEngine.wakeAfterExternalWrite()
    };
}

function installMiddlewareLiveWsNoticeSubscriber(
    input: InstallMiddlewareLiveWsNoticeSubscriberInput
): Promise<void> {
    const { options, webSocketServer, targetResolver, wsQBoxServerService } = input;
    if (!options.liveWsNoticeSubscriber) {
        return Promise.resolve();
    }
    const targetResolution = new WsQueueBoxServerTargetResolution({ socket: webSocketServer, targetResolver });
    return installLiveWsNoticeSubscriber({
        ...options.liveWsNoticeSubscriber,
        inboundStores: options.inboundStores ? [options.inboundStores.admissionStore] : [],
        resolveBroadRecipientSessionIds: (message) =>
            targetResolution.resolveOutboundRecipients(message).map((recipient) => recipient.connectionId),
        sendToTargetsWithResult: ({ message, recipientSessionIds, notice, audience }) => {
            wsQBoxServerService.sendToTargetsWithResult({
                message,
                expiresAtMs: notice.expiresAtMs,
                recipientSessionIds,
                inboundScope: message.targets?.mode === 'unicast' ? notice.scope : undefined,
                recipientScope: notice.scope,
                recipientPrincipalId: audience.mode === 'principal'
                    ? audience.principalRef.principalId
                    : undefined,
                requireAuthenticatedRecipient: true
            });
        }
    });
}

function validateMiddlewareALIngress(message: ALMessage): Either<ALMessageRejection, ALMessage> {
    if (
        isStateSnapshotTopic(message.route.topicId) || isStateSnapshotTopic(message.payload.typeId) ||
        message.route.topicId === AppTopics.clientStateEvent || message.payload.typeId === AppTopics.clientStateEvent ||
        message.route.topicId === AppTopics.groupStateEvent || message.payload.typeId === AppTopics.groupStateEvent ||
        isStateSnapshotPageResource(message.payload.resource)
    ) {
        return Either.ofLeft({ code: 'unsupported', message: 'State sync uses its own admission owner' });
    }
    const routeIsSignaling = message.route.topicId === AppTopics.rtcSignaling;
    const payloadIsSignaling = message.payload.typeId === AppTopics.rtcSignaling;
    if (routeIsSignaling || payloadIsSignaling) {
        if (!routeIsSignaling || !payloadIsSignaling) {
            return Either.ofLeft({ code: 'malformed', message: 'RTC signaling topic and payload type must agree' });
        }
        return validateRtcSignalingMessage(message);
    }
    return Either.ofRight(message);
}

function isStateSnapshotPageResource(resource: string): boolean {
    try {
        const value: unknown = JSON.parse(resource);
        return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'state-snapshot-page';
    }
    catch {
        return false;
    }
}
