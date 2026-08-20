import type { QueueBoxResourceEntryRepository } from '../queuebox/QueueBoxTypes.ts';
import {
    ConnectionContext,
    type EncodedJsonWebSocketMessage,
    JsonWebSocketServer,
} from '../websocket/JsonWebSocketServer.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { OnWebSocketServerMessageCallback } from './InboxOutboxContracts.ts';
import { ALMessage, isRoomScopedALMessage } from '../al-contracts/al-contract.ts';
import {
    validatePersistedALMessage,
} from '../al-contracts/al-message-persistence-validation.ts';
import {
    ALMessageHandlingPlan,
    ALQosInputProvider,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
} from '../al-contracts/al-policy.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';
import { EnqueuedType } from '../api/api-config.ts';
import type { ALInboundRuntimeStores } from '../alm/ALInboundMessageRuntime.ts';
import { ALInboundMessageRuntime } from '../alm/ALInboundMessageRuntime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
} from '../alm/ALOutboundMessageRuntime.ts';
import {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundSupersedenceTrackingPlan,
} from '../alm/ALOutboundMessageRuntime.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    type WsDeliveryDiagnosticsEvent,
    type WsDeliveryDiagnosticsSink,
    type WsOutboxDeliveryOutcome,
    type WsServerLiveSendFailure,
    type WsServerLiveSendResult,
    type WsServerLiveSendStatus,
    type WsServerResolvedRecipient,
    type WsServerTargetResolver,
} from './ws-queue-box-server-contracts.ts';

export type WsQueueBoxServerServiceOptions = Readonly<{
    qosProvider?: ALQosInputProvider;
    targetResolver?: WsServerTargetResolver;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
    deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
    /**
     * Whether inbound ALM forwarding relays room-scoped messages (default
     * true, the standalone service contract). A composition that installs a
     * topic router with a room authorizer must pass false: the router owns
     * room-scoped fanout behind its authorization, and relaying here would
     * deliver messages the authorizer rejects (and double-deliver the ones
     * it accepts).
     */
    forwardsRoomScopedMessages?: boolean;
}>;

type WsServerPreparedMessage = Readonly<
    | { kind: 'recipient'; peerId: string; connectionId: string; message: ALMessage }
    | { kind: 'cluster-local-complete'; message: ALMessage }
>;

export class WsQueueBoxServerService {
    private static readonly ALL_IN: string = '*';

    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.WS_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE,
    ]);

    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.WS_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE,
    ]);

    private readonly onInboxWebSocketMessageCallbacks =
        new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    private readonly onAnyInboxWebSocketMessageCallbacks =
        new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    private readonly onOutboxWebSocketMessageCallbacks =
        new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();
    private outboxClusterPublisher?: (
        message: ALMessage,
        entry: ResourceEntry,
    ) => Promise<void>;
    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<WsServerPreparedMessage>;
    private readonly qosProvider?: ALQosInputProvider;
    private readonly targetResolver: WsServerTargetResolver;
    private readonly outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
    private readonly deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
    private readonly forwardsRoomScopedMessages: boolean;
    public readonly inbox: QueueBoxResourceEntryRepository;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketServer;
    public readonly name: string;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        outbox: QueueBoxResourceEntryRepository,
        socket: JsonWebSocketServer,
        name: string,
        options: WsQueueBoxServerServiceOptions = {},
    ) {
        this.inbox = inbox;
        this.outbox = outbox;
        this.socket = socket;
        this.name = name;
        this.qosProvider = options.qosProvider;
        this.targetResolver = options.targetResolver ?? {};
        this.outboundDeliveryOutcome = options.outboundDeliveryOutcome;
        this.deliveryDiagnostics = options.deliveryDiagnostics;
        this.forwardsRoomScopedMessages = options.forwardsRoomScopedMessages ?? true;

        this.outboundRuntime = new ALOutboundMessageRuntime<
            WsServerPreparedMessage
        >(
            {
                stores: options.outboundStores,
                diagnostics: options.outboundDiagnostics,
                outbox: this.outbox,
                toOutboxEntry: (message: ALMessage) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        message,
                        WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                    ),
                readMessageFromEntry: (entry) =>
                    JSON.parse(entry.resource) as ALMessage,
                planOutgoingMessage: (message) =>
                    this.planOutgoingMessage(message, 'immediate'),
                planDequeuedMessage: (message) =>
                    this.planOutgoingMessage(message, 'dequeue'),
                beforeDequeueDispatch: (message, entry) => {
                    const publisher = this.outboxClusterPublisher;
                    if (!publisher) return false;
                    return publisher(message, entry).then(() => message.targets !== undefined);
                },
                sendPreparedMessage: async (prepared, _phase) =>
                    await this.sendPreparedMessage(prepared),
                planRepairMessage: async (message, request) =>
                    await this.planRepairMessage(message, request),
            },
        );

        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                stores: options.inboundStores,
                selfPeerId: this.name,
                inbox: this.inbox,
                planIncomingMessage: (msg, fromPeerId, runtime) => {
                    const recipientPeerIds = this.resolveInboundRecipients(msg)
                        .map((recipient) => recipient.peerId);
                    return planALMessageHandling(
                        msg,
                        {
                            selfPeerId: this.name,
                            fromPeerId,
                            connectedPeerIds: recipientPeerIds,
                            groupMemberPeerIds: recipientPeerIds,
                            overlayNeighborPeerIds: recipientPeerIds,
                            dedupStore: runtime.dedupStore,
                            orderingStore: runtime.orderingStore,
                            supersedenceStore: runtime.supersedenceStore,
                        },
                        resolveALQosNormalizationInput(
                            msg,
                            {
                                selfPeerId: this.name,
                                fromPeerId,
                                direction: 'inbound',
                            },
                            this.qosProvider,
                        ),
                    );
                },
                readStoredEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
                toInboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
                    ),
                dispatchInboxEntry: async (entry, plan) => {
                    await this.dispatchInboxEntry(entry, plan);
                },
                sendControlMessage: (msg) => {
                    const toPeerId = msg.targets?.mode === 'unicast'
                        ? msg.targets.toPeerId
                        : undefined;

                    if (!toPeerId) {
                        console.warn(
                            `Cannot send WS server control message without unicast target: ${msg.payload.typeId}`,
                        );
                        return Promise.resolve();
                    }

                    const sent = this.sendToResolvedPeer(toPeerId, msg);
                    if (sent === 0) {
                        console.warn(
                            `Cannot resolve WS server control target ${toPeerId} for ${msg.payload.typeId}`,
                        );
                    }
                    return Promise.resolve();
                },
                onControlMessage: async (msg) => {
                    await this.outboundRuntime.acceptControlMessage(msg);
                },
                forwardMessage: async (msg, fromPeerId, plan) => {
                    await this.forwardIncomingMessage(msg, fromPeerId, plan);
                },
                canForwardMessage: (msg) =>
                    this.forwardsRoomScopedMessages || !isRoomScopedALMessage(msg),
            },
        );

        this.socket.onMessageDo(
            name,
            {
                onMessage: async (ctx: ConnectionContext, data: unknown, _) => {
                    const message = data as ALMessage;
                    await this.handleIncomingServerMessage(message, ctx.id);
                },
            },
        );
    }

    onAllOutboxMessagesDo(
        callback: OnWebSocketServerMessageCallback<ALMessage>,
        forceUpdate: boolean = false,
    ): WsQueueBoxServerService {
        if (
            !forceUpdate &&
            this.onOutboxWebSocketMessageCallbacks.has(WsQueueBoxServerService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws outbox callbacks for ALL_IN');
        }

        this.onOutboxWebSocketMessageCallbacks.set(
            WsQueueBoxServerService.ALL_IN,
            callback,
        );
        return this;
    }

    onOutboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>,
    ): WsQueueBoxServerService {
        this.onOutboxWebSocketMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxWebSocketMessageCallbacks.delete(id);
    }

    onOutboxClusterPublishDo(
        publisher: (message: ALMessage, entry: ResourceEntry) => Promise<void>,
    ): WsQueueBoxServerService {
        this.outboxClusterPublisher = publisher;
        return this;
    }

    onAllInboxMessagesDo(
        callback: OnWebSocketServerMessageCallback<ALMessage>,
        forceUpdate: boolean = false,
    ): WsQueueBoxServerService {
        if (
            !forceUpdate &&
            this.onInboxWebSocketMessageCallbacks.has(WsQueueBoxServerService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws inbox callbacks for ALL_IN');
        }

        this.onInboxWebSocketMessageCallbacks.set(
            WsQueueBoxServerService.ALL_IN,
            callback,
        );
        return this;
    }

    onAnyInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>,
    ): WsQueueBoxServerService {
        this.onAnyInboxWebSocketMessageCallbacks.set(id, callback);
        return this;
    }

    onInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>,
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
        const dispatchPlan = this.planOutgoingMessage(message, 'immediate');
        if (dispatchPlan.persist) {
            validatePersistedALMessage(message);
        }

        const result = await this.outboundRuntime.enqueueIfAbsent(
            message,
            dispatchPlan,
        );
        if (
            result.status === 'no-route' &&
            result.reason &&
            WsQueueBoxServerService.isBroadcastWithoutRecipients(
                message,
                result.reason,
            )
        ) {
            return {
                ...result,
                entries: [],
                entry: undefined,
            };
        }

        return result;
    }

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry),
            ),
        );
    }

    private async handleIncomingServerMessage(
        message: ALMessage,
        connectionId: string,
    ): Promise<void> {
        const fromPeerId = this.targetResolver.resolvePeerIdForConnection?.(connectionId, message) ??
            connectionId;
        if (message.id.senderId !== fromPeerId) {
            return;
        }
        await this.inboundRuntime.handleIncomingMessage(message, fromPeerId);
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan,
    ): Promise<void> {
        const message = JSON.parse(entry.resource) as ALMessage;

        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback =
                this.onInboxWebSocketMessageCallbacks.get(message.payload.typeId) ??
                this.onInboxWebSocketMessageCallbacks.get(
                    WsQueueBoxServerService.ALL_IN,
                );

            await this.onMessageIfPresent(exclusiveCallback, message, entry);
        } else {
            exclusiveCallback = this.onInboxWebSocketMessageCallbacks.get(
                message.payload.typeId,
            );
            await this.onMessageIfPresent(exclusiveCallback, message, entry);

            wildcard = this.onInboxWebSocketMessageCallbacks.get(
                WsQueueBoxServerService.ALL_IN,
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
        return this.sendToTargetsWithResult(message).sentCount;
    }

    sendToTargetsWithResult(message: ALMessage): WsServerLiveSendResult {
        const recipients = this.resolveRecipients(message);
        if (recipients.length === 0) {
            this.recordDeliveryDiagnostics({
                kind: 'no-local-recipient',
                topicId: message.route.topicId,
            });
            return {
                status: 'no-recipients',
                message,
                recipients,
                recipientCount: 0,
                sentCount: 0,
                failedCount: 0,
                failures: [],
            };
        }

        let encoded: EncodedJsonWebSocketMessage;
        try {
            encoded = this.socket.encode(message);
        } catch (error) {
            const reason = errorToReason(error);
            console.error(
                `Error encoding WS server message ${message.id.msgId}`,
                error,
            );
            return {
                status: 'failed',
                message,
                recipients,
                recipientCount: recipients.length,
                sentCount: 0,
                failedCount: recipients.length,
                failures: recipients.map((recipient) => ({
                    peerId: recipient.peerId,
                    connectionId: recipient.connectionId,
                    reason,
                })),
            };
        }
        let sent = 0;
        const failures: WsServerLiveSendFailure[] = [];
        for (const recipient of recipients) {
            try {
                this.socket.sendEncoded(recipient.connectionId, encoded);
                sent += 1;
            } catch (error) {
                failures.push({
                    peerId: recipient.peerId,
                    connectionId: recipient.connectionId,
                    reason: errorToReason(error),
                });
                console.error(
                    `Error sending WS server message to ${recipient.connectionId}`,
                    error,
                );
            }
        }

        this.recordDeliveryDiagnostics({
            kind: 'live-send',
            topicId: message.route.topicId,
            recipientCount: recipients.length,
            sentCount: sent,
            payloadBytes: encoded.text.length,
        });
        return {
            status: toWsServerLiveSendStatus(
                recipients.length,
                sent,
                failures.length,
            ),
            message,
            recipients,
            recipientCount: recipients.length,
            sentCount: sent,
            failedCount: failures.length,
            failures,
        };
    }

    private planOutgoingMessage(
        message: ALMessage,
        phase: 'immediate' | 'dequeue',
    ) {
        const normalized = this.normalizeOutgoingPolicy(message);
        const effective = normalized.effective;
        const persist = shouldPersistOutbox(effective);

        return this.validateMessage(message, {
            resolveRecipients: phase === 'dequeue' || !persist,
            representNoCurrentRecipient: phase === 'dequeue',
        })
            .fold(
                (error: string) => {
                    return WsQueueBoxServerService.toNoRouteDispatchPlan(
                        `Invalid WS server outbound message ${message.id.msgId}: ${error}`,
                    );
                },
                (recipients: readonly WsServerResolvedRecipient[]) => ({
                    persist,
                    preparedMessages: phase === 'dequeue' && this.outboxClusterPublisher
                        ? [{ kind: 'cluster-local-complete' as const, message }]
                        : recipients.map((recipient) => ({
                            kind: 'recipient' as const,
                            peerId: recipient.peerId,
                            connectionId: recipient.connectionId,
                            message,
                        })),
                    ackTracking: this.toAckTrackingPlan(effective, recipients),
                    repairTracking: this.toRepairTrackingPlan(effective),
                    supersedenceTracking: this.toSupersedenceTrackingPlan(
                        effective,
                        message,
                    ),
                }),
            );
    }

    private validateMessage(
        message: ALMessage,
        options: Readonly<{
            resolveRecipients: boolean;
            representNoCurrentRecipient: boolean;
        }>,
    ): Either<string, readonly WsServerResolvedRecipient[]> {
        const targets = message.targets;
        if (!targets) {
            return Either.ofLeft(
                `Cannot route WS server outbound message ${message.id.msgId} without explicit targets`,
            );
        }

        if (!options.resolveRecipients) {
            return Either.ofRight([]);
        }

        const recipients = this.resolveRecipients(message);
        if (recipients.length === 0) {
            if (options.representNoCurrentRecipient) {
                this.recordOutboundDeliveryOutcome({
                    status: 'no-current-recipient',
                    messageId: message.id.msgId,
                });
                this.recordDeliveryDiagnostics({
                    kind: 'no-local-recipient',
                    topicId: message.route.topicId,
                });
            }
            return Either.ofLeft(
                WsQueueBoxServerService.toNoResolvedRecipientsReason(
                    targets.mode,
                    message.id.msgId,
                ),
            );
        }

        return Either.ofRight(recipients);
    }

    private static isBroadcastWithoutRecipients(
        message: ALMessage,
        error: string,
    ): boolean {
        const noRecipientsReason = WsQueueBoxServerService.toNoResolvedRecipientsReason(
            'broadcast',
            message.id.msgId,
        );
        const invalidMessageReason =
            `Invalid WS server outbound message ${message.id.msgId}: ${noRecipientsReason}`;

        return message.targets?.mode === 'broadcast' &&
            (
                error === noRecipientsReason ||
                error === invalidMessageReason
            );
    }

    private static toNoResolvedRecipientsReason(
        mode: NonNullable<ALMessage['targets']>['mode'],
        msgId: string,
    ): string {
        return `Cannot resolve WS server recipients for ${mode} message ${msgId}`;
    }

    static toNoRouteDispatchPlan(
        dropReason: string,
    ): ALOutboundDispatchPlan<WsServerPreparedMessage> {
        return {
            dropReason,
            persist: false,
            preparedMessages: [],
        };
    }

    private normalizeOutgoingPolicy(message: ALMessage) {
        return normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(
                message,
                {
                    direction: 'outbound',
                    selfPeerId: this.name,
                },
                this.qosProvider,
            ),
        );
    }

    private planRepairMessage(
        message: ALMessage,
        request: ALOutboundRepairRequest,
    ): Promise<ALOutboundDispatchPlan<WsServerPreparedMessage> | undefined> {
        const normalized = this.normalizeOutgoingPolicy(message);
        const recipients = request.requestedByPeerId
            ? this.resolveRepairRecipients(message, [request.requestedByPeerId])
            : this.resolveRepairRecipients(message, request.failedPeerIds);

        if (recipients.length === 0) {
            return Promise.resolve(undefined);
        }

        return Promise.resolve({
            persist: false,
            preparedMessages: recipients.map((recipient) => ({
                kind: 'recipient' as const,
                peerId: recipient.peerId,
                connectionId: recipient.connectionId,
                message,
            })),
            ackTracking: this.toAckTrackingPlan(
                normalized.effective,
                recipients,
                'replace',
            ),
            repairTracking: request.repair,
        });
    }

    private async sendPreparedMessage(
        prepared: WsServerPreparedMessage,
    ): Promise<Readonly<{ status: 'sent' | 'no-targets' }>> {
        if (prepared.kind === 'cluster-local-complete') return { status: 'sent' };
        try {
            const encoded = this.socket.encode(prepared.message);
            this.socket.sendEncoded(prepared.connectionId, encoded);
            this.recordOutboundDeliveryOutcome({
                status: 'sent',
                messageId: prepared.message.id.msgId,
            });
            this.recordDeliveryDiagnostics({
                kind: 'outbox-send',
                topicId: prepared.message.route.topicId,
                payloadBytes: encoded.text.length,
            });
            return { status: 'sent' };
        } catch (error) {
            this.recordOutboundDeliveryOutcome({
                status: 'retryable-transport-failure',
                messageId: prepared.message.id.msgId,
                reason: errorToReason(error),
            });
            throw error;
        }
    }

    private recordOutboundDeliveryOutcome(
        outcome: WsOutboxDeliveryOutcome,
    ): void {
        try {
            this.outboundDeliveryOutcome?.(outcome);
        } catch (error) {
            console.error('WS outbox delivery outcome sink failed', error);
        }
    }

    private recordDeliveryDiagnostics(event: WsDeliveryDiagnosticsEvent): void {
        try {
            this.deliveryDiagnostics?.(event);
        } catch {
            // Delivery diagnostics must never affect WS send behavior.
        }
    }

    private forwardIncomingMessage(
        message: ALMessage,
        fromPeerId: string,
        plan: ALMessageHandlingPlan,
    ): Promise<void> {
        const nextHopPeerIds = plan.forwarding.nextHopPeerIds
            .filter((peerId) => peerId !== fromPeerId);

        if (nextHopPeerIds.length === 0) {
            return Promise.resolve();
        }

        console.log(
            `Forwarding WS server message ${message.id.msgId} (${message.payload.typeId}) from ${fromPeerId} to ${nextHopPeerIds.join(', ')}`,
        );

        let sent = 0;
        const encoded = this.tryEncodeDirectMessage(message);
        if (!encoded) {
            return Promise.resolve();
        }
        for (const peerId of nextHopPeerIds) {
            sent += this.sendToResolvedPeer(peerId, message, encoded);
        }

        if (sent === 0) {
            console.warn(
                `No resolved WS server recipients for forwarded message ${message.id.msgId} to ${nextHopPeerIds.join(', ')}`,
            );
        }

        return Promise.resolve();
    }

    private async onMessageIfPresent(
        callback: OnWebSocketServerMessageCallback<ALMessage> | undefined,
        message: ALMessage,
        entry: ResourceEntry,
    ) {
        try {
            await callback?.onMessage(message, entry, this.socket);
        } catch (e) {
            console.error('Error calling onMessage callback', e);
        }
    }

    private resolveRecipients(
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] {
        const targets = message.targets;
        if (!targets) {
            return [];
        }

        switch (targets.mode) {
            case 'unicast': {
                if (this.targetResolver.resolvePeerRecipients) {
                    return dedupRecipients(this.targetResolver.resolvePeerRecipients(
                        targets.toPeerId,
                        message,
                    ));
                }

                return [{
                    peerId: targets.toPeerId,
                    connectionId: targets.toPeerId,
                }];
            }
            case 'multicast': {
                const resolved = this.targetResolver.resolveGroupRecipients?.(
                    targets.groupRef.groupId,
                    message,
                ) ?? [];
                return dedupRecipients(resolved);
            }
            case 'broadcast': {
                const resolved = this.targetResolver.resolveBroadcastRecipients?.(
                        targets.scope,
                        message,
                    ) ??
                    this.toDefaultBroadcastRecipients(targets.exceptPeerIds);
                return dedupRecipients(
                    resolved.filter((recipient) =>
                        !targets.exceptPeerIds?.includes(recipient.peerId)
                    ),
                );
            }
        }
    }

    private resolveInboundRecipients(
        message: ALMessage,
    ): readonly WsServerResolvedRecipient[] {
        const targets = message.targets;
        if (!targets) {
            return [];
        }

        switch (targets.mode) {
            case 'unicast':
                return dedupRecipients(
                    this.targetResolver.resolvePeerRecipients?.(
                        targets.toPeerId,
                        message,
                    ) ?? [],
                );
            case 'multicast':
                return dedupRecipients(
                    this.targetResolver.resolveGroupRecipients?.(
                        targets.groupRef.groupId,
                        message,
                    ) ?? [],
                );
            case 'broadcast':
                return dedupRecipients(
                    this.targetResolver.resolveBroadcastRecipients?.(
                        targets.scope,
                        message,
                    ).filter((recipient) =>
                        !targets.exceptPeerIds?.includes(recipient.peerId)
                    ) ?? [],
                );
        }
    }

    private resolveRepairRecipients(
        message: ALMessage,
        peerIds: readonly string[],
    ): readonly WsServerResolvedRecipient[] {
        if (peerIds.length === 0) {
            return [];
        }

        const recipients = peerIds.flatMap((peerId) => {
            if (this.targetResolver.resolvePeerRecipients) {
                return this.targetResolver.resolvePeerRecipients(peerId, message);
            }
            return [{
                peerId,
                connectionId: peerId,
            }];
        });

        return dedupRecipients(recipients);
    }

    private toDefaultBroadcastRecipients(
        exceptPeerIds?: readonly string[],
    ): readonly WsServerResolvedRecipient[] {
        if (!(this.socket.connections instanceof Map)) {
            return [];
        }

        return [...this.socket.connections.values()]
            .filter((ctx) => ctx.isOpen && !exceptPeerIds?.includes(ctx.id))
            .map((ctx) => ({
                peerId: ctx.id,
                connectionId: ctx.id,
            }));
    }

    private sendToResolvedPeer(
        peerId: string,
        message: ALMessage,
        encoded?: EncodedJsonWebSocketMessage,
    ): number {
        const deduped = this.targetResolver.resolvePeerRecipients
            ? dedupRecipients(this.targetResolver.resolvePeerRecipients(peerId, message))
            : [{
                peerId,
                connectionId: peerId,
            }];

        const encodedMessage = encoded ?? this.tryEncodeDirectMessage(message);
        if (!encodedMessage) {
            return 0;
        }

        let sent = 0;
        for (const recipient of deduped) {
            try {
                this.socket.sendEncoded(recipient.connectionId, encodedMessage);
                sent += 1;
            } catch (error) {
                console.error(
                    `Error sending WS server message to ${recipient.connectionId}`,
                    error,
                );
            }
        }

        return sent;
    }

    private tryEncodeDirectMessage(
        message: ALMessage,
    ): EncodedJsonWebSocketMessage | undefined {
        try {
            return this.socket.encode(message);
        } catch (error) {
            console.error(
                `Error encoding WS server message ${message.id.msgId}`,
                error,
            );
            return undefined;
        }
    }

    private toAckTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        recipients: readonly WsServerResolvedRecipient[],
        mode?: 'merge' | 'replace',
    ): ALOutboundAckTrackingPlan | undefined {
        if (effective.ack.algo === 'none' || recipients.length === 0) {
            return undefined;
        }

        return {
            enabled: true,
            timeoutMs: effective.ack.opts.timeoutMs,
            maxAttempts: effective.retry.algo === 'none'
                ? 0
                : effective.retry.opts.maxAttempts,
            expectedPeerIds: [
                ...new Set(recipients.map((recipient) => recipient.peerId)),
            ],
            mode,
        };
    }

    private toRepairTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
    ): ALOutboundRepairTrackingPlan | undefined {
        if (effective.repair.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.repair.algo,
            maxAttempts: effective.repair.opts.maxRepairs,
        };
    }

    private toSupersedenceTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        message: ALMessage,
    ): ALOutboundSupersedenceTrackingPlan | undefined {
        if (effective.supersedence.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(message, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId,
        };
    }
}

function dedupRecipients(
    recipients: readonly WsServerResolvedRecipient[],
): readonly WsServerResolvedRecipient[] {
    const byConnectionId = new Map<string, WsServerResolvedRecipient>();

    for (const recipient of recipients) {
        byConnectionId.set(recipient.connectionId, recipient);
    }

    return [...byConnectionId.values()];
}

function toWsServerLiveSendStatus(
    recipientCount: number,
    sentCount: number,
    failedCount: number,
): WsServerLiveSendStatus {
    if (recipientCount === 0) {
        return 'no-recipients';
    }

    if (failedCount === 0) {
        return 'sent-live';
    }

    return sentCount > 0 ? 'partial-failure' : 'failed';
}

function errorToReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type {
    WsDeliveryDiagnosticsEvent,
    WsDeliveryDiagnosticsSink,
    WsOutboxDeliveryOutcome,
    WsServerLiveSendFailure,
    WsServerLiveSendResult,
    WsServerLiveSendStatus,
    WsServerResolvedRecipient,
    WsServerTargetResolver,
} from './ws-queue-box-server-contracts.ts';
