import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '../al-contracts/al-message-persistence-validation.ts';
import {
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALMessageHandlingPlan,
    type ALQosEffectivePolicy,
    type ALQosInputProvider
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
import type { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import {
    TryWithExhaustedError,
    TryWithPolicy,
    tryWithPolicy
} from '../resilience/TryWith.ts';
import type { JsonWebSocketClient } from '../websocket/JsonWebSocketClient.ts';
import type { OnMessageCallback, OnOutboxWebSocketMessageCallback } from './queue-message-callbacks.ts';
import { QueueBoxUtilities } from './QueueBoxUtilities.ts';

export const DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS: WsQueueBoxClientService.ReconnectOptions = {
    maxAttempts: 12,
    connectTimeoutMsecs: 10_000,
    retryIntervalMsecs: 500,
    maxRetryIntervalMsecs: 20_000,
    canReconnect: () => true
};

export namespace WsQueueBoxClientService {
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
        readonly readyState: ReadyState;
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

    export interface Input {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly newConnectionRequestId?: () => string;
        readonly reconnect?: ReconnectOptions;
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
        readonly reconnect: ReconnectOptions;
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

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<
        string,
        OnOutboxWebSocketMessageCallback
    >();

    private readonly onInboxMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

    private readonly onAnyInboxMessageCallbacks: Map<string, OnMessageCallback> = new Map<string, OnMessageCallback>();

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
    public readonly sessionId: string;
    private readonly dependencies: WsQueueBoxClientService.Dependencies;

    constructor(dependencies: WsQueueBoxClientService.Dependencies) {
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
        );

        this.inboundRuntime = new ALInboundMessageRuntime(
            {
                ...dependencies.inboundRuntime,
                inbox: this.inbox,
                planIncomingMessage: (msg, fromPeerId, runtime) => this.planIncomingMessage(msg, fromPeerId, runtime),
                readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
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

    private planOutgoingMessage(msg: ALMessage): ALOutboundDispatchPlan<ALMessage> {
        const normalized = normalizeALQosPolicy(
            msg,
            resolveALQosNormalizationInput(
                msg,
                {
                    direction: 'outbound',
                    selfPeerId: this.sessionId,
                    connectedPeerIds: this.isSocketOpen() ? [this.sessionId] : []
                },
                this.dependencies.qosProvider
            )
        );
        return {
            persist: shouldPersistOutbox(normalized.effective) || !this.isSocketOpen(),
            preparedMessages: [msg],
            ackTracking: this.toAckTrackingPlan(normalized.effective, msg),
            retryTracking: this.toRetryTrackingPlan(normalized.effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(normalized.effective, msg)
        };
    }

    private planIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        runtime: Parameters<ALInboundPlanner>[2]
    ): ALMessageHandlingPlan {
        return planALMessageHandling(
            msg,
            {
                selfPeerId: this.sessionId,
                fromPeerId,
                connectedPeerIds: [this.sessionId],
                dedupStore: runtime.dedupStore,
                orderingStore: runtime.orderingStore,
                supersedenceStore: runtime.supersedenceStore
            },
            resolveALQosNormalizationInput(
                msg,
                { direction: 'inbound', selfPeerId: this.sessionId, fromPeerId, connectedPeerIds: [this.sessionId] },
                this.dependencies.qosProvider
            )
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
            sessionId: this.sessionId,
            url: this.socket.url,
            readyState: toWsQueueBoxClientReadyState(readyStateCode),
            readyStateCode,
            isOpen: this.isSocketOpen(),
            reconnecting: this.reconnectStatus.task !== undefined,
            reconnectEnabled: this.reconnectStatus.enabled,
            reconnectAttempts: this.reconnectStatus.attempts,
            maxReconnectAttempts: this.dependencies.reconnect.maxAttempts,
            reconnectExhausted: this.reconnectStatus.exhausted
        };
    }

    enableReconnect(): WsQueueBoxClientService {
        this.reconnectStatus.enabled = true;
        this.reconnectStatus.attempts = 0;
        this.reconnectStatus.exhausted = false;
        this.socket
            .onWebsocketCallbacksDo(
                this.sessionId,
                {
                    onOpen: () => {},
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
                this.sessionId + '-outbox',
                {
                    onMessage: (entry, socket) => {
                        socket.sendAsJsonString(entry.resource);

                        return Promise.resolve();
                    }
                }
            );

        this.socket
            .onWebSocketMessageDo(
                this.sessionId + '-inbox',
                {
                    onMessage: async (data) => {
                        const msg = decodePersistedALMessageValue(data);

                        if (msg.id.senderId === this.sessionId) {
                            return;
                        }

                        await this.inboundRuntime.handleIncomingMessage(msg, msg.id.senderId);
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
        const connectionRequestId = this.dependencies.newConnectionRequestId?.();
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
                        error instanceof Error ? error : new Error(String(error)),
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
        const timeoutMs = this.dependencies.reconnect.connectTimeoutMsecs;
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
            .label(`ws-reconnect:${this.sessionId}`)
            .maxAttempts(this.dependencies.reconnect.maxAttempts)
            .initialDelayMsecs(this.dependencies.reconnect.retryIntervalMsecs)
            .maxDelayMsecs(this.dependencies.reconnect.maxRetryIntervalMsecs)
            .jitterRatio(0)
            .retryIf(() => this.isReconnectCurrent(reconnectGeneration));
    }

    private handleReconnectFailure(
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
                `WebSocket reconnect exhausted after ${this.reconnectStatus.attempts} attempts for ${this.sessionId}`,
                error
            );
            return;
        }

        this.reconnectStatus.exhausted = false;
        console.warn(
            `WebSocket reconnect stopped for ${this.sessionId}`,
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

        if (this.dependencies.reconnect.canReconnect() === false) {
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
        return this.socket.ws?.readyState === 1;
    }

    private toAckTrackingPlan(
        effective: ALQosEffectivePolicy,
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
        effective: ALQosEffectivePolicy
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
        effective: ALQosEffectivePolicy,
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

export default WsQueueBoxClientService;
