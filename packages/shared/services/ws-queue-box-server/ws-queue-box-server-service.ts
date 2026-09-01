import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../../al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    resolveALQosNormalizationInput,
    type ALMessageHandlingPlan,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import type { ALInboundRuntimeStores } from '../../alm/ALInboundMessageRuntime.ts';
import { ALInboundMessageRuntime } from '../../alm/ALInboundMessageRuntime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores
} from '../../alm/ALOutboundMessageRuntime.ts';
import { ALOutboundMessageRuntime } from '../../alm/ALOutboundMessageRuntime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { ResilienceDto } from '../../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { JsonWebSocketServer, type ConnectionContext } from '../../websocket/JsonWebSocketServer.ts';
import type { OnWebSocketServerMessageCallback } from '../queue-message-callbacks.ts';
import { QueueBoxUtilities } from '../QueueBoxUtilities.ts';

import {
    type WsDeliveryDiagnosticsSink,
    type WsOutboxDeliveryOutcome,
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
    export interface Dependencies {
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
        readonly admitInboundMessage?: (message: ALMessage) => boolean;
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
    private readonly admitInboundMessage: (message: ALMessage) => boolean;
    private readonly forwardsRoomScopedMessages: boolean;
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
            targetResolver: dependencies.targetResolver ?? {}
        });
        this.deliveryReporting = new WsQueueBoxServerDeliveryReporting({
            outboundOutcome: dependencies.outboundDeliveryOutcome,
            diagnostics: dependencies.deliveryDiagnostics
        });
        this.admitInboundMessage = dependencies.admitInboundMessage ?? (() => true);
        this.forwardsRoomScopedMessages = dependencies.forwardsRoomScopedMessages ?? true;
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
            stores: dependencies.outboundStores,
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
                Promise.resolve(this.outboundPlanning.planRepairMessage(message, request))
        });
    }

    private createInboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime({
            stores: dependencies.inboundStores,
            selfPeerId: dependencies.name,
            inbox: this.inbox,
            planIncomingMessage: (message, fromPeerId, runtime) => {
                const recipientPeerIds = this.targetResolution.resolveInboundRecipients(message)
                    .map((recipient) => recipient.peerId);
                return planALMessageHandling(
                    message,
                    {
                        selfPeerId: this.name,
                        fromPeerId,
                        connectedPeerIds: recipientPeerIds,
                        groupMemberPeerIds: recipientPeerIds,
                        overlayNeighborPeerIds: recipientPeerIds,
                        dedupStore: runtime.dedupStore,
                        orderingStore: runtime.orderingStore,
                        supersedenceStore: runtime.supersedenceStore
                    },
                    resolveALQosNormalizationInput(
                        message,
                        { selfPeerId: this.name, fromPeerId, direction: 'inbound' },
                        this.qosProvider
                    )
                );
            },
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            toInboxEntry: (message) =>
                QueueBoxUtilities.toResourceEntryFromMsg(
                    message,
                    WsQueueBoxServerService.INBOX_ENQUEUE_TYPE
                ),
            dispatchInboxEntry: (entry, plan) => this.dispatchInboxEntry(entry, plan),
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
            onMessage: async (connection: ConnectionContext, data) => {
                const message = decodePersistedALMessageValue(data);
                await this.handleIncomingServerMessage(message, connection.id);
            }
        });
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

    private async handleIncomingServerMessage(
        message: ALMessage,
        connectionId: string
    ): Promise<void> {
        const fromPeerId = this.targetResolution.resolvePeerIdForConnection(connectionId, message);
        if (message.id.senderId !== fromPeerId) {
            return;
        }
        if (!this.admitInboundMessage(message)) {
            return;
        }
        await this.inboundRuntime.handleIncomingMessage(message, fromPeerId);
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan
    ): Promise<void> {
        const message = decodePersistedALMessage(entry.resource);

        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback = this.onInboxWebSocketMessageCallbacks.get(message.payload.typeId) ??
                this.onInboxWebSocketMessageCallbacks.get(
                    WsQueueBoxServerService.ALL_IN
                );

            await this.onMessageIfPresent(exclusiveCallback, message, entry);
        }
        else {
            exclusiveCallback = this.onInboxWebSocketMessageCallbacks.get(
                message.payload.typeId
            );
            await this.onMessageIfPresent(exclusiveCallback, message, entry);

            wildcard = this.onInboxWebSocketMessageCallbacks.get(
                WsQueueBoxServerService.ALL_IN
            );
            await this.onMessageIfPresent(wildcard, message, entry);
        }

        for (const callback of this.onAnyInboxWebSocketMessageCallbacks.values()) {
            await this.onMessageIfPresent(callback, message, entry);
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

    sendToTargetsWithResult(message: ALMessage, recipientSessionIds?: readonly string[]): WsServerLiveSendResult {
        return this.liveDelivery.sendToTargetsWithResult(message, recipientSessionIds);
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

    private forwardIncomingMessage(
        message: ALMessage,
        fromPeerId: string,
        plan: ALMessageHandlingPlan
    ): Promise<void> {
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

    private async onMessageIfPresent(
        callback: OnWebSocketServerMessageCallback<ALMessage> | undefined,
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<void> {
        try {
            await callback?.onMessage(message, entry, this.socket);
        }
        catch (e) {
            console.error('Error calling onMessage callback', e);
        }
    }
}
