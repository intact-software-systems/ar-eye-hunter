import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import { newALNackControlMessage } from '../../al-contracts/al-control.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage,
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import {
    planALMessageHandling,
    resolveALQosNormalizationInput,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import type { ALInboundRuntimeStores } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime, validateALInboundMessage } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '../../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundRuntimeResources } from '../../alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { ResilienceDto } from '../../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import { JsonWebSocketServer, type ConnectionContext } from '../../websocket/json-web-socket-server.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import type { OnWebSocketServerMessageCallback, WebSocketServerMessageContext } from '../queue-message-callbacks.ts';
import { QueueBoxUtilities } from '../QueueBoxUtilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from './decode-ws-queue-box-server-prepared-message.ts';
import {
    type WsDeliveryDiagnosticsSink,
    type WsOutboxDeliveryOutcome,
    type WsServerInboundAuthorization,
    type WsServerInboundAuthorizer,
    type WsServerLiveSendResult,
    type WsServerTargetResolver
} from './ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import {
    WsQueueBoxServerOutboundPlanning,
    type WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerService {
    export interface Input {
        readonly queueEngine?: InboxOutboxEngine;
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly targetResolver?: WsServerTargetResolver;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
        readonly deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
        readonly validateInboundMessage?: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        /**
         * Whether inbound ALM forwarding relays room-scoped messages (default
         * true, the standalone service contract). A composition that installs a
         * topic router with a room authorizer must pass false: the router owns
         * room-scoped fanout behind its authorization, and relaying here would
         * deliver messages the authorizer rejects (and double-deliver the ones
         * it accepts).
         */
        readonly forwardsRoomScopedMessages?: boolean;
    }

    export interface Dependencies {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly targetResolver: WsServerTargetResolver;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundDeliveryOutcome: ((outcome: WsOutboxDeliveryOutcome) => void) | undefined;
        readonly deliveryDiagnostics: WsDeliveryDiagnosticsSink | undefined;
        readonly validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly forwardsRoomScopedMessages: boolean;
    }
}

export class WsQueueBoxServerService {
    private static readonly ALL_IN: string = '*';

    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.WS_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE
    ]);

    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.WS_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE
    ]);

    private readonly onInboxWebSocketMessageCallbacks = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    private readonly onAnyInboxWebSocketMessageCallbacks = new Map<
        string,
        OnWebSocketServerMessageCallback<ALMessage>
    >();

    private outboxClusterPublisher?: (
        message: ALMessage,
        entry: ResourceEntry
    ) => Promise<void>;
    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage>;
    private readonly qosProvider?: ALQosInputProvider;
    private readonly targetResolution: WsQueueBoxServerTargetResolution;
    private readonly liveDelivery: WsQueueBoxServerLiveDelivery;
    private readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    private readonly outboundPlanning: WsQueueBoxServerOutboundPlanning;
    private readonly validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
    private readonly forwardsRoomScopedMessages: boolean;
    private inboundAuthorizer: WsServerInboundAuthorizer | undefined;
    private disposed = false;
    public readonly inbox: QueueBoxResourceEntryRepository;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketServer;
    public readonly name: string;

    constructor(dependencies: WsQueueBoxServerService.Dependencies) {
        this.inbox = dependencies.inbox;
        this.outbox = dependencies.outbox;
        this.socket = dependencies.socket;
        this.name = dependencies.name;
        this.qosProvider = dependencies.qosProvider;
        this.targetResolution = new WsQueueBoxServerTargetResolution({
            socket: dependencies.socket,
            targetResolver: dependencies.targetResolver
        });
        this.deliveryReporting = new WsQueueBoxServerDeliveryReporting({
            outboundOutcome: dependencies.outboundDeliveryOutcome,
            diagnostics: dependencies.deliveryDiagnostics
        });
        this.validateInboundMessage = dependencies.validateInboundMessage;
        this.forwardsRoomScopedMessages = dependencies.forwardsRoomScopedMessages;
        this.liveDelivery = new WsQueueBoxServerLiveDelivery({
            socket: dependencies.socket,
            targetResolution: this.targetResolution,
            deliveryReporting: this.deliveryReporting
        });
        this.outboundPlanning = new WsQueueBoxServerOutboundPlanning({
            serverPeerId: dependencies.name,
            qosProvider: dependencies.qosProvider,
            targetResolution: this.targetResolution,
            deliveryReporting: this.deliveryReporting
        });
        this.outboundRuntime = this.createOutboundRuntime(dependencies);
        this.inboundRuntime = this.createInboundRuntime(dependencies);
        this.registerSocketIngress();
    }

    private createOutboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage> {
        return new ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage>({
            decodePreparedMessage: decodeWsQueueBoxServerPreparedMessage,
            ...dependencies.outboundRuntime,
            diagnostics: dependencies.outboundDiagnostics,
            outbox: this.outbox,
            toOutboxEntry: (message: ALMessage) =>
                QueueBoxUtilities.toResourceEntryFromMsg(
                    message,
                    WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE
                ),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: (message) =>
                this.outboundPlanning.planOutboundMessage(
                    message,
                    'immediate',
                    this.outboxClusterPublisher !== undefined
                ),
            planDequeuedMessage: (message) =>
                this.outboundPlanning.planOutboundMessage(
                    message,
                    'dequeue',
                    this.outboxClusterPublisher !== undefined
                ),
            beforeDequeueDispatch: (message, entry) => {
                const publisher = this.outboxClusterPublisher;
                if (!publisher) {
                    return false;
                }
                return publisher(message, entry).then(() => message.targets !== undefined);
            },
            sendPreparedMessage: async (prepared) => await this.sendPreparedMessage(prepared),
            planRepairMessage: (message, request) =>
                Promise.resolve(this.outboundPlanning.planRepairMessage(message, request)),
            onFallbackDequeue: undefined
        });
    }

    private createInboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime({
            ...dependencies.inboundRuntime,
            inbox: this.inbox,
            planIncomingMessage: (message, fromPeerId, runtime) =>
                this.planIncomingMessage(message, fromPeerId, runtime),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: (entry, plan, source) => this.dispatchInboxEntry(entry, plan, source),
            sendControlMessage: (message) => this.sendControlMessage(message),
            onControlMessage: async (message) => {
                await this.outboundRuntime.acceptControlMessage(message);
            },
            forwardMessage: (message, fromPeerId, plan) => this.forwardIncomingMessage(message, fromPeerId, plan),
            canForwardMessage: (message) => this.forwardsRoomScopedMessages || !isRoomScopedALMessage(message)
        });
    }

    private registerSocketIngress(): void {
        this.socket.onMessageDo(this.name, {
            maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            onMessage: async (connection: ConnectionContext, data) => {
                await this.acceptIncomingMessage(data, connection.id);
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        this.socket.removeOnMessageCallbackById(this.name);
        this.inboundRuntime.dispose();
        this.outboundRuntime.dispose();
        this.onInboxWebSocketMessageCallbacks.clear();
        this.onAnyInboxWebSocketMessageCallbacks.clear();
    }

    authorizeInboundMessagesWith(authorizer: WsServerInboundAuthorizer): void {
        if (this.inboundAuthorizer !== undefined) {
            throw new Error('WS server inbound authorizer is already installed');
        }
        this.inboundAuthorizer = authorizer;
    }

    onOutboxClusterPublishDo(
        publisher: (message: ALMessage, entry: ResourceEntry) => Promise<void>
    ): WsQueueBoxServerService {
        this.outboxClusterPublisher = publisher;
        return this;
    }

    onAllInboxMessagesDo(
        callback: OnWebSocketServerMessageCallback<ALMessage>,
        forceUpdate: boolean = false
    ): WsQueueBoxServerService {
        if (
            !forceUpdate &&
            this.onInboxWebSocketMessageCallbacks.has(WsQueueBoxServerService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws inbox callbacks for ALL_IN');
        }

        this.onInboxWebSocketMessageCallbacks.set(
            WsQueueBoxServerService.ALL_IN,
            callback
        );
        return this;
    }

    onAnyInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): WsQueueBoxServerService {
        this.onAnyInboxWebSocketMessageCallbacks.set(id, callback);
        return this;
    }

    onInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): WsQueueBoxServerService {
        this.onInboxWebSocketMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onInboxWebSocketMessageCallbacks.delete(id);
    }

    removeAnyInboxMessageCallback(id: string): boolean {
        return this.onAnyInboxWebSocketMessageCallbacks.delete(id);
    }

    async enqueueOutboxIfAbsent(message: ALMessage): Promise<ALOutboundEnqueueResult> {
        const dispatchPlan = this.outboundPlanning.planOutboundMessage(
            message,
            'immediate',
            this.outboxClusterPublisher !== undefined
        );
        const outgoingMessage = dispatchPlan.persist
            ? decodePersistedALMessageValue(message)
            : message;

        const result = await this.outboundRuntime.enqueueIfAbsent(
            outgoingMessage,
            dispatchPlan
        );
        if (
            result.status === 'no-route' &&
            result.reason &&
            this.outboundPlanning.isBroadcastWithoutRecipients(
                outgoingMessage,
                result.reason
            )
        ) {
            return {
                ...result,
                entries: [],
                entry: undefined
            };
        }

        return result;
    }

    async dequeueOutbox(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async dequeueInbox(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry)
            )
        );
    }

    private sendControlMessage(message: ALMessage): Promise<void> {
        const toPeerId = message.targets?.mode === 'unicast'
            ? message.targets.toPeerId
            : undefined;
        if (!toPeerId) {
            console.warn(
                `Cannot send WS server control message without unicast target: ${message.payload.typeId}`
            );
            return Promise.resolve();
        }

        const sent = this.liveDelivery.sendToResolvedPeer(toPeerId, message);
        if (sent === 0) {
            console.warn(
                `Cannot resolve WS server control target ${toPeerId} for ${message.payload.typeId}`
            );
        }
        return Promise.resolve();
    }

    async acceptIncomingMessage(
        value: unknown,
        connectionId: string
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        const decoded = decodeALMessageValue(value);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const message = decoded.right!;
        const connection = this.socket.connections.get(connectionId);
        const fromPeerId = this.targetResolution.resolvePeerIdForConnection(connectionId, message);
        if (!connection?.isOpen || !fromPeerId || message.id.senderId !== fromPeerId) {
            return Either.ofLeft({
                code: 'unauthorized',
                message: 'AL origin must match an authenticated live WS connection'
            });
        }
        const protocol = validateALInboundMessage(message, { kind: 'ws-client', peerId: fromPeerId }, this.name);
        if (protocol.left) {
            return Either.ofLeft(protocol.left);
        }
        const validation = this.validateInboundMessage(message);
        if (validation.left) {
            return Either.ofLeft(validation.left);
        }
        if (isRoomScopedALMessage(message) && !this.inboundAuthorizer) {
            return Either.ofLeft({ code: 'unsupported', message: 'Room messages require a server authority provider' });
        }
        const authorization = await this.inboundAuthorizer?.authorize(message) ?? { authorized: true };
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        if (this.socket.connections.get(connectionId) !== connection || !connection.isOpen) {
            return Either.ofLeft({ code: 'unauthorized', message: 'WS connection changed during authorization' });
        }
        if (!authorization.authorized) {
            return await this.rejectIncomingMessage(message, authorization);
        }
        return await this.inboundRuntime.handleIncomingMessage(message, {
            kind: 'ws-client',
            peerId: fromPeerId,
            ...(authorization.roomRecipientPeerIds === undefined
                ? {}
                : { roomRecipientPeerIds: [...authorization.roomRecipientPeerIds] })
        });
    }

    private async rejectIncomingMessage(
        message: ALMessage,
        authorization: Extract<WsServerInboundAuthorization, { authorized: false; }>
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        if (authorization.reason !== 'not-yet-in-sync') {
            return Either.ofLeft({
                code: authorization.rejectionCode ?? 'unauthorized',
                message: authorization.logMessage
            });
        }
        if (authorization.sendNack) {
            const observedAtEpochMs = Date.now();
            const nack = newALNackControlMessage(
                { v: 2, msgId: crypto.randomUUID(), senderId: this.name, ts: observedAtEpochMs },
                {
                    fromPeerId: this.name,
                    toPeerId: message.id.senderId,
                    msgId: message.id.msgId,
                    reason: authorization.reason,
                    observedAtEpochMs,
                    ...(authorization.serverSnapshotVersion === undefined
                        ? {}
                        : { serverSnapshotVersion: authorization.serverSnapshotVersion })
                }
            );
            await this.sendControlMessage(nack);
        }
        return Either.ofRight({ kind: 'not-admitted', reason: authorization.reason });
    }

    private planIncomingMessage(
        message: ALMessage,
        source: ALInboundMessageRuntime.Source,
        observations: ALMessagePlanningObservations
    ): ALMessageHandlingPlan {
        const fromPeerId = source.kind === 'trusted-server' ? message.id.senderId : source.peerId;
        const frozenRecipients = source.kind === 'ws-client' ? source.roomRecipientPeerIds : undefined;
        const recipientPeerIds = this.targetResolution.resolveInboundRecipients(message)
            .map((recipient) => recipient.peerId)
            .filter((peerId) => frozenRecipients === undefined || frozenRecipients.includes(peerId));
        return planALMessageHandling(
            message,
            {
                ...observations,
                selfPeerId: this.name,
                fromPeerId,
                connectedPeerIds: recipientPeerIds,
                groupMemberPeerIds: recipientPeerIds,
                overlayNeighborPeerIds: recipientPeerIds
            },
            resolveALQosNormalizationInput(
                message,
                { selfPeerId: this.name, fromPeerId, direction: 'inbound' },
                this.qosProvider
            )
        );
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan: ALMessageHandlingPlan,
        source: ALInboundMessageRuntime.Source
    ): Promise<void | 'completed' | 'retry'> {
        const message = decodePersistedALMessage(entry.resource);
        const authority = await this.readCurrentDispatchAuthority(message);
        if (authority !== 'authorized') {
            return authority;
        }

        const context: WebSocketServerMessageContext = { server: this.socket, source };
        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback = this.onInboxWebSocketMessageCallbacks.get(message.payload.typeId) ??
                this.onInboxWebSocketMessageCallbacks.get(
                    WsQueueBoxServerService.ALL_IN
                );

            await exclusiveCallback?.onMessage(message, entry, context);
        }
        else {
            exclusiveCallback = this.onInboxWebSocketMessageCallbacks.get(
                message.payload.typeId
            );
            await exclusiveCallback?.onMessage(message, entry, context);

            wildcard = this.onInboxWebSocketMessageCallbacks.get(
                WsQueueBoxServerService.ALL_IN
            );
            await wildcard?.onMessage(message, entry, context);
        }

        for (const callback of this.onAnyInboxWebSocketMessageCallbacks.values()) {
            await callback.onMessage(message, entry, context);
        }

        if (
            exclusiveCallback === undefined &&
            wildcard === undefined &&
            this.onAnyInboxWebSocketMessageCallbacks.size === 0
        ) {
            console.warn('No callback for typeId ', message.payload.typeId);
        }
    }

    sendToTargets(message: ALMessage): number {
        return this.liveDelivery.sendToTargets(message);
    }

    sendToTargetsWithResult(
        message: ALMessage,
        recipientSessionIds?: readonly string[],
        admittedPeerIds?: readonly string[]
    ): WsServerLiveSendResult {
        return this.liveDelivery.sendToTargetsWithResult(message, recipientSessionIds, admittedPeerIds);
    }

    private async sendPreparedMessage(
        prepared: WsQueueBoxServerPreparedMessage
    ): Promise<Readonly<{ status: 'sent' | 'no-targets'; }>> {
        if (prepared.kind === 'cluster-local-complete') {
            return { status: 'sent' };
        }
        try {
            const encoded = this.socket.encode(prepared.message);
            this.socket.sendEncoded(prepared.connectionId, encoded);
            this.deliveryReporting.recordOutcome({
                status: 'sent',
                messageId: prepared.message.id.msgId
            });
            this.deliveryReporting.recordDiagnostics({
                kind: 'outbox-send',
                topicId: prepared.message.route.topicId,
                payloadBytes: encoded.text.length
            });
            return { status: 'sent' };
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            this.deliveryReporting.recordOutcome({
                status: 'retryable-transport-failure',
                messageId: prepared.message.id.msgId,
                reason: runtimeError.message
            });
            throw runtimeError;
        }
    }

    private async forwardIncomingMessage(
        message: ALMessage,
        fromPeerId: string,
        plan: ALMessageHandlingPlan
    ): Promise<void | 'completed' | 'retry'> {
        const authority = await this.readCurrentDispatchAuthority(message);
        if (authority !== 'authorized') {
            return authority;
        }
        const nextHopPeerIds = plan.forwarding.nextHopPeerIds
            .filter((peerId) => peerId !== fromPeerId);

        if (nextHopPeerIds.length === 0) {
            return Promise.resolve();
        }

        console.log(
            `Forwarding WS server message ${message.id.msgId} (${message.payload.typeId}) from ${fromPeerId} to ${
                nextHopPeerIds.join(', ')
            }`
        );

        let sent = 0;
        const encoded = this.liveDelivery.tryEncodeDirectMessage(message);
        if (!encoded) {
            return Promise.resolve();
        }
        for (const peerId of nextHopPeerIds) {
            sent += this.liveDelivery.sendToResolvedPeer(peerId, message, encoded);
        }

        if (sent === 0) {
            console.warn(
                `No resolved WS server recipients for forwarded message ${message.id.msgId} to ${
                    nextHopPeerIds.join(', ')
                }`
            );
        }

        return Promise.resolve();
    }

    private async readCurrentDispatchAuthority(message: ALMessage): Promise<'authorized' | 'completed' | 'retry'> {
        if (this.disposed) {
            return 'retry';
        }
        if (isRoomScopedALMessage(message) && !this.inboundAuthorizer) {
            return 'completed';
        }
        const validation = this.validateInboundMessage(message);
        if (validation.left) {
            return 'completed';
        }
        const authorization = await this.inboundAuthorizer?.authorize(message) ?? { authorized: true };
        if (this.disposed) {
            return 'retry';
        }
        return authorization.authorized
            ? 'authorized'
            : authorization.reason === 'not-yet-in-sync'
            ? 'retry'
            : 'completed';
    }
}

export function createDefaultWsQueueBoxServerService(input: WsQueueBoxServerService.Input): WsQueueBoxServerService {
    return new WsQueueBoxServerService({
        inbox: input.inbox,
        outbox: input.outbox,
        socket: input.socket,
        name: input.name,
        qosProvider: input.qosProvider,
        targetResolver: input.targetResolver ?? {},
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            selfPeerId: input.name,
            toInboxEntry: (message) =>
                QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxServerService.INBOX_ENQUEUE_TYPE)
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            stores: input.outboundStores,
            queueEngine: input.queueEngine
        }),
        outboundDiagnostics: input.outboundDiagnostics,
        outboundDeliveryOutcome: input.outboundDeliveryOutcome,
        deliveryDiagnostics: input.deliveryDiagnostics,
        validateInboundMessage: input.validateInboundMessage ?? Either.ofRight,
        forwardsRoomScopedMessages: input.forwardsRoomScopedMessages ?? true
    });
}
