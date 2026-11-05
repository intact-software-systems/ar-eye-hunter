import { Temporal } from '@js-temporal/polyfill';

import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '../../al-contracts/al-carrier-capabilities.ts';
import {
    isRoomScopedALMessage,
    readALTargetGroupRef,
    type ALMessage
} from '../../al-contracts/al-contract.ts';
import type { ALAckPayload, ALNackPayload, ALRepairPayload } from '../../al-contracts/al-control.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessageRow,
    decodePersistedALMessageValue,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import {
    type ALQosInputProvider,
    type ALQosNormalizationResult
} from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { isALWorldBroadcast } from '../../al-contracts/is-al-world-broadcast.ts';
import { isALLogicalReceiptMode } from '../../al-contracts/validate-al-ack-support.ts';
import type { ALDeliverySettlementSink } from '../../alm/delivery/al-delivery-lifecycle.ts';
import {
    ALInboundMessageRuntime,
    type ALInboundRuntimeStores,
    type ALVolatileInboundRuntimeStores
} from '../../alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../../alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '../../alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { ALOutboundPlanningAuthority } from '../../alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundCapturedPolicy } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    ALOutboundMessageRuntime,
    type ALOutboundDispatchPlan,
    type ALOutboundEnqueueResult,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundRuntimeStores,
    type ALOutboundSettledSendResult
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import { reconstructALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '../../alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALOutboundDequeuedAdmission } from '../../alm/outbound/lane/al-outbound-dequeued-admission.ts';
import {
    createALOutboundReceiptWorkEvidence,
    toALOutboundReceiptFacts
} from '../../alm/outbound/lane/al-outbound-receipt-observation.ts';
import {
    isALOrderingPredecessorInBatch,
    type ALOrderingBatchSequences
} from '../../alm/outbound/lane/compute-al-outbound-group-sent-positions.ts';
import { ALWorkBatchObservations } from '../../alm/work/al-work-batch-observations.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import { ExclusionKeyedAdmission } from '../../resilience/exclusion-keyed-admission.ts';
import { toError } from '../../resilience/to-error.ts';
import { JsonWebSocketServer, type ConnectionContext } from '../../websocket/json-web-socket-server.ts';
import type { InboxOutboxEngine } from '../inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '../queue-box-utilities.ts';
import type { OnWebSocketServerMessageCallback } from '../queue-message-callbacks.ts';
import { decodeWsQueueBoxServerPreparedMessage } from './decode-ws-queue-box-server-prepared-message.ts';
import {
    toWsQueueBoxServerCapturedSendInput,
    toWsQueueBoxServerHeldSessionPolicy
} from './scope/to-ws-queue-box-server-captured-send-input.ts';
import { toWsQueueBoxServerOutsideAudienceAck } from './scope/to-ws-queue-box-server-outside-audience-ack.ts';
import { toWsQueueBoxServerRecipientCopy } from './scope/to-ws-queue-box-server-recipient-copy.ts';
import { WsQueueBoxServerAckRelay, type WsServerAckRelayPublisher } from './ws-queue-box-server-ack-relay.ts';
import { WsQueueBoxServerClusterPublication } from './ws-queue-box-server-cluster-publication.ts';
import {
    type WsCapturedRecipientEligibilityFilter,
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
    isWsQueueBoxServerUnrecordedRow,
    WsQueueBoxServerOutboundPlanning,
    type WsQueueBoxServerOutboundPhase,
    type WsQueueBoxServerPreparedMessage
} from './ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerReceiptAggregation } from './ws-queue-box-server-receipt-aggregation.ts';
import {
    recordWsQueueBoxServerReceiptObservation,
    toWsQueueBoxServerReceiptAckFacts,
    toWsQueueBoxServerReceiptBusinessFacts,
    type WsQueueBoxServerReceiptAckFacts,
    type WsQueueBoxServerReceiptBusinessFacts,
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
        readonly creationNow?: QueueBoxUtilities.CreationClock;
        readonly queueEngine?: InboxOutboxEngine;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider?: ALQosInputProvider;
        readonly targetResolver?: WsServerTargetResolver;
        readonly readProducerProvenance?: WsOutboxProducerProvenanceReader;
        /** Re-checks a frozen-audience row's captured sessions at each dequeue, repair and awaited send (D498). */
        readonly filterEligibleCapturedSessionIds?: WsCapturedRecipientEligibilityFilter;
        readonly inboundStores?: ALInboundRuntimeStores;
        /** The memory pair a volatile message is admitted and delivered from; `undefined`, every message takes `inboundStores`. */
        readonly inboundVolatileStores: ALVolatileInboundRuntimeStores | undefined;
        /** Absent on a single instance: every volatile message then stays in `inboundVolatileStores`. */
        readonly keepsVolatileMessageInMemory?: (message: ALMessage) => boolean;
        readonly outboundStores?: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
        readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
        readonly outboundSettlements?: ALDeliverySettlementSink;
        readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
        readonly dequeueTiming?: ALOutboundDequeuedAdmission.TimingSink;
        readonly dequeueResilience?: ResourceInboxResilience;
        readonly outboundDeliveryOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
        readonly deliveryDiagnostics?: WsDeliveryDiagnosticsSink;
        readonly authorizeInboundMessage?: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
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
        readonly businessFacts: WsQueueBoxServerReceiptBusinessFacts | undefined;
        readonly connectionId: string;
        readonly result: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>;
        readonly socketFacts: WsQueueBoxServerReceiptSocketFacts | undefined;
        readonly currentnessRejection?: WsQueueBoxServerInboundAuthority.CurrentnessRejection;
    }

    export interface HeldRowSend {
        readonly message: ALMessage;
        readonly entry: ResourceEntry;
        readonly policy: ALOutboundCapturedPolicy;
        readonly sentPositions: Readonly<Record<string, number>> | null;
    }

    export interface EnqueueAuthority {
        /**
         * The room audience a router admitted the message to. It travels with the outbound row, never on
         * the wire, and narrows every later plan of the message to that audience.
         */
        readonly admittedAudience: readonly string[] | undefined;
        /**
         * On a granted topic, the connection generation each admitted session's live subscription asserted when the
         * router admitted it; every later dispatch step compares it. Undefined for every other topic.
         */
        readonly admittedConnectionGenerationIds: Readonly<Record<string, string>> | undefined;
        /** The scope a producer proved for a unicast that names no group. */
        readonly recipientScope: StateScope | undefined;
    }

    export interface Dependencies {
        readonly creationNow: QueueBoxUtilities.CreationClock;
        readonly socket: JsonWebSocketServer;
        readonly name: string;
        readonly qosProvider: ALQosInputProvider;
        readonly targetResolver: WsServerTargetResolver;
        readonly readProducerProvenance: WsOutboxProducerProvenanceReader | undefined;
        readonly filterEligibleCapturedSessionIds: WsCapturedRecipientEligibilityFilter | undefined;
        readonly inboundRuntime: ALInboundMessageRuntime.Resources;
        readonly keepsVolatileMessageInMemory?: (message: ALMessage) => boolean;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources<WsQueueBoxServerPreparedMessage>;
        readonly dequeueResilience: ResourceInboxResilience;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundSettlements: ALDeliverySettlementSink | undefined;
        readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
        readonly receiptObserver?: WsQueueBoxServerReceiptObserver;
        readonly dequeueTiming?: ALOutboundDequeuedAdmission.TimingSink;
        readonly outboundDeliveryOutcome: ((outcome: WsOutboxDeliveryOutcome) => void) | undefined;
        readonly deliveryDiagnostics: WsDeliveryDiagnosticsSink | undefined;
        readonly authorizeInboundMessage: (message: ALMessage) => Either<ALMessageRejection, ALMessage>;
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
    private readonly creationNow: QueueBoxUtilities.CreationClock;
    private readonly receiptObserver: WsQueueBoxServerReceiptObserver | undefined;
    private readonly heldSends = new ExclusionKeyedAdmission({
        maxConcurrent: Number.MAX_SAFE_INTEGER,
        keyedChainsFirst: false
    });
    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly socket: JsonWebSocketServer;
    public readonly name: string;
    private readonly inboundNamespace: string;
    private readonly newControlId: () => string;

    constructor(dependencies: WsQueueBoxServerService.Dependencies) {
        this.clock = dependencies.outboundRuntime.clock;
        this.creationNow = dependencies.creationNow;
        this.receiptObserver = dependencies.receiptObserver;
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.admissionStore = dependencies.outboundRuntime.admissionStore;
        this.socket = dependencies.socket;
        this.name = dependencies.name;
        this.inboundNamespace = dependencies.inboundRuntime.admissionStore.namespace;
        this.newControlId = dependencies.inboundRuntime.effectPreparation.newControlId;
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
            readProducerProvenance: dependencies.readProducerProvenance,
            targetResolution: this.targetResolution,
            filterEligibleCapturedSessionIds: dependencies.filterEligibleCapturedSessionIds
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
            creationNow: this.creationNow,
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
            readRelayedRepairRequestRejection: (request, requesterPeerId) =>
                this.readRelayedRepairRequestRejection(request, requesterPeerId),
            authorizeInboundMessage: dependencies.authorizeInboundMessage,
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
            receiptWorkCapture: this.receiptObserver === undefined ? undefined : {
                batchObservations: ALWorkBatchObservations,
                createEvidence: createALOutboundReceiptWorkEvidence,
                observer: (observation) =>
                    recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
                        ...observation,
                        serverPeerId: this.name
                    })
            },
            dequeueTiming: dependencies.dequeueTiming,
            settlements: dependencies.outboundSettlements,
            toOutboxEntry: (message: ALMessage) =>
                QueueBoxUtilities.toResourceEntryFromMsg(
                    message,
                    WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                    this.creationNow()
                ),
            readMessageFromEntry: (entry) => decodePersistedALMessageRow(entry),
            readDequeuedAdmissionAuthority: async (message, batch) =>
                await this.readTrackOrderAuthority(message, batch),
            readDequeueAuthority: async (message, entry) => {
                const read = await this.dequeueAuthority.readDequeueAuthority(message, entry);
                await this.writeOutsideAudience(message, read.dropped);
                return read.authority;
            },
            planOutgoingMessage: (message, authority) => this.planWorkDispatch(message, authority, 'immediate'),
            planDequeuedMessage: (message, authority) => this.planWorkDispatch(message, authority, 'dequeue'),
            afterDequeueAdmission: async (message, entry, committedPolicy) => {
                await this.clusterPublication.writeDequeuedRow(message, entry, committedPolicy);
                await this.deferUnpublishedRowToAwaitedRecipients(message, entry, committedPolicy);
            },
            sendPreparedMessage: async (prepared, _phase, lifecycle) =>
                await this.sendPreparedMessage(prepared, lifecycle),
            planRepairMessage: async (message, request) => {
                const audience = await this.dequeueAuthority.readCurrentAudience(message, request);
                await this.writeOutsideAudience(message, audience.dropped);
                return this.outboundPlanning.planRepairMessage(message, {
                    ...request,
                    admittedAudience: audience.eligible
                });
            }
        });
    }

    /** The work runtime's authority becomes the WS planner's phase-specific request. */
    private planWorkDispatch(
        message: ALMessage,
        authority: ALOutboundPlanningAuthority | undefined,
        phase: WsQueueBoxServerOutboundPhase
    ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
        return this.outboundPlanning.planOutboundMessage({
            message,
            phase,
            clusterPublisherRegistered: this.clusterPublication.hasPublisher(),
            admittedAudience: authority?.admittedAudience,
            admittedConnectionGenerationIds: authority?.admittedConnectionGenerationIds,
            recipientScope: authority?.recipientScope,
            principalTargetId: authority?.principalTargetId,
            sessionInvalidation: authority?.sessionInvalidation,
            referenceKey: authority?.referenceKey
        });
    }

    private createInboundRuntime(
        dependencies: WsQueueBoxServerService.Dependencies
    ): ALInboundMessageRuntime {
        return new ALInboundMessageRuntime({
            ...dependencies.inboundRuntime,
            carrier: 'ws',
            orderingObserver: 'every-track',
            readPendingAdmissionAuthority: (message, source) =>
                this.inboundAuthority.readPendingAdmissionAuthority(message, source),
            planIncomingMessage: (message, fromPeerId, runtime) =>
                this.inboundDelivery.planIncomingMessage(message, fromPeerId, runtime),
            canDispatchMessage: (message) => this.inboundDelivery.hasInboxConsumer(message),
            keepsVolatileMessageInMemory: dependencies.keepsVolatileMessageInMemory,
            dispatchInboxEntry: (entry, plan, source) => this.inboundDelivery.dispatchInboxEntry(entry, plan, source),
            sendControlMessages: (messages) => this.controlDelivery.sendControlMessages(messages),
            onControlMessage: async (message) => {
                await this.receipts.acceptControlMessage(message);
            },
            readRelayedAckRejection: (ack, controlIdentity) =>
                this.readRuntimeProtocolAckRejection(ack, controlIdentity),
            readRelayedRepairRequestRejection: (request, requesterPeerId) =>
                this.readRelayedRepairRequestRejection(request, requesterPeerId),
            forwardMessage: (input) => this.inboundDelivery.forwardIncomingMessage(input),
            canForwardMessage: (message) =>
                this.forwardsRoomScopedMessages || (!isRoomScopedALMessage(message) && !isALWorldBroadcast(message)),
            diagnostics: dependencies.inboundDiagnostics
        });
    }

    private readRuntimeProtocolAckRejection(
        ack: ALAckPayload,
        controlIdentity?: ALMessage['id']
    ): ALMessageRejection | undefined {
        return this.ackRelay.readRelayedAckRejection(
            ack,
            this.receiptObserver === undefined ? undefined : { stage: 'runtime-protocol', controlIdentity }
        );
    }

    /**
     * A session asks for repair of another session's track only on a row this server relays from that origin and
     * admitted the session to (P2, D498); the outbound owner then serves it as it serves an expected repair peer.
     */
    private async readRelayedRepairRequestRejection(
        request: ALNackPayload | ALRepairPayload,
        requesterPeerId: string
    ): Promise<ALMessageRejection | undefined> {
        const stored = await this.admissionStore.readStoredMessage(request.msgId);
        const admitted = stored !== undefined && stored.reference.senderId === request.toPeerId &&
            request.fromPeerId === requesterPeerId &&
            stored.policy.admittedAudience?.includes(requesterPeerId) === true;
        return admitted ? undefined : {
            code: 'unauthorized',
            message: 'AL repair request names no relayed message admitted to its sender'
        };
    }

    private registerSocketIngress(): void {
        this.socket.onMessageDo(this.name, {
            maxMessageBytes: AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            onMessage: async (connection: ConnectionContext, data) => {
                await this.acceptIncomingMessage(data, connection.id);
            }
        });
    }

    /** Stops ingress and all ALM producers synchronously; resolves after their owned releases finish. */
    async dispose(): Promise<void> {
        this.inboundAuthority.dispose();
        this.socket.removeOnMessageCallbackById(this.name);
        const inboundDisposed = this.inboundRuntime.dispose();
        this.receipts.dispose();
        const outboundDisposed = this.outboundRuntime.dispose();
        this.inboundDelivery.dispose();
        const disposed = await Promise.allSettled([inboundDisposed, outboundDisposed]);
        for (const outcome of disposed) {
            if (outcome.status === 'rejected') {
                throw toError(outcome.reason);
            }
        }
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
            admittedConnectionGenerationIds: authority?.admittedConnectionGenerationIds,
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
        const subject = this.receiptObserver && decoded.right
            ? {
                ackFacts: toWsQueueBoxServerReceiptAckFacts(decoded.right),
                businessFacts: toWsQueueBoxServerReceiptBusinessFacts(decoded.right),
                connectionId
            }
            : undefined;
        const decision = await this.inboundAuthority.readSocketAdmission(decoded, connectionId);
        if (decision.kind === 'finished') {
            return subject === undefined ? decision.result : this.recordSocketDecision({
                ...subject,
                result: decision.result,
                socketFacts: decision.socketFacts,
                currentnessRejection: decision.currentnessRejection
            });
        }
        if (decision.kind === 'retain') {
            const result = Either.ofRight<ALMessageRejection, ALInboundMessageRuntime.Acceptance>(
                await this.inboundRuntime.retainIncomingMessage(decision.message, decision.source)
            );
            return subject === undefined
                ? result
                : this.recordSocketDecision({ ...subject, result, socketFacts: decision.socketFacts });
        }
        const current = this.inboundAuthority.resolveAuthorizedSocketAdmission(decision.value, connectionId);
        if (current.kind === 'refused') {
            const result = await this.inboundAuthority.rejectIncomingMessage(current.message, current.refusal);
            return subject === undefined
                ? result
                : this.recordSocketDecision({ ...subject, result, socketFacts: current.socketFacts });
        }
        if (current.kind === 'finished') {
            return subject === undefined ? current.result : this.recordSocketDecision({
                ...subject,
                result: current.result,
                socketFacts: current.socketFacts,
                currentnessRejection: current.currentnessRejection
            });
        }
        const result = await this.admitAuthorizedMessage(current.value);
        return subject === undefined
            ? result
            : this.recordSocketDecision({ ...subject, result, socketFacts: current.value.socketFacts });
    }

    private recordSocketDecision(
        observation: WsQueueBoxServerService.SocketObservation
    ): Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance> {
        const outcome = observation.result.left !== undefined ? 'rejected' : observation.result.right?.kind;
        this.recordCurrentnessAckRejection(observation);
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
        if (observation.businessFacts !== undefined && outcome !== undefined && outcome !== 'control') {
            recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
                ...observation.businessFacts,
                kind: 'business-socket-decision',
                serverPeerId: this.name,
                connectionId: observation.connectionId,
                fromPeerId: observation.socketFacts?.fromPeerId,
                authenticatedScope: observation.socketFacts?.authenticatedScope,
                scopeDisposition: observation.socketFacts?.scopeDisposition ?? 'unobserved',
                outcome,
                rejectionCode: observation.result.left?.code
            });
        }
        return observation.result;
    }

    private recordCurrentnessAckRejection(observation: WsQueueBoxServerService.SocketObservation): void {
        const { ackFacts, currentnessRejection } = observation;
        if (this.receiptObserver === undefined || currentnessRejection === undefined || ackFacts === undefined) {
            return;
        }
        recordWsQueueBoxServerReceiptObservation(this.receiptObserver, {
            kind: 'ack-rejection',
            serverPeerId: this.name,
            controlMsgId: ackFacts.controlMsgId,
            controlSenderId: ackFacts.controlSenderId,
            controlCreatedAtEpochMs: ackFacts.controlCreatedAtEpochMs,
            traceId: ackFacts.traceId,
            rejectionCode: 'unauthorized',
            owner: 'inbound-authority',
            connectionId: observation.connectionId,
            ...currentnessRejection
        });
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

    /** Whether the message reaches only the audience frozen at its admission (a granted topic, D487). */
    requiresFrozenAudience(message: ALMessage): boolean {
        return this.targetResolution.requiresFrozenAudience(message);
    }

    /** The policy the row's own commit handed over, when there is one, is checked instead of read back. */
    async readCapturedPolicy(
        message: ALMessage,
        entry: ResourceEntry,
        committedPolicy: ALOutboundCapturedPolicy | undefined
    ): Promise<ALOutboundCapturedPolicy> {
        return await this.dequeueAuthority.readCapturedPolicy(message, entry, committedPolicy);
    }

    sendToTargetsWithResult(input: WsServerLiveSendInputDto): WsServerLiveSendResult {
        return this.liveDelivery.sendToTargetsWithResult(input);
    }

    /**
     * Without a cluster publisher the prepared sends reach only sockets already open, so a session whose upgrade
     * committed here but has not opened is held for; with one, the publisher's local send holds instead.
     */
    private async deferUnpublishedRowToAwaitedRecipients(
        message: ALMessage,
        entry: ResourceEntry,
        committedPolicy: ALOutboundCapturedPolicy | undefined
    ): Promise<void> {
        if (this.clusterPublication.hasPublisher() || !this.socket.expectedConnections.hasExpectations()) {
            return;
        }
        const policy = await this.dequeueAuthority.readCapturedPolicy(message, entry, committedPolicy);
        const sentPositions = await this.readSentPositions(message);
        const awaited = this.socket.expectedConnections.holdForAudience(policy.admittedAudience ?? [], {
            expiresAtEpochMs: entry.audit.expiryTs.epochMilliseconds,
            send: (sessionId) => {
                // One session's held rows re-check one after the other, so they reach it in the order they were held.
                void this.heldSends.admit(
                    sessionId,
                    () =>
                        this.sendHeldRow({
                            message,
                            entry,
                            policy: toWsQueueBoxServerHeldSessionPolicy(policy, sessionId),
                            sentPositions
                        })
                ).catch((error) => console.error('Held WebSocket send failed:', error));
            }
        });
        if (awaited.evictedCount > 0) {
            console.warn('WS outbox hold evicted older rows for awaited sessions', {
                messageId: message.id.msgId,
                evictedCount: awaited.evictedCount
            });
        }
    }

    /**
     * A held send re-checks its one session when the session's socket opens, as every other attempt does (D498), and
     * sends it its own copy; a session the re-check drops, or one a later row of the track reached, is recorded
     * outside.
     */
    private async sendHeldRow(
        { message, entry, policy, sentPositions }: WsQueueBoxServerService.HeldRowSend
    ): Promise<void> {
        const audience = await this.dequeueAuthority.readCurrentAudience(message, policy);
        await this.writeOutsideAudience(message, audience.dropped);
        const sent = this.liveDelivery.sendToTargetsWithResult(toWsQueueBoxServerCapturedSendInput({
            message,
            key: entry.key,
            policy: { ...policy, admittedAudience: audience.eligible },
            eligibleSessionIds: undefined,
            sentPositions
        }));
        await this.writeOutsideAudience(message, sent.belowPositionPeerIds);
    }

    /**
     * A dequeued row that will record positions on its track follows its predecessor there when its batch claimed it
     * too, and otherwise waits while that predecessor is admitted here and not yet recorded, so the track's positions
     * are written in sequence order: a predecessor never admitted here, already sent or expired holds nothing. A held
     * row's re-check reads the predecessor's row alone: the row's own answer and its predecessor's id hold while it
     * is held.
     */
    private async readTrackOrderAuthority(
        message: ALMessage,
        batch: ALOrderingBatchSequences
    ): Promise<ALOutboundMessageRuntime.DequeuedAdmissionAuthority> {
        const trackKey = toALOrderingTrackKey(message);
        const seq = message.ordering?.seq;
        const nowMs = this.clock.nowMs();
        if (
            trackKey === undefined || seq === undefined || seq <= 1 ||
            !isWsQueueBoxServerUnrecordedRow(await this.admissionStore.readStoredMessage(message.id.msgId), nowMs)
        ) {
            return { status: 'authorized' };
        }
        if (isALOrderingPredecessorInBatch(message, batch)) {
            return { status: 'follows-batch-predecessor' };
        }
        const predecessor = await this.admissionStore.readSentMessageByOrdering(trackKey, seq - 1);
        const readPredecessorUnrecorded = async () =>
            predecessor !== undefined &&
            isWsQueueBoxServerUnrecordedRow(
                await this.admissionStore.readStoredMessage(predecessor.msgId),
                this.clock.nowMs()
            );
        return await readPredecessorUnrecorded()
            ? {
                status: 'held',
                reason: `WS row waits for sequence ${seq - 1} of its track to record first`,
                readReleased: async () => !await readPredecessorUnrecorded()
            }
            : { status: 'authorized' };
    }

    /**
     * The positions a tracked row's first dequeue recorded, which every live copy of the row takes its entry from;
     * read once per send of the row, `null` for a row with no track or nothing recorded.
     */
    async readSentPositions(message: ALMessage): Promise<Readonly<Record<string, number>> | null> {
        if (toALOrderingTrackKey(message) === undefined) {
            return null;
        }
        return (await this.admissionStore.readStoredMessage(message.id.msgId))?.sentPositions ?? null;
    }

    /**
     * Records each session the server sent its origin's row nothing outside the audience of the receipt the origin
     * awaits (S4-R9); the server's own rows and rows no receipt counts recipients of have none to record in. Only a
     * session connected here is this instance's to judge: its re-check sees every other instance's session as not
     * here, which is no exclusion, so that session stays expected and its own instance answers for it.
     */
    async writeOutsideAudience(message: ALMessage, sessionIds: readonly string[]): Promise<void> {
        const originPeerId = message.id.senderId;
        if (
            originPeerId === this.name ||
            !isALLogicalReceiptMode(this.outboundPlanning.resolvePolicy(message).effective.ack.algo)
        ) {
            return;
        }
        const judged = sessionIds.filter((sessionId) =>
            sessionId !== originPeerId && this.socket.connections.get(sessionId)?.isOpen === true
        );
        for (const recipientPeerId of judged) {
            await this.ackRelay.writeServerAck(toWsQueueBoxServerOutsideAudienceAck({
                message,
                recipientPeerId,
                serverPeerId: this.name,
                controlId: this.newControlId(),
                nowMs: this.clock.nowMs()
            }));
        }
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
        const canonical = reconstructALOutboundTransportMessage(prepared.message, lifecycle.canonicalMessage);
        const copy = toWsQueueBoxServerRecipientCopy({
            message: canonical,
            recipientPeerId: prepared.peerId,
            sentPositions: lifecycle.sentPositions
        });
        if (copy.right === undefined) {
            await this.writeOutsideAudience(canonical, [prepared.peerId]);
            return { status: 'no-targets', submissionAttempted: false, reason: 'A later row of the track reached it' };
        }
        return this.sendRecipientCopy({ prepared, lifecycle, message: copy.right });
    }

    /** One recipient's copy on its socket, with the transport evidence a receipt observer asks for. */
    private sendRecipientCopy(
        { prepared, lifecycle, message }: Omit<WsQueueBoxServerPreparedRecipientInput, 'transport'>
    ): ALOutboundSettledSendResult {
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
            const runtimeError = toError(error);
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
    const creationNow = input.creationNow ?? Temporal.Now.instant;
    return new WsQueueBoxServerService({
        creationNow,
        socket: input.socket,
        name: input.name,
        qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, input.qosProvider),
        targetResolver: input.targetResolver ?? { requiresFrozenAudience: () => false },
        readProducerProvenance: input.readProducerProvenance,
        filterEligibleCapturedSessionIds: input.filterEligibleCapturedSessionIds,
        inboundRuntime: createDefaultALInboundRuntimeResources({
            stores: input.inboundStores,
            volatileStores: input.inboundVolatileStores,
            queueEngine: input.queueEngine,
            selfPeerId: input.name,
            toInboxEntry: (message) =>
                QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX, creationNow())
        }),
        keepsVolatileMessageInMemory: input.keepsVolatileMessageInMemory,
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
        dequeueTiming: input.dequeueTiming,
        outboundDeliveryOutcome: input.outboundDeliveryOutcome,
        deliveryDiagnostics: input.deliveryDiagnostics,
        authorizeInboundMessage: input.authorizeInboundMessage ?? Either.ofRight,
        readAuthenticatedConnectionScope: input.readAuthenticatedConnectionScope,
        publishRelayedAck: input.publishRelayedAck,
        forwardsRoomScopedMessages: input.forwardsRoomScopedMessages ?? true
    });
}
