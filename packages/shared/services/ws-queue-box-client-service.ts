import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage,
    type ALMessageRejection
} from '../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import {
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations,
    type ALQosEffectivePolicy,
    type ALQosInputProvider
} from '../al-contracts/al-policy.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliverySettlementSink
} from '../alm/delivery/al-delivery-lifecycle.ts';
import { toALOutboundEnqueueStatus } from '../alm/delivery/to-al-outbound-enqueue-status.ts';
import type { ALInboundRuntimeStores } from '../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
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
    type ALOutboundSettledSendResult,
    type ALOutboundSupersedenceTrackingPlan
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    reconstructALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../alm/outbound/create-default-al-outbound-message-runtime.ts';
import { toALOutboundMessage } from '../alm/outbound/to-al-outbound-message.ts';
import { EnqueuedType } from '../api/api-config.ts';
import { Command } from '../cache/Command.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { Either } from '../resilience/Either.ts';
import {
    TryWithExhaustedError,
    TryWithPolicy,
    tryWithPolicy
} from '../resilience/TryWith.ts';
import type { JsonWebSocketClient } from '../websocket/json-web-socket-client.ts';
import type { InboxOutboxEngine } from './InboxOutboxEngine.ts';
import { QueueBoxUtilities } from './queue-box-utilities.ts';
import type {
    OnInboxMessageCallback,
    OnOutboxWebSocketMessageCallback
} from './queue-message-callbacks.ts';

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
        readonly queueEngine?: InboxOutboxEngine;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly dequeueResilience?: ResourceInboxResilience;
        readonly newConnectionRequestId?: () => string;
        readonly reconnect?: ReconnectOptions;
    }

    export interface Dependencies {
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
        readonly dequeueResilience: ResourceInboxResilience;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundSettlements: ALDeliverySettlementSink | undefined;
        readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
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

    private readonly onOutboxMessageCallbacks: Map<string, OnOutboxWebSocketMessageCallback> = new Map<
        string,
        OnOutboxWebSocketMessageCallback
    >();

    private readonly onInboxMessageCallbacks: Map<string, OnInboxMessageCallback> = new Map();

    private readonly onAnyInboxMessageCallbacks: Map<string, OnInboxMessageCallback> = new Map();

    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private closed = false;

    private readonly reconnectStatus: WsQueueBoxClientService.ReconnectStatus = {
        task: undefined,
        enabled: false,
        generation: 0,
        attempts: 0,
        exhausted: false
    };

    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketClient;
    public readonly sessionId: string;
    private readonly dependencies: WsQueueBoxClientService.Dependencies;

    constructor(dependencies: WsQueueBoxClientService.Dependencies) {
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.socket = dependencies.socket;
        this.sessionId = dependencies.sessionId;
        this.dependencies = dependencies;
        this.outboundRuntime = this.createOutboundRuntime(dependencies.outboundRuntime);
        this.inboundRuntime = this.createInboundRuntime(dependencies.inboundRuntime);
    }

    private createOutboundRuntime(
        resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>
    ): ALOutboundMessageRuntime<ALOutboundTransportMessage> {
        return new ALOutboundMessageRuntime<ALOutboundTransportMessage>(
            {
                ...resources,
                carrier: 'ws',
                decodePreparedMessage: decodeALOutboundTransportMessage,
                dequeue: {
                    types: WsQueueBoxClientService.OUTBOX_DEQUEUE_TYPES,
                    resilience: this.dependencies.dequeueResilience
                },
                diagnostics: this.dependencies.outboundDiagnostics,
                settlements: this.dependencies.outboundSettlements,
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE
                    ),
                readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
                planOutgoingMessage: (msg) => this.planOutgoingMessage(msg),
                planDequeuedMessage: (msg) => this.planOutgoingMessage(msg),
                afterDequeueAdmission: undefined,
                planRepairMessage: undefined,
                sendPreparedMessage: async (prepared, _phase, lifecycle) => {
                    const msg = reconstructALOutboundTransportMessage(prepared, lifecycle.canonicalMessage);
                    return await this.dispatchOutboxEntry(
                        QueueBoxUtilities.toResourceEntryFromMsg(
                            msg,
                            WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE
                        ),
                        lifecycle
                    );
                }
            }
        );
    }

    private createInboundRuntime(resources: ALInboundMessageRuntime.Resources): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime(
            {
                ...resources,
                planIncomingMessage: (msg, source, observations) => this.planIncomingMessage(msg, source, observations),
                canDispatchMessage: (message) => this.hasInboxConsumer(message),
                dispatchInboxEntry: async (entry, plan) => await this.dispatchInboxEntry(entry, plan),
                sendControlMessage: async (msg) => {
                    await this.enqueueOutboxIfAbsent(msg);
                },
                onControlMessage: async (msg) => {
                    await this.outboundRuntime.acceptControlMessage(msg);
                },
                diagnostics: this.dependencies.inboundDiagnostics
            }
        );
    }

    private planOutgoingMessage(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const socketOpen = this.isSocketOpen();
        const normalizationInput = resolveALQosNormalizationInput(
            msg,
            {
                direction: 'outbound',
                selfPeerId: this.sessionId,
                connectedPeerIds: socketOpen ? [this.sessionId] : []
            },
            this.dependencies.qosProvider
        );
        const normalized = normalizeALQosPolicy(msg, normalizationInput);
        const message = toALOutboundMessage(msg, normalized.effective);
        return {
            msg: message,
            dropReasonCode: undefined,
            persist: shouldPersistOutbox(normalized.effective) || !socketOpen,
            preparedMessages: [toALOutboundTransportMessage(message)],
            ackTracking: this.toAckTrackingPlan(normalized.effective, msg),
            retryTracking: this.toRetryTrackingPlan(normalized.effective),
            repairTracking: {
                enabled: normalized.effective.repair.algo !== 'none',
                algo: normalized.effective.repair.algo,
                maxAttempts: normalized.effective.repair.opts.maxRepairs
            },
            supersedenceTracking: this.toSupersedenceTrackingPlan(normalized.effective, msg)
        };
    }

    private planIncomingMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        observations: ALMessagePlanningObservations
    ): ALMessageHandlingPlan {
        const fromPeerId = source.kind === 'trusted-server' ? msg.id.senderId : source.peerId;
        const normalizationInput = resolveALQosNormalizationInput(
            msg,
            { direction: 'inbound', selfPeerId: this.sessionId, fromPeerId, connectedPeerIds: [this.sessionId] },
            this.dependencies.qosProvider
        );
        return planALMessageHandling(
            msg,
            {
                selfPeerId: this.sessionId,
                fromPeerId,
                connectedPeerIds: [this.sessionId],
                ...observations
            },
            normalizationInput
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
        callback: OnInboxMessageCallback
    ): WsQueueBoxClientService {
        this.onInboxMessageCallbacks.set(id, callback);
        this.dependencies.inboundRuntime.queueEngine.wake();
        return this;
    }

    onAllInboxMessagesDo(
        callback: OnInboxMessageCallback,
        forceUpdate: boolean = false
    ): WsQueueBoxClientService {
        if (
            !forceUpdate &&
            this.onInboxMessageCallbacks.has(WsQueueBoxClientService.ALL_IN)
        ) {
            throw new Error('Cannot set multiple Ws inbox callbacks for ALL_IN');
        }

        this.onInboxMessageCallbacks.set(WsQueueBoxClientService.ALL_IN, callback);
        this.dependencies.inboundRuntime.queueEngine.wake();
        return this;
    }

    onAnyInboxMessageDo(
        id: string,
        callback: OnInboxMessageCallback
    ): WsQueueBoxClientService {
        this.onAnyInboxMessageCallbacks.set(id, callback);
        this.dependencies.inboundRuntime.queueEngine.wake();
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
                    maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
                    onMessage: async (data, event) => {
                        if (event.target !== null && event.target !== this.socket.ws) {
                            return;
                        }
                        await this.acceptIncomingMessage(data);
                    }
                }
            );

        return this;
    }

    async acceptIncomingMessage(
        value: unknown
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        if (this.closed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        const decoded = decodeALMessageValue(value);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const message = decoded.right!;
        if (message.id.senderId === this.sessionId) {
            return Either.ofRight({ kind: 'duplicate' });
        }
        return await this.inboundRuntime.admitIncomingMessage(message, { kind: 'trusted-server' });
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
            const verdict: ALDeliveryAdmissionVerdict = {
                kind: 'skipped',
                reason: 'disposed',
                detail: 'WS queue-box client is closed.'
            };
            return {
                status: toALOutboundEnqueueStatus(verdict),
                verdict,
                message,
                entries: [],
                reason: verdict.detail
            };
        }

        return await this.outboundRuntime.enqueueIfAbsent(message);
    }

    private hasInboxConsumer(message: ALMessage): boolean {
        return this.onInboxMessageCallbacks.has(message.payload.typeId) ||
            this.onInboxMessageCallbacks.has(WsQueueBoxClientService.ALL_IN) ||
            this.onAnyInboxMessageCallbacks.size > 0;
    }

    private async dispatchInboxEntry(
        entry: ResourceEntry,
        plan: ALMessageHandlingPlan
    ): Promise<void | 'retry'> {
        const message = decodePersistedALMessage(entry.resource);
        this.requireInboxDeliveryTime(entry);
        const selected = this.onInboxMessageCallbacks.get(message.payload.typeId) ??
            (plan.ownership.exclusive ? this.onInboxMessageCallbacks.get(WsQueueBoxClientService.ALL_IN) : undefined);
        const selectedResult = await selected?.onMessage(message, entry);
        if (selectedResult === 'retry') {
            return 'retry';
        }
        if (this.closed) {
            return 'retry';
        }
        const wildcard = plan.ownership.exclusive
            ? undefined
            : this.onInboxMessageCallbacks.get(WsQueueBoxClientService.ALL_IN);
        if (wildcard !== undefined) {
            this.requireInboxDeliveryTime(entry);
            const wildcardResult = await wildcard.onMessage(message, entry);
            if (wildcardResult === 'retry') {
                return 'retry';
            }
        }

        for (const callback of this.onAnyInboxMessageCallbacks.values()) {
            if (this.closed) {
                return 'retry';
            }
            this.requireInboxDeliveryTime(entry);
            const callbackResult = await callback.onMessage(message, entry);
            if (callbackResult === 'retry') {
                return 'retry';
            }
        }

        if (
            selected === undefined &&
            wildcard === undefined &&
            this.onAnyInboxMessageCallbacks.size === 0
        ) {
            return 'retry';
        }
    }

    private requireInboxDeliveryTime(entry: ResourceEntry): void {
        if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.outboundRuntime.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before consumer delivery');
        }
    }

    private async dispatchOutboxEntry(
        entry: ResourceEntry,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        const stopped = this.readSendIneligibility(lifecycle);
        if (stopped) {
            return stopped;
        }
        if (this.onOutboxMessageCallbacks.size === 0) {
            this.socket.sendAsJsonString(entry.resource);
            return { status: 'sent', submissionAttempted: true };
        }

        for (const callback of this.onOutboxMessageCallbacks.values()) {
            const stopped = this.readSendIneligibility(lifecycle);
            if (stopped) {
                return stopped;
            }
            await callback.onMessage(entry, this.socket, lifecycle);
        }
        return { status: 'sent', submissionAttempted: true };
    }

    private readSendIneligibility(
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): ALOutboundSettledSendResult | undefined {
        if (this.closed || lifecycle.signal.aborted) {
            return { status: 'cancelled', submissionAttempted: false };
        }
        if (
            lifecycle.expiresAtMs !== undefined &&
            this.dependencies.outboundRuntime.clock.nowMs() >= lifecycle.expiresAtMs
        ) {
            return { status: 'expired', submissionAttempted: false };
        }
        return this.isSocketOpen() ? undefined : { status: 'not-ready', submissionAttempted: false };
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
        socket: input.socket,
        sessionId: input.sessionId,
        qosProvider: input.qosProvider,
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            queueEngine: input.queueEngine,
            selfPeerId: input.sessionId,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX)
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeALOutboundTransportMessage,
            canonicalQueue: input.outbox,
            stores: input.outboundStores,
            queueEngine: input.queueEngine
        }),
        dequeueResilience: input.dequeueResilience ?? createDefaultALOutboundDequeueResilience(),
        outboundDiagnostics: input.outboundDiagnostics,
        outboundSettlements: input.outboundSettlements,
        inboundDiagnostics: input.inboundDiagnostics,
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
