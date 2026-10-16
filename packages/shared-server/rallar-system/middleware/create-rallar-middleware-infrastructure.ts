import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { WsServerTargetResolver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { toAppInboxEntryCompletionAwaitability } from '../app-inbox/app-inbox-command-identity.ts';
import { isAppInboxRetryableConflict } from '../app-inbox/app-inbox-error-classification.ts';
import { AppInboxDequeuePassTiming } from '../app-inbox/handler/app-inbox-dequeue-pass-timing.ts';
import { validateRtcSignalingMessage } from '../communication/decode-rtc-signaling-route.ts';
import { nowMs } from '../observability/timing.ts';
import { installAppInboxCompletionNoticeSubscriber } from '../queue-pubsub/app-inbox-completion-notice.ts';
import { installLiveWsNoticeSubscriber } from '../queue-pubsub/live-ws-notice-subscriber.ts';
import { installQueueBoxPubSubBridge } from '../queue-pubsub/queue-box-pub-sub-bridge.ts';
import { installRelayedAckNoticeSubscriber } from '../queue-pubsub/relayed-ack-notice-subscriber.ts';
import { createRelayedAckPublisher } from '../queue-pubsub/relayed-ack-notice.ts';
import { createWsServerTargetResolver } from '../websocket/targets/create-ws-server-target-resolver.ts';
import { initialiseRallarServerCacheRepositories } from './cache-repositories.ts';
import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareDequeuePassTimingOptions,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';

interface InstallMiddlewareLiveWsNoticeSubscriberInput {
    readonly options: CreateRallarMiddlewareOptions;
    readonly webSocketServer: JsonWebSocketServer;
    readonly targetResolver: WsServerTargetResolver;
    readonly wsQBoxServerService: RallarMiddlewareInfrastructure['wsQBoxServerService'];
}

/**
 * The queues an AppInbox-pipeline writer fills: its command rows, the outbox rows its commit writes, and
 * the WS outbox rows its state sync writes. AL work rows are written only by their own runtime.
 */
const APP_INBOX_PIPELINE_TYPES: ReadonlySet<string> = new Set([
    EnqueuedType.APP_INBOX,
    EnqueuedType.APP_OUTBOX,
    EnqueuedType.WS_OUTBOX
]);

/** A pub/sub requeue puts a failed remote send's WS outbox row back. */
const PUB_SUB_REQUEUE_TYPES: ReadonlySet<string> = new Set([EnqueuedType.WS_OUTBOX]);

interface CreateMiddlewareWsQueueBoxServerInput {
    readonly options: CreateRallarMiddlewareOptions;
    readonly queueEngine: InboxOutboxEngine;
    readonly webSocketServer: JsonWebSocketServer;
    readonly targetResolver: WsServerTargetResolver;
}

export function createRallarMiddlewareInfrastructure(
    options: CreateRallarMiddlewareOptions,
    queueEngine: InboxOutboxEngine
): RallarMiddlewareInfrastructure {
    assertSharedInboundStoreAcrossInstances(options);
    initialiseRallarServerCacheRepositories();
    const webSocketServer = options.webSocketServer ?? new JsonWebSocketServer();
    const targetResolver = options.targetResolver ??
        createWsServerTargetResolver(webSocketServer, {
            findGroupSnapshotByRef: options.findGroupSnapshotByRef,
            findClientSnapshotByRef: options.findClientSnapshotByRef,
            now: options.now
        });
    const wsQBoxServerService = createMiddlewareWsQueueBoxServer({
        options,
        queueEngine,
        webSocketServer,
        targetResolver
    });
    const queuePubSubBridgeReadiness = options.queuePubSubBridge
        ? installQueueBoxPubSubBridge({
            ...options.queuePubSubBridge,
            wsQBoxServerService,
            receiptObserver: options.wsReceiptObserver,
            wakeQueueEngine: () => queueEngine.wakeAfterExternalWrite(PUB_SUB_REQUEUE_TYPES)
        })
        : Promise.resolve();
    const liveWsNoticeSubscriberReadiness = Promise.all([
        installMiddlewareLiveWsNoticeSubscriber({
            options,
            webSocketServer,
            targetResolver,
            wsQBoxServerService
        }),
        options.relayedAckNotices
            ? installRelayedAckNoticeSubscriber({
                ...options.relayedAckNotices,
                acceptRelayedAck: (message, publisherId) => wsQBoxServerService.acceptRelayedAck(message, publisherId)
            })
            : Promise.resolve(),
        installMiddlewareAppInboxCompletionNoticeSubscriber(options)
    ]).then(() => undefined);

    return {
        wsQBoxServerService,
        inboxQueueReader: createMiddlewareInboxQueueReader(options),
        outboxQueueReader: createMiddlewareOutboxQueueReader(options),
        appInboxResilience: options.resilience.appInbox ?? options.resilience.inbox,
        appOutboxResilience: options.resilience.appOutbox,
        queuePubSubBridgeReadiness,
        liveWsNoticeSubscriberReadiness,
        wakeQueueEngine: () => queueEngine.wakeAfterExternalWrite(APP_INBOX_PIPELINE_TYPES)
    };
}

function installMiddlewareAppInboxCompletionNoticeSubscriber(options: CreateRallarMiddlewareOptions): Promise<void> {
    const notifications = options.appInboxDequeueOptions.completionNotifications;
    if (options.appInboxCompletionNotices === undefined || notifications === undefined) {
        return Promise.resolve();
    }
    return installAppInboxCompletionNoticeSubscriber({ ...options.appInboxCompletionNotices, notifications });
}

function createMiddlewareInboxQueueReader(options: CreateRallarMiddlewareOptions): InboxQueueReader {
    const inboxQueueReader = new InboxQueueReader(
        options.inbox,
        {
            ...options.appInboxDequeueOptions,
            isRetryableConflict: isAppInboxRetryableConflict,
            toCompletionAwaitability: toAppInboxEntryCompletionAwaitability
        }
    );
    installDequeuePassTiming(inboxQueueReader, options.appInboxDequeuePassTiming);
    return inboxQueueReader;
}

function createMiddlewareOutboxQueueReader(options: CreateRallarMiddlewareOptions): OutboxQueueReader {
    const outboxQueueReader = new OutboxQueueReader(options.outbox ?? options.inbox);
    installDequeuePassTiming(outboxQueueReader, options.appInboxDequeuePassTiming);
    return outboxQueueReader;
}

/** Each reader observes its own passes, so each gets its own timing with the server's one sink. */
function installDequeuePassTiming(
    reader: Pick<InboxQueueReader, 'onDequeuePassDo'>,
    timing: RallarMiddlewareDequeuePassTimingOptions | undefined
): void {
    if (timing === undefined) {
        return;
    }
    reader.onDequeuePassDo(
        new AppInboxDequeuePassTiming({ database: timing.database, nowMs }, {
            serviceId: timing.serviceId,
            sink: timing.sink
        })
    );
}

function createMiddlewareWsQueueBoxServer(
    { options, queueEngine, webSocketServer, targetResolver }: CreateMiddlewareWsQueueBoxServerInput
): RallarMiddlewareInfrastructure['wsQBoxServerService'] {
    return createDefaultWsQueueBoxServerService({
        queueEngine,
        outbox: options.outbox ?? options.inbox,
        socket: webSocketServer,
        name: options.wsRuntimeName ?? 'default-qbox-server',
        targetResolver,
        readProducerProvenance: options.readWsOutboxProducerProvenance,
        readAuthenticatedConnectionScope: options.readAuthenticatedConnectionScope,
        inboundStores: options.inboundStores,
        inboundVolatileStores: options.inboundVolatileStores,
        outboundStores: options.outboundStores,
        dequeueResilience: options.resilience.outbox,
        deliveryDiagnostics: options.wsDeliveryDiagnostics,
        outboundDiagnostics: options.wsOutboundDiagnostics,
        outboundSettlements: options.wsOutboundSettlements,
        inboundDiagnostics: options.wsInboundDiagnostics,
        receiptObserver: options.wsReceiptObserver,
        authorizeInboundMessage: authorizeMiddlewareALIngress,
        publishRelayedAck: options.relayedAckNotices
            ? createRelayedAckPublisher(options.relayedAckNotices)
            : undefined,
        forwardsRoomScopedMessages: false
    });
}

/**
 * Another instance proves a relayed acknowledgement's sender against the message's admission, and reads an oversized
 * live notice's message, from the shared inbound store: a memory pair would hide both from it.
 */
function assertSharedInboundStoreAcrossInstances(options: CreateRallarMiddlewareOptions): void {
    if (options.inboundVolatileStores !== undefined && options.relayedAckNotices !== undefined) {
        throw new TypeError(
            'A WS server relaying acknowledgements to other instances admits every message to its shared inbound store.'
        );
    }
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

function authorizeMiddlewareALIngress(message: ALMessage): Either<ALMessageRejection, ALMessage> {
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
        return isStateSnapshotPageValue(JSON.parse(resource));
    }
    catch {
        return false;
    }
}

function isStateSnapshotPageValue(value: unknown): value is Readonly<{ kind: 'state-snapshot-page'; }> {
    return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'state-snapshot-page';
}
