import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '../../al-contracts/al-carrier-capabilities.ts';
import { isRoomScopedALMessage, readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
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
import { isALWorldBroadcast } from '../../al-contracts/is-al-world-broadcast.ts';
import type { ALDeliverySettlementSink } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundRuntimeStores } from '../../alm/inbound/al-inbound-message-runtime.ts';
import { ALInboundMessageRuntime } from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundCapturedPolicy } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
    ALOutboundSettledSendResult
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundMessageRuntime } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundReceiptFacts } from '../../alm/outbound/lane/al-outbound-receipt-observation.ts';
import { reconstructALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../../alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import { JsonWebSocketServer, type ConnectionContext } from '../../websocket/json-web-socket-server.ts';
import type { InboxOutboxEngine } from '../InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../queue-box-utilities.ts';
import type { OnWebSocketServerMessageCallback } from '../queue-message-callbacks.ts';
import { decodeWsQueueBoxServerPreparedMessage } from './decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerAckRelay, type WsServerAckRelayPublisher } from './ws-queue-box-server-ack-relay.ts';
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
import { WsQueueBoxServerControlDelivery } from './ws-queue-box-server-control-delivery.ts';
import { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import {
    WsQueueBoxServerDequeueAuthority,
    type WsOutboxProducerProvenanceReader
} from './ws-queue-box-server-dequeue-authority.ts';
import { WsQueueBoxServerInboundAuthority } from './ws-queue-box-server-inbound-authority.ts';
import { WsQueueBoxServerInboundDelivery } from './ws-queue-box-server-inbound-delivery.ts';
import { WsQueueBoxServerLiveDelivery } from './ws-queue-box-server-live-delivery.ts';
import {
    WsQueueBoxServerOutboundPlanning,
    type WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    toWsQueueBoxServerReceiptAckFacts,
    type WsQueueBoxServerReceiptAckFacts,
    type WsQueueBoxServerReceiptObserver,
    type WsQueueBoxServerReceiptSocketFacts
} from './ws-queue-box-server-receipt-observation.ts';
import { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

interface WsQueueBoxServerPreparedRecipientInput {
    readonly prepared: Extract<
        WsQueueBoxServerPreparedMessage,
        { kind: 'recipient' | 'scoped-recipient' | 'room-recipient' | 'invalidated-session'; }
    >;
    readonly lifecycle: ALOutboundMessageRuntime.SendLifecycle;
    readonly message: ALMessage;
    readonly transport: JsonWebSocketServer.SendEvidence | undefined;
}

interface WsQueueBoxServerLiveDeliveryOwners {
    readonly targetResolution: WsQueueBoxServerTargetResolution;
    readonly clusterPublication: WsQueueBoxServerClusterPublication;
    readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    readonly liveDelivery: WsQueueBoxServerLiveDelivery;
}

interface WsQueueBoxServerReceiptRouting {
    readonly receipts: WsQueueBoxServerReceiptAggregation;
    readonly ackRelay: WsQueueBoxServerAckRelay;
    readonly controlDelivery: WsQueueBoxServerControlDelivery;
}

export namespace WsQueueBoxServerService {
    export interface Input {
        readonly queueEngine?: InboxOutboxEngine;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly targetResolver?: WsServerTargetResolver;
        readonly readProducerProvenance?: WsOutboxProducerProvenanceReader;
        readonly inboundStores?: ALInboundRuntimeStores;
        readonly outboundStores?: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
        readonly dequeueResilience?: ResourceInboxResilience;
        readonly outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
        readonly deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
        readonly validateInboundMessage?: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        /** A connection it proves no current scope for has every AL frame refused. */
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
        /** Absent on a single instance: an ACK no aggregate here counts is then refused at ingress. */
        readonly publishRelayedAck?: WsServerAckRelayPublisher;
        /**
         * Whether inbound ALM forwarding relays room-scoped messages and world broadcasts (default
         * true, the standalone service contract). A composition that installs a
         * topic router with a room authorizer must pass false: the router owns
         * that fanout behind its authorization and the topic's fanout, and relaying here would
         * deliver messages the authorizer rejects or the topic does not fan out
         * (and double-deliver the ones it accepts).
         */
        readonly forwardsRoomScopedMessages?: boolean;
    }

    export interface SocketObservation {
        readonly ackFacts: WsQueueBoxServerReceiptAckFacts | undefined;
        readonly connectionId: string;
        readonly result: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>;
        readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
    }

    export interface EnqueueAuthority {
        /**
         * The room audience a router admitted the message to. It travels with the outbound row, never on
         * the wire, and narrows every later plan of the message to that audience.
         */
        readonly admittedAudience: readonly string[] | undefined;
        /** The scope a producer proved for a unicast that names no group. */
        readonly recipientScope: StateScope | undefined;
    }

    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider: ALQosInputProvider;
        readonly targetResolver: WsServerTargetResolver;
        readonly readProducerProvenance: WsOutboxProducerProvenanceReader | undefined;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources<WsQueueBoxServerPreparedMessage>;
        readonly dequeueResilience: ResourceInboxResilience;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundSettlements: ALDeliverySettlementSink | undefined;
        readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
        readonly outboundDeliveryOutcome: ((outcome: WsOutboxDeliveryOutcome) => void) | undefined;
        readonly deliveryDiagnostics: WsDeliveryDiagnosticsSink | undefined;
        readonly validateInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
        readonly readAuthenticatedConnectionScope:
            WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
        readonly publishRelayedAck: WsServerAckRelayPublisher | undefined;
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
    private readonly dequeueAuthority: WsQueueBoxServerDequeueAuthority;
    private readonly targetResolution: WsQueueBoxServerTargetResolution;
    private readonly liveDelivery: WsQueueBoxServerLiveDelivery;
    private readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    private readonly outboundPlanning: WsQueueBoxServerOutboundPlanning;
    /** Counts relayed receiver ACKs and routes every other control to the server's own outbound owner. */
    private readonly receipts: WsQueueBoxServerReceiptAggregation;
    private readonly ackRelay: WsQueueBoxServerAckRelay;
    private readonly controlDelivery: WsQueueBoxServerControlDelivery;
    private readonly inboundAuthority: WsQueueBoxServerInboundAuthority;
    private readonly inboundDelivery: WsQueueBoxServerInboundDelivery;
    private readonly readAuthenticatedConnectionScope:
        WsServerInboundConnectionScopeReader['readAuthenticatedConnectionScope'];
    private readonly forwardsRoomScopedMessages: boolean;
    private readonly clock: ALOutboundMessageRuntime.Clock;
    private readonly receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketServer;
    public readonly name: string;
    private readonly inboundNamespace: string;

    constructor(dependencies: WsQueueBoxServerService.Dependencies) {
        this.clock = dependencies.outboundRuntime.clock;
        this.receiptObserver = dependencies.receiptObserver;
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.admissionStore = dependencies.outboundRuntime.admissionStore;
        this.socket = dependencies.socket;
        this.name = dependencies.name;
        this.inboundNamespace = dependencies.inboundRuntime.admissionStore.namespace;
        this.readAuthenticatedConnectionScope = dependencies.readAuthenticatedConnectionScope;
        this.forwardsRoomScopedMessages = dependencies.forwardsRoomScopedMessages;
        const liveDeliveryOwners = this.createLiveDeliveryOwners(dependencies);
        this.targetResolution = liveDeliveryOwners.targetResolution;
        this.clusterPublication = liveDeliveryOwners.clusterPublication;
        this.deliveryReporting = liveDeliveryOwners.deliveryReporting;
        this.liveDelivery = liveDeliveryOwners.liveDelivery;
        this.outboundPlanning = new WsQueueBoxServerOutboundPlanning({
            serverPeerId: dependencies.name,
            qosProvider: dependencies.qosProvider,
            targetResolution: this.targetResolution,
            deliveryReporting: this.deliveryReporting
        });
        this.dequeueAuthority = new WsQueueBoxServerDequeueAuthority({
            admissionStore: this.admissionStore,
            outbox: this.outbox,
            readProducerProvenance: dependencies.readProducerProvenance
        });
        this.outboundRuntime = this.createOutboundRuntime(dependencies);
        const receiptRouting = this.createReceiptRouting(dependencies);
        this.receipts = receiptRouting.receipts;
        this.ackRelay = receiptRouting.ackRelay;
        this.controlDelivery = receiptRouting.controlDelivery;
        this.inboundAuthority = this.createInboundAuthority(dependencies);
        this.inboundDelivery = this.createInboundDelivery(dependencies);
        this.inboundRuntime = this.createInboundRuntime(dependencies);
        this.registerSocketIngress();
    }

    private createLiveDeliveryOwners(
        dependencies: WsQueueBoxServerService.Dependencies
    ): WsQueueBoxServerLiveDeliveryOwners {
        const targetResolution = new WsQueueBoxServerTargetResolution({
            socket: dependencies.socket,
            targetResolver: dependencies.targetResolver
        });
        const clusterPublication = new WsQueueBoxServerClusterPublication({
            targetResolution,
            canonicalScope: this.admissionStore.canonicalScope,
            clock: this.clock,
            receiptObserver: this.receiptObserver,
            serverPeerId: this.name
        });
        const deliveryReporting = new WsQueueBoxServerDeliveryReporting({
            outboundOutcome: dependencies.outboundDeliveryOutcome,
            diagnostics: dependencies.deliveryDiagnostics
        });
        const liveDelivery = new WsQueueBoxServerLiveDelivery({
            socket: dependencies.socket,
            clock: this.clock,
            targetResolution,
            deliveryReporting,
            readAuthenticatedConnectionScope: this.readAuthenticatedConnectionScope
        });
        return { targetResolution, clusterPublication, deliveryReporting, liveDelivery };
    }

    private createReceiptRouting(dependencies: WsQueueBoxServerService.Dependencies): WsQueueBoxServerReceiptRouting {
        const receipts = new WsQueueBoxServerReceiptAggregation({
            serverPeerId: dependencies.name,
            receiptObserver: this.receiptObserver,
            clock: this.clock,
            newControlId: dependencies.inboundRuntime.effectPreparation.newControlId,
            qosProvider: dependencies.qosProvider,
            queueEngine: dependencies.inboundRuntime.queueEngine,
            enqueueOutbox: (message, plan) => this.outboundRuntime.enqueueIfAbsent(message, plan),
            acceptServerControl: (message) => this.outboundRuntime.acceptControlMessage(message, 'peer'),
            acceptServerReceipt: (control) => this.outboundRuntime.acceptReceipt(control)
        });
        const ackRelay = new WsQueueBoxServerAckRelay({
            serverPeerId: dependencies.name,
            clock: this.clock,
            readIngressAudience: (msgId, originPeerId) =>
                dependencies.inboundRuntime.admissionStore.readIngressAudience(msgId, originPeerId),
            receipts,
            publishRelayedAck: dependencies.publishRelayedAck,
            receiptObserver: this.receiptObserver
        });
        const controlDelivery = new WsQueueBoxServerControlDelivery({
            clock: this.clock,
            liveDelivery: this.liveDelivery,
            clusterPublication: this.clusterPublication,
            outbound: this.outboundRuntime
        });
        return { receipts, ackRelay, controlDelivery };
    }

    private createInboundAuthority(
        dependencies: WsQueueBoxServerService.Dependencies
    ): WsQueueBoxServerInboundAuthority {
        return new WsQueueBoxServerInboundAuthority({
            observesReceipts: this.receiptObserver !== undefined,
            socket: this.socket,
            serverPeerId: this.name,
            clock: this.clock,
            newControlId: dependencies.inboundRuntime.effectPreparation.newControlId,
            targetResolution: this.targetResolution,
            controlDelivery: this.controlDelivery,
            ackRelay: this.ackRelay,
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
            receiptWorkObserver: this.receiptObserver === undefined
                ? undefined
                : (observation) =>
                    recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
                        ...observation,
                        serverPeerId: this.name
                    }),
            settlements: dependencies.outboundSettlements,
            toOutboxEntry: (message: ALMessage) =>
                QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            readDequeueAuthority: (message, entry) => this.dequeueAuthority.readDequeueAuthority(message, entry),
            planOutgoingMessage: (message, authority) =>
                this.outboundPlanning.planOutboundMessage({
                    message,
                    phase: 'immediate',
                    clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
                    admittedAudience: authority?.admittedAudience,
                    recipientScope: authority?.recipientScope,
                    principalTargetId: authority?.principalTargetId,
                    sessionInvalidation: authority?.sessionInvalidation,
                    referenceKey: authority?.referenceKey
                }),
            planDequeuedMessage: (message, authority) =>
                this.outboundPlanning.planOutboundMessage({
                    message,
                    phase: 'dequeue',
                    clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
                    admittedAudience: authority?.admittedAudience,
                    recipientScope: authority?.recipientScope,
                    principalTargetId: authority?.principalTargetId,
                    sessionInvalidation: authority?.sessionInvalidation,
                    referenceKey: authority?.referenceKey
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
            sendControlMessages: (messages) => this.controlDelivery.sendControlMessages(messages),
            onControlMessage: async (message) => {
                await this.receipts.acceptControlMessage(message);
            },
            readRelayedAckRejection: (ack) => this.ackRelay.readRelayedAckRejection(ack),
            forwardMessage: (input) => this.inboundDelivery.forwardIncomingMessage(input),
            canForwardMessage: (message) =>
                this.forwardsRoomScopedMessages || (!isRoomScopedALMessage(message) && !isALWorldBroadcast(message)),
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

    /** Without an authority the message is the server's own, addressed by its wire targets alone. */
    async enqueueOutboxIfAbsent(
        message: ALMessage,
        authority?: WsQueueBoxServerService.EnqueueAuthority
    ): Promise<ALOutboundEnqueueResult> {
        const dispatchPlan = this.outboundPlanning.planOutboundMessage({
            message,
            phase: 'immediate',
            clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
            admittedAudience: authority?.admittedAudience,
            recipientScope: authority?.recipientScope
        });
        const outgoingMessage = dispatchPlan.lane !== 'volatile'
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
        const decoded = decodeALMessageValue(value);
        const ackFacts = this.receiptObserver && decoded.right
            ? toWsQueueBoxServerReceiptAckFacts(decoded.right)
            : undefined;
        const decision = await this.inboundAuthority.readSocketAdmission(decoded, connectionId);
        if (decision.kind === 'finished') {
            return ackFacts === undefined ? decision.result : this.recordSocketDecision({
                ackFacts,
                connectionId,
                result: decision.result,
                socketFacts: decision.socketFacts
            });
        }
        if (decision.kind === 'retain') {
            const result = Either.ofRight<ALMessageRejection, ALInboundMessageRuntime.Acceptance>(
                await this.inboundRuntime.retainIncomingMessage(decision.message, decision.source)
            );
            return ackFacts === undefined
                ? result
                : this.recordSocketDecision({ ackFacts, connectionId, result, socketFacts: decision.socketFacts });
        }
        const current = this.inboundAuthority.resolveAuthorizedSocketAdmission(decision.value, connectionId);
        if (current.kind === 'refused') {
            const result = await this.inboundAuthority.rejectIncomingMessage(current.message, current.refusal);
            return ackFacts === undefined
                ? result
                : this.recordSocketDecision({ ackFacts, connectionId, result, socketFacts: current.socketFacts });
        }
        if (current.kind === 'finished') {
            return ackFacts === undefined ? current.result : this.recordSocketDecision({
                ackFacts,
                connectionId,
                result: current.result,
                socketFacts: current.socketFacts
            });
        }
        const result = await this.admitAuthorizedMessage(current.value);
        return ackFacts === undefined
            ? result
            : this.recordSocketDecision({ ackFacts, connectionId, result, socketFacts: current.value.socketFacts });
    }

    private recordSocketDecision(
        observation: WsQueueBoxServerService.SocketObservation
    ): Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance> {
        const outcome = observation.result.left !== undefined ? 'rejected' : observation.result.right?.kind;
        if (observation.ackFacts !== undefined && outcome !== undefined) {
            recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
                ...observation.ackFacts,
                kind: 'socket-decision',
                serverPeerId: this.name,
                connectionId: observation.connectionId,
                fromPeerId: observation.socketFacts?.fromPeerId,
                authenticatedScope: observation.socketFacts?.authenticatedScope,
                scopeDisposition: observation.socketFacts?.scopeDisposition ?? 'unobserved',
                scopeAtEpochMs: observation.socketFacts?.scopeAtEpochMs,
                outcome,
                rejectionCode: observation.result.left?.code,
                handled: observation.result.right?.kind === 'control' ? observation.result.right.handled : undefined
            });
        }
        return observation.result;
    }

    private async admitAuthorizedMessage(
        input: WsQueueBoxServerInboundAuthority.AuthorizedMessage
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const { message, fromPeerId, authorization, proof } = input;
        const relayed = await this.ackRelay.relayUnownedAck(message);
        if (relayed.left !== undefined) {
            return Either.ofLeft(relayed.left);
        }
        if (relayed.right) {
            return Either.ofRight({ kind: 'control', handled: false });
        }
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

    /** A receiver ACK another instance handed over: counted here only against this instance's aggregate. */
    async acceptRelayedAck(message: ALMessage, relayPublisherId?: string): Promise<void> {
        await this.ackRelay.acceptRelayedAck(message, relayPublisherId);
    }

    sendToTargets(message: ALMessage): number {
        return this.liveDelivery.sendToTargets(message);
    }

    async readCapturedPolicy(message: ALMessage, entry: ResourceEntry): Promise<ALOutboundCapturedPolicy> {
        return await this.dequeueAuthority.readCapturedPolicy(message, entry);
    }

    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult {
        return this.liveDelivery.sendToTargetsWithResult(input);
    }

    private async sendPreparedMessage(
        prepared: WsQueueBoxServerPreparedMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        if (
            prepared.kind !== 'recipient' && prepared.kind !== 'scoped-recipient' &&
            prepared.kind !== 'room-recipient' && prepared.kind !== 'invalidated-session'
        ) {
            return await this.clusterPublication.writePreparedMessage(prepared, lifecycle);
        }
        return await this.sendPreparedRecipient(prepared, lifecycle);
    }

    private async sendPreparedRecipient(
        prepared: Extract<
            WsQueueBoxServerPreparedMessage,
            { kind: 'recipient' | 'scoped-recipient' | 'room-recipient' | 'invalidated-session'; }
        >,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundSettledSendResult> {
        const message = reconstructALOutboundTransportMessage(prepared.message, lifecycle.canonicalMessage);
        const facts = this.receiptObserver === undefined ? undefined : toALOutboundReceiptFacts(message);
        const transport: JsonWebSocketServer.SendEvidence | undefined = facts === undefined
            ? undefined
            : { nativeCall: 'not-called' };
        let result: ALOutboundSettledSendResult | undefined;
        try {
            result = this.writePreparedRecipient({ prepared, lifecycle, message, transport });
            return result;
        }
        finally {
            if (facts !== undefined && transport !== undefined) {
                recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
                    ...facts,
                    kind: 'receipt-transport',
                    serverPeerId: this.name,
                    transport: 'recipient',
                    nativeCall: transport.nativeCall,
                    connectionId: prepared.connectionId,
                    publisherCall: 'absent',
                    originIsHere: undefined,
                    outcome: result?.status ?? 'threw',
                    submissionAttempted: result?.submissionAttempted,
                    retryAfterMs: result?.retryAfterMs
                }, lifecycle.deferReceiptObservation);
            }
        }
    }

    private writePreparedRecipient(
        { prepared, lifecycle, message, transport }: WsQueueBoxServerPreparedRecipientInput
    ): ALOutboundSettledSendResult {
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
            if (
                (prepared.kind === 'scoped-recipient' || prepared.kind === 'room-recipient') &&
                !this.isCurrentScopedRecipient(prepared, message)
            ) {
                return { status: 'no-targets', submissionAttempted: false };
            }
            if (
                prepared.kind === 'invalidated-session' &&
                (prepared.connectionId !== prepared.sessionInvalidation.sessionId ||
                    this.socket.connections.get(prepared.connectionId)?.generationId !== prepared.generationId)
            ) {
                return { status: 'no-targets', submissionAttempted: false };
            }
            this.socket.sendEncoded(prepared.connectionId, encoded, transport);
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
        prepared: Extract<WsQueueBoxServerPreparedMessage, { kind: 'scoped-recipient' | 'room-recipient'; }>,
        message: ALMessage
    ): boolean {
        const connection = this.socket.connections.get(prepared.connectionId);
        if (!connection?.isOpen || connection.generationId !== prepared.generationId) {
            return false;
        }
        const scope = prepared.kind === 'scoped-recipient' ? prepared.recipientScope : readALTargetGroupRef(message);
        const principalTargetId = prepared.kind === 'scoped-recipient' ? prepared.principalTargetId : undefined;
        const proof = this.readAuthenticatedConnectionScope(connection);
        return scope !== undefined && proof !== undefined && proof.expiresAtEpochMs > this.clock.nowMs() &&
            proof.scope.applicationId === scope.applicationId &&
            proof.scope.workspaceId === scope.workspaceId &&
            (principalTargetId === undefined || proof.principalId === principalTargetId);
    }
}

export function createDefaultWsQueueBoxServerService(input: WsQueueBoxServerService.Input): WsQueueBoxServerService {
    return new WsQueueBoxServerService({
        socket: input.socket,
        name: input.name,
        qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, input.qosProvider),
        targetResolver: input.targetResolver ?? {},
        readProducerProvenance: input.readProducerProvenance,
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
        receiptObserver: input.receiptObserver,
        outboundDeliveryOutcome: input.outboundDeliveryOutcome,
        deliveryDiagnostics: input.deliveryDiagnostics,
        validateInboundMessage: input.validateInboundMessage ?? Either.ofRight,
        readAuthenticatedConnectionScope: input.readAuthenticatedConnectionScope,
        publishRelayedAck: input.publishRelayedAck,
        forwardsRoomScopedMessages: input.forwardsRoomScopedMessages ?? true
    });
}
