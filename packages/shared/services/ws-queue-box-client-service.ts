import { ALMessage } from '../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../al-contracts/al-message-persistence-validation.ts';
import {
    ALQosInputProvider,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALMessageHandlingPlan
} from '../al-contracts/al-policy.ts';
import type { ALInboundPlanner } from '../alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
import { decodeALOutboundPreparedMessage } from '../alm/outbound/al-outbound-effect-validation.ts';
import type {
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundAckTrackingPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    type ALOutboundAckTrackingPlan,
    type ALOutboundDispatchPlan,
    type ALOutboundEnqueueResult,
    type ALOutboundRetryTrackingPlan,
    type ALOutboundSupersedenceTrackingPlan
} from '../alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundRuntimeResources } from '../alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '../api/api-config.ts';
import { Command } from '../cache/Command.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { toError } from '../resilience/to-error.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '../resilience/TryWith.ts';
import { JsonWebSocketClient } from '../websocket/JsonWebSocketClient.ts';
import { OnMessageCallback, OnOutboxWebSocketMessageCallback } from './queue-message-callbacks.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';

export const DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS: WsQueueBoxClientService.ReconnectOptions = {
    maxAttempts: 12,
    connectTimeoutMsecs: 10_000,
    retryIntervalMsecs: 500,
    maxRetryIntervalMsecs: 20_000,
    canReconnect: () => true
};

export namespace WsQueueBoxClientService {
    export interface InputDto {
        readonly sessionId: string;
    }

    export interface Options {
        readonly qosProvider?: ALQosInputProvider;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly newConnectionRequestId?: () => string;
        readonly reconnect: WsQueueBoxClientService.ReconnectOptions;
    }

    export interface ReconnectOptions {
        readonly maxAttempts: number;
        readonly connectTimeoutMsecs: number;
        readonly retryIntervalMsecs: number;
        readonly maxRetryIntervalMsecs: number;
        readonly canReconnect: () => boolean;
    }

    export type ReadyState =
        | 'missing'
        | 'connecting'
        | 'open'
        | 'closing'
        | 'closed'
        | 'unknown';

    export interface Health {
        readonly sessionId: string;
        readonly url: string;
        readonly readyState: WsQueueBoxClientService.ReadyState;
        readonly readyStateCode?: number;
        readonly isOpen: boolean;
        readonly reconnecting: boolean;
        readonly reconnectEnabled: boolean;
        readonly reconnectAttempts: number;
        readonly maxReconnectAttempts: number;
        readonly reconnectExhausted: boolean;
    }

    export interface ReconnectStatus {
        task: Promise<void> | undefined;
        enabled: boolean;
        generation: number;
        attempts: number;
        exhausted: boolean;
    }

    export interface Dependencies {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly newConnectionRequestId: (() => string) | undefined;
        readonly reconnect: WsQueueBoxClientReconnectOptions;
    }
}

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

    private readonly onOutboxMessageCallbacks = new Map<string, OnOutboxWebSocketMessageCallback>();

    private readonly onInboxMessageCallbacks = new Map<string, OnMessageCallback>();

    private readonly onAnyInboxMessageCallbacks = new Map<string, OnMessageCallback>();

    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALMessage>;
    private closed = false;

    private readonly reconnectStatus: WsQueueBoxClientService.ReconnectStatus = {
        task: undefined,
        enabled: false,
        generation: 0,
        attempts: 0,
        exhausted: false
    };

    public readonly inbox: QueueBoxResourceEntryRepository;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketClient;
    public readonly input: WsQueueBoxClientService.InputDto;
    private readonly options: WsQueueBoxClientService.Options;

    constructor(
        dependencies: WsQueueBoxClientService.Dependencies,
        input: WsQueueBoxClientService.InputDto,
        options: WsQueueBoxClientService.Options = {
            reconnect: DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
        }
    ) {
        this.inbox = dependencies.inbox;
        this.outbox = dependencies.outbox;
        this.socket = dependencies.socket;
        this.sessionId = dependencies.sessionId;
        this.dependencies = dependencies;
        this.outboundRuntime = new ALOutboundMessageRuntime<ALMessage>(
            {
                ...dependencies.outboundRuntime,
                decodePreparedMessage: decodeALOutboundPreparedMessage,
                diagnostics: this.dependencies.outboundDiagnostics,
                outbox: this.outbox,
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE
                    ),
                readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
                planOutgoingMessage: (msg) => this.planOutgoingMessage(msg),
                planDequeuedMessage: (msg) => this.planOutgoingMessage(msg),
                beforeDequeueDispatch: undefined,
                planRepairMessage: undefined,
                onFallbackDequeue: undefined,
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
        });
    }

    private createInboundRuntime(): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime({
            stores: this.options.inboundStores,
            selfPeerId: this.input.sessionId,
            inbox: this.inbox,
            planIncomingMessage: (message, fromPeerId, runtime) =>
                this.readIncomingMessagePlan(message, fromPeerId, runtime),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            toInboxEntry: (message) =>
                QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.INBOX_ENQUEUE_TYPE),
            dispatchInboxEntry: (entry, plan) => this.dispatchInboxEntry(entry, plan),
            sendControlMessage: async (message) => {
                await this.enqueueOutboxIfAbsent(message);
            },
            onControlMessage: async (message) => {
                await this.outboundRuntime.acceptControlMessage(message);
            }
        });
    }

    private readOutgoingMessagePlan(message: ALMessage): ALOutboundDispatchPlan<ALMessage> {
        const socketOpen = this.isSocketOpen();
        const normalized = normalizeALQosPolicy(
            message,
            resolveALQosNormalizationInput(message, {
                direction: 'outbound',
                selfPeerId: this.input.sessionId,
                connectedPeerIds: socketOpen ? [this.input.sessionId] : []
            }, this.options.qosProvider)
        );
        return {
            persist: shouldPersistOutbox(normalized.effective) || !socketOpen,
            preparedMessages: [message],
            ackTracking: this.toAckTrackingPlan(normalized.effective, message),
            retryTracking: this.toRetryTrackingPlan(normalized.effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(normalized.effective, message)
        };
    }

    private readIncomingMessagePlan(
        message: ALMessage,
        fromPeerId: string,
        runtime: Parameters<ALInboundPlanner>[2]
    ): ALMessageHandlingPlan {
        return planALMessageHandling(
            message,
            {
                selfPeerId: this.input.sessionId,
                fromPeerId,
                connectedPeerIds: [this.input.sessionId],
                dedupStore: runtime.dedupStore,
                orderingStore: runtime.orderingStore,
                supersedenceStore: runtime.supersedenceStore
            },
            resolveALQosNormalizationInput(message, {
                direction: 'inbound',
                selfPeerId: this.input.sessionId,
                fromPeerId,
                connectedPeerIds: [this.input.sessionId]
            }, this.options.qosProvider)
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

    readHealth(): WsQueueBoxClientService.Health {
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
        this.inboundRuntime.dispose();
        this.socket.close(code, reason);
    }

    enableDefaultCallbacks(): WsQueueBoxClientService {
        this
            .onOutboxMessageDo(
                this.input.sessionId + '-outbox',
                {
                    onMessage: (entry, socket) => {
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
                        const message = decodePersistedALMessageValue(data);

                        if (message.id.senderId === this.input.sessionId) {
                            return;
                        }

                        await this.inboundRuntime.handleIncomingMessage(message, message.id.senderId);
                    }
                }
            );

        return this;
    }

    private reconnect(): void {
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
                    this.stopReconnectAfterFailure(
                        toError(error),
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

    private stopReconnectAfterFailure(
        error: Error,
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

    async dequeueOutbox(typesToDequeue: Set<string>, resilience: ResilienceDto): Promise<void> {
        if (this.closed) {
            return;
        }

        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResilienceDto): Promise<void> {
        await QueueBoxUtilities.defaultDequeue(
            this.inbox,
            typesToDequeue,
            resilience,
            QueueBoxUtilities.withRetryDisposition(
                async (entry) => await this.inboundRuntime.dispatchStoredEntry(entry)
            )
        );
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan?: ALMessageHandlingPlan
    ): Promise<void> {
        const message = decodePersistedALMessage(entry.resource);

        let exclusiveCallback;
        let wildcard = undefined;

        if (plan?.ownership.exclusive) {
            exclusiveCallback = this.onInboxMessageCallbacks.get(message.payload.typeId) ??
                this.onInboxMessageCallbacks.get(WsQueueBoxClientService.ALL_IN);

            await this.notifyInboxCallback(exclusiveCallback, message, entry);
        }
        else {
            exclusiveCallback = this.onInboxMessageCallbacks.get(
                message.payload.typeId
            );
            await this.notifyInboxCallback(exclusiveCallback, message, entry);

            wildcard = this.onInboxMessageCallbacks.get(
                WsQueueBoxClientService.ALL_IN
            );
            await this.notifyInboxCallback(wildcard, message, entry);
        }

        for (const callback of this.onAnyInboxMessageCallbacks.values()) {
            await this.notifyInboxCallback(callback, message, entry);
        }

        if (
            exclusiveCallback === undefined &&
            wildcard === undefined &&
            this.onAnyInboxMessageCallbacks.size === 0
        ) {
            console.warn('No callback for typeId ', message.payload.typeId);
        }
    }

    private async notifyInboxCallback(
        callback: OnMessageCallback | undefined,
        message: ALMessage,
        entry: ResourceEntry
    ): Promise<void> {
        try {
            await callback?.onMessage(message, entry);
        }
        catch (e) {
            console.error('Error calling onMessage callback', toError(e));
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
                console.error('Error calling onMessage callback', toError(e));
            }
        }
    }

    private isSocketOpen(): boolean {
        const readyState = this.socket.ws?.readyState;
        if (readyState === undefined) {
            return false;
        }

        return readyState === WebSocket.OPEN;
    }

    private toAckTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        message: ALMessage
    ): ALOutboundAckTrackingPlan | undefined {
        const targets = message.targets;
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
        message: ALMessage
    ): ALOutboundSupersedenceTrackingPlan | undefined {
        if (effective.supersedence.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(message, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId
        };
    }
}

export function createDefaultWsQueueBoxClientService(input: WsQueueBoxClientService.Input): WsQueueBoxClientService {
    return new WsQueueBoxClientService({
        inbox: input.inbox,
        outbox: input.outbox,
        socket: input.socket,
        sessionId: input.sessionId,
        qosProvider: input.qosProvider,
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            selfPeerId: input.sessionId,
            toInboxEntry: (message) =>
                QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.INBOX_ENQUEUE_TYPE)
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({ stores: input.outboundStores }),
        outboundDiagnostics: input.outboundDiagnostics,
        newConnectionRequestId: input.newConnectionRequestId,
        reconnect: input.reconnect ?? DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS
    });
}

function toWsQueueBoxClientReadyState(
    readyState: number | undefined
): WsQueueBoxClientService.ReadyState {
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
