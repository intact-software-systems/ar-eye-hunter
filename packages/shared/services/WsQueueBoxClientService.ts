import { ALMessage } from '../al-contracts/al-contract.ts';
import {
    ALQosInputProvider,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox
} from '../al-contracts/al-policy.ts';
import type { ALInboundRuntimeStores } from '../alm/ALInboundMessageRuntime.ts';
import { ALInboundMessageRuntime } from '../alm/ALInboundMessageRuntime.ts';
import type { ALOutboundRuntimeDiagnosticsSink, ALOutboundRuntimeStores } from '../alm/ALOutboundMessageRuntime.ts';
import {
    ALOutboundAckTrackingPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    ALOutboundRetryTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../alm/ALOutboundMessageRuntime.ts';
import { EnqueuedType } from '../api/api-config.ts';
import { Command } from '../cache/Command.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '../resilience/TryWith.ts';
import { JsonWebSocketClient } from '../websocket/JsonWebSocketClient.ts';
import { OnMessageCallback, OnOutboxWebSocketMessageCallback } from './InboxOutboxContracts.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';

export type WsQueueBoxClientServiceInputDto = {
    readonly sessionId: string;
};

export type WsQueueBoxClientServiceOptions = Readonly<{
    qosProvider?: ALQosInputProvider;
    inboundStores?: ALInboundRuntimeStores;
    outboundStores?: ALOutboundRuntimeStores;
    outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    newConnectionRequestId?: () => string;
    reconnect: WsQueueBoxClientReconnectOptions;
}>;

export type WsQueueBoxClientReconnectOptions = Readonly<{
    maxAttempts: number;
    connectTimeoutMsecs: number;
    retryIntervalMsecs: number;
    maxRetryIntervalMsecs: number;
    canReconnect: () => boolean;
}>;

export const DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS: WsQueueBoxClientReconnectOptions = {
    maxAttempts: 12,
    connectTimeoutMsecs: 10_000,
    retryIntervalMsecs: 500,
    maxRetryIntervalMsecs: 20_000,
    canReconnect: () => true
};

export type WsQueueBoxClientReadyState =
    | 'missing'
    | 'connecting'
    | 'open'
    | 'closing'
    | 'closed'
    | 'unknown';

export type WsQueueBoxClientHealth = Readonly<{
    sessionId: string;
    url: string;
    readyState: WsQueueBoxClientReadyState;
    readyStateCode?: number;
    isOpen: boolean;
    reconnecting: boolean;
    reconnectEnabled: boolean;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    reconnectExhausted: boolean;
}>;

type WsQueueBoxClientReconnectStatus = {
    task: Promise<unknown> | undefined;
    enabled: boolean;
    generation: number;
    attempts: number;
    exhausted: boolean;
};

export class WsQueueBoxClientService {
    private static readonly ALL_IN: string = '*';

    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.WS_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE
    ]);

    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.WS_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE
    ]);

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<
        string,
        OnOutboxWebSocketMessageCallback
    >();

    private readonly onInboxMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    private readonly onAnyInboxMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALMessage>;
    private closed = false;

    private readonly reconnectStatus: WsQueueBoxClientReconnectStatus = {
        task: undefined,
        enabled: false,
        generation: 0,
        attempts: 0,
        exhausted: false
    };

    public readonly inbox: QueueBoxResourceEntryRepository;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketClient;
    public readonly input: WsQueueBoxClientServiceInputDto;
    private readonly options: WsQueueBoxClientServiceOptions;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        outbox: QueueBoxResourceEntryRepository,
        socket: JsonWebSocketClient,
        input: WsQueueBoxClientServiceInputDto,
        options: WsQueueBoxClientServiceOptions = {
            reconnect: DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }
    ) {
        this.inbox = inbox;
        this.outbox = outbox;
        this.socket = socket;
        this.input = input;
        this.options = options;
        this.outboundRuntime = new ALOutboundMessageRuntime<ALMessage>(
            {
                stores: this.options.outboundStores,
                diagnostics: this.options.outboundDiagnostics,
                outbox: this.outbox,
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE
                    ),
                readMessageFromEntry: (entry) => JSON.parse(entry.resource) as ALMessage,
                planOutgoingMessage: (msg) => {
                    const normalized = normalizeALQosPolicy(
                        msg,
                        resolveALQosNormalizationInput(
                            msg,
                            {
                                direction: 'outbound',
                                selfPeerId: this.input.sessionId,
                                connectedPeerIds: this.isSocketOpen()
                                    ? [this.input.sessionId]
                                    : []
                            },
                            this.options.qosProvider
                        )
                    );
                    return {
                        persist: shouldPersistOutbox(normalized.effective) ||
                            !this.isSocketOpen(),
                        preparedMessages: [msg],
                        ackTracking: this.toAckTrackingPlan(normalized.effective, msg),
                        retryTracking: this.toRetryTrackingPlan(normalized.effective),
                        supersedenceTracking: this.toSupersedenceTrackingPlan(
                            normalized.effective,
                            msg
                        )
                    };
                },
                sendPreparedMessage: async (msg, _phase) => {
                    await this.dispatchOutboxEntry(
                        QueueBoxUtilities.toResourceEntryFromMsg(
                            msg,
                            WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE
                        )
                    );
                    return { status: 'sent' };
                }
            }
        );

        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                stores: this.options.inboundStores,
                selfPeerId: this.input.sessionId,
                inbox: this.inbox,
                planIncomingMessage: (msg, fromPeerId, runtime) =>
                    planALMessageHandling(
                        msg,
                        {
                            selfPeerId: this.input.sessionId,
                            fromPeerId,
                            connectedPeerIds: [this.input.sessionId],
                            dedupStore: runtime.dedupStore,
                            orderingStore: runtime.orderingStore,
                            supersedenceStore: runtime.supersedenceStore
                        },
                        resolveALQosNormalizationInput(
                            msg,
                            {
                                direction: 'inbound',
                                selfPeerId: this.input.sessionId,
                                fromPeerId,
                                connectedPeerIds: [this.input.sessionId]
                            },
                            this.options.qosProvider
                        )
                    ),
                readStoredEntry: (entry) => JSON.parse(entry.resource) as ALMessage,

                toInboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WsQueueBoxClientService.INBOX_ENQUEUE_TYPE
                    ),
                dispatchInboxEntry: async (entry, plan) => await this.dispatchInboxEntry(entry, plan),
                sendControlMessage: async (msg) => {
                    await this.enqueueOutboxIfAbsent(msg);
                },
                onControlMessage: async (msg) => {
                    await this.outboundRuntime.acceptControlMessage(msg);
                }
            }
        );
    }

    onAllOutboxMessagesDo(
        callback: OnOutboxWebSocketMessageCallback,
        forceUpdate: boolean = false
    ): WsQueueBoxClientService {
        if (
            !forceUpdate &&
            this.onOutboxMessageCallbacks.has(WsQueueBoxClientService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws outbox callbacks for ALL_IN');
        }

        this.onOutboxMessageCallbacks.set(WsQueueBoxClientService.ALL_IN, callback);
        return this;
    }

    onOutboxMessageDo(
        id: string,
        callback: OnOutboxWebSocketMessageCallback
    ): WsQueueBoxClientService {
        this.onOutboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeOutboxMessageCallback(id: string): boolean {
        return this.onOutboxMessageCallbacks.delete(id);
    }

    onInboxMessageDo(
        id: string,
        callback: OnMessageCallback
    ): WsQueueBoxClientService {
        this.onInboxMessageCallbacks.set(id, callback);
        return this;
    }

    onAllInboxMessagesDo(
        callback: OnMessageCallback,
        forceUpdate: boolean = false
    ): WsQueueBoxClientService {
        if (
            !forceUpdate &&
            this.onInboxMessageCallbacks.has(WsQueueBoxClientService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws inbox callbacks for ALL_IN');
        }

        this.onInboxMessageCallbacks.set(WsQueueBoxClientService.ALL_IN, callback);
        return this;
    }

    onAnyInboxMessageDo(
        id: string,
        callback: OnMessageCallback
    ): WsQueueBoxClientService {
        this.onAnyInboxMessageCallbacks.set(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.onInboxMessageCallbacks.delete(id);
    }

    removeAnyInboxMessageCallback(id: string): boolean {
        return this.onAnyInboxMessageCallbacks.delete(id);
    }

    readHealth(): WsQueueBoxClientHealth {
        const readyStateCode = this.socket.ws?.readyState;
        return {
            sessionId: this.input.sessionId,
            url: this.socket.url,
            readyState: toWsQueueBoxClientReadyState(readyStateCode),
            readyStateCode,
            isOpen: this.isSocketOpen(),
            reconnecting: this.reconnectStatus.task !== undefined,
            reconnectEnabled: this.reconnectStatus.enabled,
            reconnectAttempts: this.reconnectStatus.attempts,
            maxReconnectAttempts: this.options.reconnect.maxAttempts,
            reconnectExhausted: this.reconnectStatus.exhausted
        };
    }

    enableReconnect(): WsQueueBoxClientService {
        this.reconnectStatus.enabled = true;
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
        this.socket
            .onWebsocketCallbacksDo(
                this.input.sessionId,
                {
                    onOpen: () => {
                        // TODO: Anything to do?
                    },
                    onClose: () => this.reconnect(),
                    onError: () => this.reconnect()
                }
            );
        return this;
    }

    disableReconnect(): WsQueueBoxClientService {
        this.reconnectStatus.enabled = false;
        this.reconnectStatus.generation++;
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
        return this;
    }

    close(code?: number, reason?: string): void {
        this.closed = true;
        this.disableReconnect();
        this.outboundRuntime.dispose();
        this.socket.close(code, reason);
    }

    enableDefaultCallbacks(): WsQueueBoxClientService {
        this
            .onOutboxMessageDo(
                this.input.sessionId + '-outbox',
                {
                    onMessage: (entry, socket) => {
                        // console.log(`${this.input.sessionId} outbox: ${entry.resource}`);
                        socket.sendAsJsonString(entry.resource);

                        return Promise.resolve();
                    }
                }
            );

        this.socket
            .onWebSocketMessageDo(
                this.input.sessionId + '-inbox',
                {
                    onMessage: async (data) => {
                        const msg: ALMessage = data as ALMessage;

                        if (msg.id.senderId === this.input.sessionId) {
                            return;
                        }

                        await this.handleIncomingWsMessage(msg);
                    }
                }
            );

        return this;
    }

    private reconnect() {
        if (!this.canReconnect()) {
            return;
        }

        if (this.reconnectStatus.task) {
            return;
        }

        const reconnectGeneration = this.reconnectStatus.generation;
        const connectionRequestId = this.options.newConnectionRequestId?.();
        const reconnectTask = tryWithPolicy(
            async () =>
                await this.attemptReconnect(
                    reconnectGeneration,
                    connectionRequestId
                ),
            this.toReconnectPolicy(reconnectGeneration)
        )
            .catch(
                (error) =>
                    this.handleReconnectFailure(
                        error,
                        reconnectGeneration
                    )
            )
            .finally(() => {
                if (this.reconnectStatus.task === reconnectTask) {
                    this.reconnectStatus.task = undefined;
                }
            });

        this.reconnectStatus.task = reconnectTask;
    }

    private async attemptReconnect(
        reconnectGeneration: number,
        connectionRequestId: string | undefined
    ): Promise<void> {
        if (!this.isReconnectCurrent(reconnectGeneration)) {
            return;
        }

        this.reconnectStatus.attempts++;
        await this.connectSocketForReconnect(connectionRequestId);
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
    }

    private async connectSocketForReconnect(requestId: string | undefined): Promise<void> {
        const timeoutMs = this.options.reconnect.connectTimeoutMsecs;
        if (timeoutMs <= 0) {
            await this.socket.connect({ requestId });
            return;
        }

        await new Command<void>(
            (signal) => this.socket.connect({ requestId, signal }),
            {
                timeoutMs,
                errorOnNull: false
            }
        ).run();
    }

    private toReconnectPolicy(reconnectGeneration: number): TryWithPolicy {
        return TryWithPolicy.defaults()
            .label(`ws-reconnect:${this.input.sessionId}`)
            .maxAttempts(this.options.reconnect.maxAttempts)
            .initialDelayMsecs(this.options.reconnect.retryIntervalMsecs)
            .maxDelayMsecs(this.options.reconnect.maxRetryIntervalMsecs)
            .jitterRatio(0)
            .retryIf(() => this.isReconnectCurrent(reconnectGeneration));
    }

    private handleReconnectFailure(
        error: unknown,
        reconnectGeneration: number
    ): void {
        if (this.reconnectStatus.generation !== reconnectGeneration) {
            return;
        }

        this.reconnectStatus.enabled = false;
        this.reconnectStatus.generation++;

        if (error instanceof TryWithExhaustedError) {
            this.reconnectStatus.attempts = error.context.attempt;
            this.reconnectStatus.exhausted = true;
            console.warn(
                `WebSocket reconnect exhausted after ${this.reconnectStatus.attempts} attempts for ${this.input.sessionId}`,
                error
            );
            return;
        }

        this.reconnectStatus.exhausted = false;
        console.warn(
            `WebSocket reconnect stopped for ${this.input.sessionId}`,
            error
        );
    }

    private isReconnectCurrent(reconnectGeneration: number): boolean {
        return this.reconnectStatus.generation === reconnectGeneration &&
            this.canReconnect();
    }

    private canReconnect(): boolean {
        if (!this.reconnectStatus.enabled) {
            return false;
        }

        if (this.options.reconnect.canReconnect() === false) {
            this.disableReconnect();
            return false;
        }

        return true;
    }

    async enqueueOutboxIfAbsent(message: ALMessage): Promise<ALOutboundEnqueueResult> {
        if (this.closed) {
            return {
                status: 'skipped',
                message,
                entries: [],
                reason: 'WS queue-box client is closed.'
            };
        }

        return await this.outboundRuntime.enqueueIfAbsent(message);
    }

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        if (this.closed) {
            return;
        }

        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto) {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry)
            )
        );
    }

    private async handleIncomingWsMessage(msg: ALMessage): Promise<void> {
        await this.inboundRuntime.handleIncomingMessage(msg, msg.id.senderId);
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan?: ReturnType<typeof planALMessageHandling>
    ): Promise<void> {
        const message = JSON.parse(entry.resource) as ALMessage;

        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback = this.onInboxMessageCallbacks.get(message.payload.typeId) ??
                this.onInboxMessageCallbacks.get(WsQueueBoxClientService.ALL_IN);

            await this.onMessageIfPresent(exclusiveCallback, message, entry);
        }
        else {
            exclusiveCallback = this.onInboxMessageCallbacks.get(
                message.payload.typeId
            );
            await this.onMessageIfPresent(exclusiveCallback, message, entry);

            wildcard = this.onInboxMessageCallbacks.get(
                WsQueueBoxClientService.ALL_IN
            );
            await this.onMessageIfPresent(wildcard, message, entry);
        }

        for (const callback of this.onAnyInboxMessageCallbacks.values()) {
            await this.onMessageIfPresent(callback, message, entry);
        }

        if (
            exclusiveCallback === undefined &&
            wildcard === undefined &&
            this.onAnyInboxMessageCallbacks.size === 0
        ) {
            console.warn('No callback for typeId ', message.payload.typeId);
        }
    }

    private async onMessageIfPresent(
        callback: OnMessageCallback | undefined,
        message: ALMessage,
        entry: ResourceEntry
    ) {
        try {
            await callback?.onMessage(message, entry);
        }
        catch (e) {
            console.error('Error calling onMessage callback', e);
        }
    }

    private async dispatchOutboxEntry(entry: ResourceEntry): Promise<void> {
        if (this.onOutboxMessageCallbacks.size === 0) {
            this.socket.sendAsJsonString(entry.resource);
            return;
        }

        for (const callback of this.onOutboxMessageCallbacks.values()) {
            try {
                await callback.onMessage(entry, this.socket);
            }
            catch (e) {
                console.error('Error calling onMessage callback', e);
            }
        }
    }

    private isSocketOpen(): boolean {
        const readyState = this.socket.ws?.readyState;
        if (readyState === undefined) {
            return false;
        }

        const openState = (globalThis.WebSocket as { OPEN?: number; } | undefined)?.OPEN ?? 1;
        return readyState === openState;
    }

    private toAckTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        msg: ALMessage
    ): ALOutboundAckTrackingPlan | undefined {
        const targets = msg.targets;
        if (effective.ack.algo === 'none' || targets?.mode !== 'unicast') {
            return undefined;
        }

        return {
            enabled: true,
            timeoutMs: effective.ack.opts.timeoutMs,
            maxAttempts: effective.retry.algo === 'none'
                ? 0
                : effective.retry.opts.maxAttempts,
            expectedPeerIds: [targets.toPeerId]
        };
    }

    private toRetryTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective']
    ): ALOutboundRetryTrackingPlan | undefined {
        if (effective.retry.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            maxAttempts: effective.retry.opts.maxAttempts
        };
    }

    private toSupersedenceTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        msg: ALMessage
    ): ALOutboundSupersedenceTrackingPlan | undefined {
        if (effective.supersedence.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(msg, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId
        };
    }
}

function toWsQueueBoxClientReadyState(
    readyState: number | undefined
): WsQueueBoxClientReadyState {
    switch (readyState) {
        case undefined:
            return 'missing';
        case 0:
            return 'connecting';
        case 1:
            return 'open';
        case 2:
            return 'closing';
        case 3:
            return 'closed';
        default:
            return 'unknown';
    }
}

export default WsQueueBoxClientService;
