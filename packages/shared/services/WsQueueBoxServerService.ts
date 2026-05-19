import type { QueueBoxResourceEntryRepository } from '../queuebox/QueueBoxTypes.ts';
import { ConnectionContext, JsonWebSocketServer, } from '../websocket/JsonWebSocketServer.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { OnWebSocketServerMessageCallback } from './InboxOutboxContracts.ts';
import { ALMessage } from '../al-contracts/al-contract.ts';
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

export type WsServerResolvedRecipient = Readonly<{
    peerId: string;
    connectionId: string;
}>;

export type WsServerLiveSendStatus =
    | 'sent-live'
    | 'no-recipients'
    | 'partial-failure'
    | 'failed';

export type WsServerLiveSendFailure = Readonly<{
    peerId: string;
    connectionId: string;
    reason: string;
}>;

export type WsServerLiveSendResult = Readonly<{
    status: WsServerLiveSendStatus;
    message: ALMessage;
    recipients: readonly WsServerResolvedRecipient[];
    recipientCount: number;
    sentCount: number;
    failedCount: number;
    failures: readonly WsServerLiveSendFailure[];
}>;

export type WsServerTargetResolver = Readonly<{
    resolvePeerRecipients?: (
        peerId: string,
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolveGroupRecipients?: (
        groupId: string,
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolveBroadcastRecipients?: (
        scope: 'room' | 'world' | 'all',
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolvePeerIdForConnection?: (
        connectionId: string,
        message: ALMessage,
    ) => string | undefined;
}>;

export type WsQueueBoxServerServiceOptions = Readonly<{
    qosProvider?: ALQosInputProvider;
    targetResolver?: WsServerTargetResolver;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
}>;

type WsServerPreparedMessage = Readonly<{
    peerId: string;
    connectionId: string;
    message: ALMessage;
}>;

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

    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<WsServerPreparedMessage>;
    private readonly qosProvider?: ALQosInputProvider;
    private readonly targetResolver: WsServerTargetResolver;

    constructor(
        public readonly inbox: QueueBoxResourceEntryRepository,
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly socket: JsonWebSocketServer,
        public readonly name: string,
        options: WsQueueBoxServerServiceOptions = {},
    ) {
        this.qosProvider = options.qosProvider;
        this.targetResolver = options.targetResolver ?? {};

        this.outboundRuntime = new ALOutboundMessageRuntime<
            WsServerPreparedMessage
        >(
            {
                stores: options.outboundStores,
                outbox: this.outbox,
                toOutboxEntry: (message: ALMessage) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        message,
                        WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                    ),
                readMessageFromEntry: (entry) =>
                    JSON.parse(entry.resource) as ALMessage,
                planOutgoingMessage: (message) => this.planOutgoingMessage(message),
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
                planIncomingMessage: (msg, fromPeerId, runtime) =>
                    planALMessageHandling(
                        msg,
                        {
                            selfPeerId: this.name,
                            fromPeerId,
                            dedupStore: runtime.dedupStore,
                            orderingStore: runtime.orderingStore,
                            supersedenceStore: runtime.supersedenceStore,
                        },
                        resolveALQosNormalizationInput(
                            msg,
                            {
                                direction: 'inbound',
                                selfPeerId: this.name,
                                fromPeerId,
                            },
                            this.qosProvider,
                        ),
                    ),
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
        if (
            message.targets?.mode === 'broadcast' &&
            this.resolveRecipients(message).length === 0
        ) {
            return {
                status: 'no-route',
                message,
                entries: [],
                reason: WsQueueBoxServerService.toNoResolvedRecipientsReason(
                    'broadcast',
                    message.id.msgId,
                ),
            };
        }

        const result = await this.outboundRuntime.enqueueIfAbsent(message);
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
        const fromPeerId =
            this.targetResolver.resolvePeerIdForConnection?.(connectionId, message) ??
            message.id.senderId ??
            connectionId;

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

        let sent = 0;
        const failures: WsServerLiveSendFailure[] = [];
        for (const recipient of recipients) {
            try {
                this.socket.send(recipient.connectionId, message);
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
    ) {
        const normalized = this.normalizeOutgoingPolicy(message);
        const effective = normalized.effective;
        const persist = shouldPersistOutbox(effective);

        return this.validateMessage(message)
            .fold(
                (error: string) => {
                    return WsQueueBoxServerService.toNoRouteDispatchPlan(
                        `Invalid WS server outbound message ${message.id.msgId}: ${error}`,
                    );
                },
                (recipients: readonly WsServerResolvedRecipient[]) => ({
                    persist,
                    preparedMessages: recipients.map((recipient) => ({
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
    ): Either<string, readonly WsServerResolvedRecipient[]> {
        const targets = message.targets;
        if (!targets) {
            return Either.ofLeft(
                `Cannot route WS server outbound message ${message.id.msgId} without explicit targets`,
            );
        }

        const recipients: readonly WsServerResolvedRecipient[] = this
            .resolveRecipients(message);
        if (recipients.length === 0) {
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

    private sendPreparedMessage(
        prepared: WsServerPreparedMessage,
    ): Promise<void> {
        this.socket.send(prepared.connectionId, prepared.message);
        return Promise.resolve();
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
        for (const peerId of nextHopPeerIds) {
            sent += this.sendToResolvedPeer(peerId, message);
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
                const resolved = this.targetResolver.resolvePeerRecipients?.(
                    targets.toPeerId,
                    message,
                );
                if (resolved && resolved.length > 0) {
                    return dedupRecipients(resolved);
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

    private resolveRepairRecipients(
        message: ALMessage,
        peerIds: readonly string[],
    ): readonly WsServerResolvedRecipient[] {
        if (peerIds.length === 0) {
            return [];
        }

        const recipients = peerIds.flatMap((peerId) =>
            this.targetResolver.resolvePeerRecipients?.(peerId, message) ??
            [{
                peerId,
                connectionId: peerId,
            }]
        );

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
    ): number {
        const recipients =
            this.targetResolver.resolvePeerRecipients?.(peerId, message) ??
            [];
        const deduped = recipients.length > 0 ? dedupRecipients(recipients) : [{
            peerId,
            connectionId: peerId,
        }];

        let sent = 0;
        for (const recipient of deduped) {
            try {
                this.socket.send(recipient.connectionId, message);
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
