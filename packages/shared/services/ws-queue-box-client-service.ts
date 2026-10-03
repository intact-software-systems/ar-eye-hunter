import { AL_WS_CLIENT_CAPABILITIES, toALCarrierQosInputProvider } from '../al-contracts/al-carrier-capabilities.ts';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage,
    type ALMessageRejection
} from '../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
import {
    planALMessageHandling,
    resolveALQosNormalizationInput,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations,
    type ALQosInputProvider
} from '../al-contracts/al-policy.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliverySettlementSink
} from '../alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import {
    recordALInboundDiagnostic,
    type ALInboundConsumerInvocation,
    type ALInboundRuntimeDiagnosticsSink
} from '../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundCancelOutcome } from '../alm/outbound/al-outbound-message-runtime.ts';
import type {
    ALCheckpointOutboundRuntimeStores,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundMessageRuntime,
    type ALOutboundDispatchPlan,
    type ALOutboundEnqueueResult,
    type ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    reconstructALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALDurableWorkOwnership } from '../alm/work/al-durable-work-ownership.ts';
import { EnqueuedType } from '../api/api-config.ts';
import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { Either } from '../resilience/Either.ts';
import {
    createPassThroughWebSocketSubmissionReadinessFaultPort,
    type WebSocketSubmissionReadinessFaultPort
} from '../transport-faults/transport-fault-port.ts';
import type { JsonWebSocketClient } from '../websocket/json-web-socket-client.ts';
import { WsClientReconnect } from '../websocket/ws-client-reconnect.ts';
import type { InboxOutboxEngine } from './InboxOutboxEngine.ts';
import { QueueBoxUtilities } from './queue-box-utilities.ts';
import type {
    OnInboxMessageCallback,
    OnOutboxWebSocketMessageCallback
} from './queue-message-callbacks.ts';
import { toWsQueueBoxClientDispatchPlan } from './ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';
import { acceptWsQueueBoxClientControlMessage } from './ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

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
        /** Standalone transports may have no domain prerequisite; browser composition supplies room readiness. */
        readonly readSubmissionIneligibility?: (message: ALMessage) => string | undefined;
        readonly submissionReadinessFaultPort?: WebSocketSubmissionReadinessFaultPort;
        readonly queueEngine?: InboxOutboxEngine;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        /**
         * The peer id the WS server answers as, learned from `/api/config` (D57 as applied, Q3); undefined when the server
         * names none, so the client tracks no server hop.
         */
        readonly serverPeerId: string | undefined;
        readonly qosProvider?: ALQosInputProvider;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
        readonly outboundVolatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;
        /** The memory pair a `local-checkpoint` admission goes to; absent, this client has no checkpoint lane. */
        readonly outboundCheckpointStores?: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly dequeueResilience?: ResourceInboxResilience;
        readonly newConnectionRequestId?: () => string;
        readonly reconnect?: ReconnectOptions;
        /** The browser's per-connect session claim; absent, this client's runtimes own their durable work. */
        readonly durableWorkOwnership?: ALDurableWorkOwnership;
    }

    export interface Dependencies {
        readonly readSubmissionIneligibility: (message: ALMessage) => string | undefined;
        readonly submissionReadinessFaultPort: WebSocketSubmissionReadinessFaultPort;
        readonly socket: JsonWebSocketClient;
        readonly sessionId: string;
        readonly serverPeerId: string | undefined;
        readonly qosProvider: ALQosInputProvider;
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

    private readonly reconnectOwner: WsClientReconnect;

    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketClient;
    public readonly sessionId: string;
    public readonly serverPeerId: string | undefined;
    private readonly dependencies: WsQueueBoxClientService.Dependencies;

    constructor(dependencies: WsQueueBoxClientService.Dependencies) {
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.socket = dependencies.socket;
        this.sessionId = dependencies.sessionId;
        this.serverPeerId = dependencies.serverPeerId;
        this.dependencies = dependencies;
        this.reconnectOwner = new WsClientReconnect(dependencies);
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
                carrier: 'ws',
                planIncomingMessage: (msg, source, observations) => this.planIncomingMessage(msg, source, observations),
                canDispatchMessage: (message) => this.hasInboxConsumer(message),
                dispatchInboxEntry: async (entry, plan) => await this.dispatchInboxEntry(entry, plan),
                sendControlMessages: async (msgs) => {
                    await this.handoffControlMessages(msgs);
                },
                onControlMessage: async (msg) => {
                    const admitted = await acceptWsQueueBoxClientControlMessage(this.outboundRuntime, msg);
                    return admitted.kind === 'storage-unavailable' ? admitted : undefined;
                },
                diagnostics: this.dependencies.inboundDiagnostics
            }
        );
    }

    /** A control its store could not persist throws into the inbound claim, which retries it. */
    private async handoffControlMessages(msgs: readonly ALMessage[]): Promise<void> {
        const results = await this.enqueueOutboxAllIfAbsent(msgs);
        const unpersisted = results.find((result) => result.verdict.kind === 'storage-unavailable');
        if (unpersisted !== undefined) {
            throw new Error(unpersisted.reason ?? 'WS control admission returned storage-unavailable');
        }
    }

    private planOutgoingMessage(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        return toWsQueueBoxClientDispatchPlan(msg, {
            sessionId: this.sessionId,
            serverPeerId: this.serverPeerId,
            socketOpen: this.isSocketOpen(),
            qosProvider: this.dependencies.qosProvider
        });
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
            ...this.reconnectOwner.readHealth()
        };
    }

    enableReconnect(): WsQueueBoxClientService {
        this.reconnectOwner.enable();
        return this;
    }

    disableReconnect(): WsQueueBoxClientService {
        this.reconnectOwner.disable();
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
                    onMessage: async (value, event) => {
                        if (event.target !== null && event.target !== this.socket.ws) {
                            return;
                        }
                        await this.acceptIncomingMessage(value);
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

    cancelOutbox(msgId: string): ALOutboundCancelOutcome {
        return this.outboundRuntime.cancel(msgId);
    }

    async enqueueOutboxIfAbsent(message: ALMessage): Promise<ALOutboundEnqueueResult> {
        const [result] = await this.enqueueOutboxAllIfAbsent([message]);
        return result!;
    }

    /** The messages of one sender admitted as one outbound commit; one result per message, in order. */
    async enqueueOutboxAllIfAbsent(messages: readonly ALMessage[]): Promise<readonly ALOutboundEnqueueResult[]> {
        if (this.closed) {
            const verdict: ALDeliveryAdmissionVerdict = {
                kind: 'skipped',
                reason: 'disposed',
                detail: 'WS queue-box client is closed.'
            };
            return messages.map((message) => ({
                verdict,
                message,
                entries: [],
                reason: verdict.detail,
                trackedReceiptAlgo: 'none'
            }));
        }

        return await this.outboundRuntime.enqueueAllIfAbsent(messages);
    }

    /**
     * One message straight to an open socket: no admission, work row or retry. Only for latest-value
     * telemetry a newer message replaces, so a dropped send costs nothing worth recovering.
     */
    sendLive(message: ALMessage): 'sent' | 'socket-closed' {
        if (!this.isSocketOpen()) {
            return 'socket-closed';
        }
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE);
        this.socket.sendAsJsonString(entry.resource);
        return 'sent';
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
        const exact = this.onInboxMessageCallbacks.get(message.payload.typeId);
        const selected = exact ??
            (plan.ownership.exclusive ? this.onInboxMessageCallbacks.get(WsQueueBoxClientService.ALL_IN) : undefined);
        const selectedResult = exact === undefined
            ? await this.dispatchWithoutExactConsumer(message, entry, selected)
            : await this.dispatchExactConsumer(message, entry, exact);
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

    private async dispatchWithoutExactConsumer(
        message: ALMessage,
        entry: ResourceEntry,
        selected: OnInboxMessageCallback | undefined
    ): Promise<void | 'retry'> {
        const nowMs = this.dependencies.inboundRuntime.clock.nowMs();
        this.recordConsumerInvocation(message, nowMs, { selection: 'absent', outcome: 'not-invoked' });
        return await selected?.onMessage(message, entry);
    }

    private async dispatchExactConsumer(
        message: ALMessage,
        entry: ResourceEntry,
        selected: OnInboxMessageCallback
    ): Promise<void | 'retry'> {
        const beganAtMs = this.dependencies.inboundRuntime.clock.nowMs();
        let result: void | 'retry';
        try {
            result = await selected.onMessage(message, entry);
        }
        catch (error) {
            this.recordConsumerInvocation(message, beganAtMs, { selection: 'exact-type', outcome: 'threw' });
            throw error;
        }
        this.recordConsumerInvocation(message, beganAtMs, {
            selection: 'exact-type',
            outcome: result === 'retry' ? 'retry' : 'returned'
        });
        return result;
    }

    private recordConsumerInvocation(
        message: ALMessage,
        beganAtMs: number,
        result: Pick<ALInboundConsumerInvocation, 'selection' | 'outcome'>
    ): void {
        recordALInboundDiagnostic(this.dependencies.inboundDiagnostics, {
            kind: 'consumer-invocation',
            msgId: message.id.msgId,
            typeId: message.payload.typeId,
            carrier: 'ws',
            ...result,
            beganAtMs,
            settledAtMs: this.dependencies.inboundRuntime.clock.nowMs()
        });
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
        // Evaluate before any callback can write. An awaited custom callback retains its own
        // effect contract; rechecking here between callbacks could misreport an earlier write.
        const reason = this.dependencies.readSubmissionIneligibility(lifecycle.canonicalMessage);
        if (reason !== undefined) {
            return { status: 'not-ready', submissionAttempted: false, reason };
        }
        if (!this.socket.decideSubmissionReadiness(entry.resource, this.dependencies.submissionReadinessFaultPort)) {
            return { status: 'not-ready', submissionAttempted: false };
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
}

export function createDefaultWsQueueBoxClientService(input: WsQueueBoxClientService.Input): WsQueueBoxClientService {
    return new WsQueueBoxClientService({
        readSubmissionIneligibility: input.readSubmissionIneligibility ?? (() => undefined),
        submissionReadinessFaultPort: input.submissionReadinessFaultPort ??
            createPassThroughWebSocketSubmissionReadinessFaultPort(),
        socket: input.socket,
        sessionId: input.sessionId,
        serverPeerId: input.serverPeerId,
        qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, input.qosProvider),
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            volatileStores: input.inboundVolatileStores,
            queueEngine: input.queueEngine,
            selfPeerId: input.sessionId,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX),
            durableWorkOwnership: input.durableWorkOwnership
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeALOutboundTransportMessage,
            canonicalQueue: input.outbox,
            stores: input.outboundStores,
            volatileStores: input.outboundVolatileStores,
            checkpointStores: input.outboundCheckpointStores,
            queueEngine: input.queueEngine,
            durableWorkOwnership: input.durableWorkOwnership
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
