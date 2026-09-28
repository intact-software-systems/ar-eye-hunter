import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '../../al-contracts/al-carrier-capabilities.ts';
import { isRoomScopedALMessage, type ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage,
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import {
    type ALQosInputProvider,
    type ALQosNormalizationResult
} from '../../al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '../../alm/al-admission-decoder.ts';
import type { ALDeliverySettlementSink } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundRuntimeStores } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundAdmissionStore } from '../../alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundCapturedPolicy } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
    ALOutboundSettledSendResult
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { reconstructALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../../alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { StateScope } from '../../api/state-types.ts';
import { toAppQueueCreatedBy } from '../../queuebox/AppQueueIdentity.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import { JsonWebSocketServer, type ConnectionContext } from '../../websocket/json-web-socket-server.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../queue-box-utilities.ts';
import type { OnWebSocketServerMessageCallback } from '../queue-message-callbacks.ts';
import { decodeWsQueueBoxServerPreparedMessage } from './decode-ws-queue-box-server-prepared-message.ts';
import { toWsQueueBoxServerAddresseeAuthorization } from './to-ws-queue-box-server-addressee-authorization.ts';
import { requiresWsQueueBoxServerRecipientScope } from './requires-ws-queue-box-server-recipient-scope.ts';
import { WsQueueBoxServerClusterPublication } from './ws-queue-box-server-cluster-publication.ts';
import {
    type WsDeliveryDiagnosticsSink,
    type WsOutboxDeliveryOutcome,
    type WsServerInboundAuthorizer,
    type WsServerInboundConnectionScopeReader,
    type WsServerLiveSendInputDto,
    type WsServerLiveSendResult,
    type WsServerTargetResolver
} from './ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerInboundAuthority } from './ws-queue-box-server-inbound-authority.ts';
import { WsQueueBoxServerInboundDelivery } from './ws-queue-box-server-inbound-delivery.ts';
import { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import {
    WsQueueBoxServerOutboundPlanning,
    type WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';
import { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerService {
    export interface Input {
        readonly queueEngine?: InboxOutboxEngine;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly targetResolver?: WsServerTargetResolver;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly dequeueResilience?: ResourceInboxResilience;
        readonly outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
        readonly deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
        readonly validateInboundMessage?: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly readAuthenticatedConnectionScope?:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
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
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider: ALQosInputProvider;
        readonly targetResolver: WsServerTargetResolver;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources<WsQueueBoxServerPreparedMessage>;
        readonly dequeueResilience: ResourceInboxResilience;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundSettlements: ALDeliverySettlementSink | undefined;
        readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
        readonly outboundDeliveryOutcome: ((outcome: WsOutboxDeliveryOutcome) => void) | undefined;
        readonly deliveryDiagnostics: WsDeliveryDiagnosticsSink | undefined;
        readonly validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
        readonly forwardsRoomScopedMessages: boolean;
    }
}

export class WsQueueBoxServerService {
    private static readonly READINESS_RETRY_AFTER_MS = 50;

    public static readonly OUTBOX_ENQUEUE_TYPE = EnqueuedType.WS_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.OUTBOX_ENQUEUE_TYPE
    ]);

    private readonly clusterPublication: WsQueueBoxServerClusterPublication;
    private readonly inboundRuntime: ALInboundMessageRuntime;
    private readonly outboundRuntime: ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage>;
    private readonly admissionStore: WsQueueBoxServerService.Dependencies['outboundRuntime']['admissionStore'];
    private readonly targetResolution: WsQueueBoxServerTargetResolution;
    private readonly liveDelivery: WsQueueBoxServerLiveDelivery;
    private readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    private readonly outboundPlanning: WsQueueBoxServerOutboundPlanning;
    /** Counts relayed receiver ACKs and routes every other control to the server's own outbound owner. */
    private readonly receipts: WsQueueBoxServerReceiptAggregation;
    private readonly inboundAuthority: WsQueueBoxServerInboundAuthority;
    private readonly inboundDelivery: WsQueueBoxServerInboundDelivery;
    private readonly readAuthenticatedConnectionScope:
        WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    private readonly forwardsRoomScopedMessages: boolean;
    private readonly clock: ALOutboundMessageRuntime.Clock;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketServer;
    public readonly name: string;
    private readonly inboundNamespace: string;

    constructor(dependencies: WsQueueBoxServerService.Dependencies) {
        this.clock = dependencies.outboundRuntime.clock;
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.admissionStore = dependencies.outboundRuntime.admissionStore;
        this.socket = dependencies.socket;
        this.name = dependencies.name;
        this.inboundNamespace = dependencies.inboundRuntime.admissionStore.namespace;
        this.targetResolution = new WsQueueBoxServerTargetResolution({
            socket: dependencies.socket,
            targetResolver: dependencies.targetResolver
        });
        this.clusterPublication = new WsQueueBoxServerClusterPublication({
            targetResolution: this.targetResolution,
            canonicalScope: this.admissionStore.canonicalScope,
            clock: this.clock,
            readAdmittedAudience: (msgId) => this.admissionStore.readAdmittedAudience(msgId)
        });
        this.deliveryReporting = new WsQueueBoxServerDeliveryReporting({
            outboundOutcome: dependencies.outboundDeliveryOutcome,
            diagnostics: dependencies.deliveryDiagnostics
        });
        this.readAuthenticatedConnectionScope = dependencies.readAuthenticatedConnectionScope;
        this.forwardsRoomScopedMessages = dependencies.forwardsRoomScopedMessages;
        this.liveDelivery = new WsQueueBoxServerLiveDelivery({
            socket: dependencies.socket,
            targetResolution: this.targetResolution,
            deliveryReporting: this.deliveryReporting,
            readAuthenticatedConnectionScope: this.readAuthenticatedConnectionScope
        });
        this.outboundPlanning = new WsQueueBoxServerOutboundPlanning({
            serverPeerId: dependencies.name,
            qosProvider: dependencies.qosProvider,
            targetResolution: this.targetResolution,
            deliveryReporting: this.deliveryReporting
        });
        this.outboundRuntime = this.createOutboundRuntime(dependencies);
        this.receipts = new WsQueueBoxServerReceiptAggregation({
            serverPeerId: dependencies.name,
            clock: this.clock,
            newControlId: dependencies.inboundRuntime.effectPreparation.newControlId,
            qosProvider: dependencies.qosProvider,
            queueEngine: dependencies.inboundRuntime.queueEngine,
            enqueueOutbox: (message, plan) => this.outboundRuntime.enqueueIfAbsent(message, plan),
            acceptServerControl: (message) => this.outboundRuntime.acceptControlMessage(message, 'peer'),
            acceptServerReceipt: (control) => this.outboundRuntime.acceptReceipt(control)
        });
        this.inboundAuthority = this.createInboundAuthority(dependencies);
        this.inboundDelivery = this.createInboundDelivery(dependencies);
        this.inboundRuntime = this.createInboundRuntime(dependencies);
        this.registerSocketIngress();
    }

    private createInboundAuthority(
        dependencies: WsQueueBoxServerService.Dependencies
    ): WsQueueBoxServerInboundAuthority {
        return new WsQueueBoxServerInboundAuthority({
            socket: this.socket,
            serverPeerId: this.name,
            clock: this.clock,
            newControlId: dependencies.inboundRuntime.effectPreparation.newControlId,
            targetResolution: this.targetResolution,
            liveDelivery: this.liveDelivery,
            receipts: this.receipts,
            validateInboundMessage: dependencies.validateInboundMessage,
            readAuthenticatedConnectionScope: this.readAuthenticatedConnectionScope
        });
    }

    private createInboundDelivery(
        dependencies: WsQueueBoxServerService.Dependencies
    ): WsQueueBoxServerInboundDelivery {
        return new WsQueueBoxServerInboundDelivery({
            socket: this.socket,
            serverPeerId: this.name,
            clock: this.clock,
            queueEngine: dependencies.inboundRuntime.queueEngine,
            qosProvider: dependencies.qosProvider,
            targetResolution: this.targetResolution,
            liveDelivery: this.liveDelivery,
            authority: this.inboundAuthority,
            routerOwnsRoomFanout: !this.forwardsRoomScopedMessages
        });
    }

    private createOutboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage> {
        return new ALOutboundMessageRuntime<WsQueueBoxServerPreparedMessage>({
            decodePreparedMessage: decodeWsQueueBoxServerPreparedMessage,
            ...dependencies.outboundRuntime,
            carrier: 'ws',
            dequeue: {
                types: WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                resilience: dependencies.dequeueResilience
            },
            diagnostics: dependencies.outboundDiagnostics,
            settlements: dependencies.outboundSettlements,
            toOutboxEntry: createWsQueueBoxServerOutboxEntry,
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: (message, admittedAudience, recipientScope) =>
                this.outboundPlanning.planOutboundMessage({
                    message,
                    phase: 'immediate',
                    clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
                    admittedAudience,
                    recipientScope
                }),
            planDequeuedMessage: (message, admittedAudience, recipientScope) =>
                this.outboundPlanning.planOutboundMessage({
                    message,
                    phase: 'dequeue',
                    clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
                    admittedAudience,
                    recipientScope
                }),
            afterDequeueAdmission: (message, entry) => this.clusterPublication.writeDequeuedRow(message, entry),
            sendPreparedMessage: async (prepared, _phase, lifecycle) =>
                await this.sendPreparedMessage(prepared, lifecycle),
            planRepairMessage: (message, request) =>
                Promise.resolve(this.outboundPlanning.planRepairMessage(message, request))
        });
    }

    private createInboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime({
            ...dependencies.inboundRuntime,
            carrier: 'ws',
            readPendingAdmissionAuthority: (message, source) =>
                this.inboundAuthority.readPendingAdmissionAuthority(message, source),
            planIncomingMessage: (message, fromPeerId, runtime) =>
                this.inboundDelivery.planIncomingMessage(message, fromPeerId, runtime),
            canDispatchMessage: (message) => this.inboundDelivery.hasInboxConsumer(message),
            dispatchInboxEntry: (entry, plan, source) => this.inboundDelivery.dispatchInboxEntry(entry, plan, source),
            sendControlMessages: (messages) => this.inboundAuthority.sendControlMessages(messages),
            onControlMessage: async (message) => {
                await this.receipts.acceptControlMessage(message);
            },
            readRelayedAckRejection: (ack) => this.receipts.readRelayedAckRejection(ack),
            forwardMessage: (input) => this.inboundDelivery.forwardIncomingMessage(input),
            canForwardMessage: (message) => this.forwardsRoomScopedMessages || !isRoomScopedALMessage(message),
            diagnostics: dependencies.inboundDiagnostics
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
        this.inboundAuthority.dispose();
        this.socket.removeOnMessageCallbackById(this.name);
        this.inboundRuntime.dispose();
        this.receipts.dispose();
        this.outboundRuntime.dispose();
        this.inboundDelivery.dispose();
    }

    authorizeInboundMessagesWith(authorizer: WsServerInboundAuthorizer): void {
        this.inboundAuthority.authorizeInboundMessagesWith(authorizer);
    }

    onOutboxClusterPublishDo(publisher: WsQueueBoxServerClusterPublication.Publisher): WsQueueBoxServerService {
        this.clusterPublication.setPublisher(publisher);
        return this;
    }

    onAllInboxMessagesDo(
        callback: OnWebSocketServerMessageCallback<ALMessage>,
        forceUpdate: boolean = false
    ): WsQueueBoxServerService {
        this.inboundDelivery.onAllInboxMessagesDo(callback, forceUpdate);
        return this;
    }

    onAnyInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): WsQueueBoxServerService {
        this.inboundDelivery.onAnyInboxMessageDo(id, callback);
        return this;
    }

    onInboxMessageDo(
        id: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): WsQueueBoxServerService {
        this.inboundDelivery.onInboxMessageDo(id, callback);
        return this;
    }

    removeInboxMessageCallback(id: string): boolean {
        return this.inboundDelivery.removeInboxMessageCallback(id);
    }

    removeAnyInboxMessageCallback(id: string): boolean {
        return this.inboundDelivery.removeAnyInboxMessageCallback(id);
    }

    resolveOutboundPolicy(message: ALMessage): ALQosNormalizationResult {
        return this.outboundPlanning.resolvePolicy(message);
    }

    getInboundNamespace(): string {
        return this.inboundNamespace;
    }

    /**
     * `admittedAudience` is the room audience a router admitted the message to. It travels with the
     * outbound row, never on the wire, and narrows every later plan of the message to that audience.
     */
    async enqueueOutboxIfAbsent(
        message: ALMessage,
        admittedAudience?: readonly string[],
        recipientScope?: StateScope
    ): Promise<ALOutboundEnqueueResult> {
        const dispatchPlan = this.outboundPlanning.planOutboundMessage({
            message,
            phase: 'immediate',
            clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
            admittedAudience,
            recipientScope
        });
        const outgoingMessage = dispatchPlan.persist
            ? decodePersistedALMessageValue(message)
            : message;

        const result = await this.outboundRuntime.enqueueIfAbsent(
            outgoingMessage,
            dispatchPlan
        );
        if (
            result.verdict.kind === 'unroutable' && result.verdict.reason === 'no-route' &&
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

    async acceptIncomingMessage(
        value: unknown,
        connectionId: string
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const decision = await this.inboundAuthority.readSocketAdmission(decodeALMessageValue(value), connectionId);
        if (decision.kind === 'finished') {
            return decision.result;
        }
        const current = this.inboundAuthority.resolveAuthorizedSocketAdmission(decision.value, connectionId);
        if (current.kind === 'finished') {
            return current.result;
        }
        return await this.admitAuthorizedMessage(current.value);
    }

    private async admitAuthorizedMessage(
        input: WsQueueBoxServerInboundAuthority.AuthorizedMessage
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const { message, fromPeerId, authorization, proof } = input;
        const admitted = await this.inboundRuntime.admitIncomingMessage(message, {
            kind: 'ws-client',
            peerId: fromPeerId,
            authenticatedScope: { applicationId: proof.scope.applicationId, workspaceId: proof.scope.workspaceId },
            ...(authorization.roomAudience === undefined
                ? {}
                : { groupRecipientPeerIds: [...authorization.roomAudience.recipientPeerIds] })
        });
        // The admission's delivery runs on a later work batch, so the aggregate exists before any recipient can ACK.
        await this.receipts.writeAdmittedReceipt({
            message,
            originPeerId: fromPeerId,
            roomAudience: authorization.roomAudience,
            acceptance: admitted.right
        });
        return admitted;
    }

    sendToTargets(message: ALMessage): number {
        return this.liveDelivery.sendToTargets(message);
    }

    async readCapturedPolicy(message: ALMessage, entry: ResourceEntry): Promise<ALOutboundCapturedPolicy> {
        const policy = await this.admissionStore.readCapturedPolicy(message, entry);
        if (requiresWsQueueBoxServerRecipientScope(message) && policy.recipientScope === undefined) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(entry.key),
                new TypeError('Persisted public WS unicast has no recipient scope')
            );
        }
        return policy;
    }

    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult {
        return this.liveDelivery.sendToTargetsWithResult(input);
    }

    readAdmittedAudience(msgId: string): Promise<readonly string[] | undefined> {
        return this.admissionStore.readAdmittedAudience(msgId);
    }

    private async sendPreparedMessage(
        prepared: WsQueueBoxServerPreparedMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        if (prepared.kind !== 'recipient' && prepared.kind !== 'scoped-recipient') {
            return await this.clusterPublication.writePreparedMessage(prepared, lifecycle);
        }
        return await this.sendPreparedRecipient(prepared, lifecycle);
    }

    private async sendPreparedRecipient(
        prepared: Extract<WsQueueBoxServerPreparedMessage, { kind: 'recipient' | 'scoped-recipient'; }>,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        const message = reconstructALOutboundTransportMessage(prepared.message, lifecycle.canonicalMessage);
        if (lifecycle.signal.aborted) {
            return { status: 'cancelled', submissionAttempted: false };
        }
        if (this.clock.nowMs() >= (lifecycle.expiresAtMs ?? 0)) {
            return { status: 'expired', submissionAttempted: false };
        }
        try {
            const encoded = this.socket.encode(message);
            if (!this.socket.connections.get(prepared.connectionId)?.isOpen) {
                return {
                    status: 'not-ready',
                    submissionAttempted: false,
                    retryAfterMs: WsQueueBoxServerService.READINESS_RETRY_AFTER_MS,
                    reason: 'WS connection is not open before native submission'
                };
            }
            if (prepared.kind === 'scoped-recipient' && !this.isCurrentScopedRecipient(prepared)) {
                return { status: 'no-targets', submissionAttempted: false };
            }
            this.socket.sendEncoded(prepared.connectionId, encoded);
            this.recordPreparedRecipientSent(message, encoded.text.length);
            return { status: 'sent', submissionAttempted: true };
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            this.deliveryReporting.recordOutcome({
                status: 'retryable-transport-failure',
                messageId: message.id.msgId,
                reason: runtimeError.message
            });
            throw runtimeError;
        }
    }

    private recordPreparedRecipientSent(message: ALMessage, payloadBytes: number): void {
        this.deliveryReporting.recordOutcome({ status: 'sent', messageId: message.id.msgId });
        this.deliveryReporting.recordDiagnostics({
            kind: 'outbox-send',
            topicId: message.route.topicId,
            payloadBytes
        });
    }

    private isCurrentScopedRecipient(
        prepared: Extract<WsQueueBoxServerPreparedMessage, { kind: 'scoped-recipient'; }>
    ): boolean {
        const connection = this.socket.connections.get(prepared.connectionId);
        if (!connection?.isOpen || connection.generationId !== prepared.generationId) {
            return false;
        }
        const proof = this.readAuthenticatedConnectionScope(connection);
        return proof !== undefined && proof.expiresAtEpochMs > this.clock.nowMs() &&
            proof.scope.applicationId === prepared.recipientScope.applicationId &&
            proof.scope.workspaceId === prepared.recipientScope.workspaceId;
    }
}

export function createDefaultWsQueueBoxServerService(input: WsQueueBoxServerService.Input): WsQueueBoxServerService {
    return new WsQueueBoxServerService({
        socket: input.socket,
        name: input.name,
        qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, input.qosProvider),
        targetResolver: input.targetResolver ?? {},
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            queueEngine: input.queueEngine,
            selfPeerId: input.name,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX)
        }),
        outboundRuntime: createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            canonicalQueue: input.outbox,
            stores: input.outboundStores,
            queueEngine: input.queueEngine
        }),
        dequeueResilience: input.dequeueResilience ?? createDefaultALOutboundDequeueResilience(),
        outboundDiagnostics: input.outboundDiagnostics,
        outboundSettlements: input.outboundSettlements,
        inboundDiagnostics: input.inboundDiagnostics,
        outboundDeliveryOutcome: input.outboundDeliveryOutcome,
        deliveryDiagnostics: input.deliveryDiagnostics,
        validateInboundMessage: input.validateInboundMessage ?? Either.ofRight,
        readAuthenticatedConnectionScope: input.readAuthenticatedConnectionScope ?? (() => undefined),
        forwardsRoomScopedMessages: input.forwardsRoomScopedMessages ?? true
    });
}

function createWsQueueBoxServerOutboxEntry(message: ALMessage): ResourceEntry {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE);
    return {
        ...entry,
        audit: { ...entry.audit, createdBy: toAppQueueCreatedBy(entry.audit.createdBy) }
    };
}
