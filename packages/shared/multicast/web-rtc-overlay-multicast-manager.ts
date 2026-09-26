import { readALTargetGroupRef, type ALMessage } from '../al-contracts/al-contract.ts';
import {
    resolveALFrozenMulticastAudience,
    toALFrozenMulticastMessage
} from '../al-contracts/al-frozen-multicast-audience.ts';
import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import {
    ALMessageHandlingPlan,
    ALQosEffectivePolicy,
    ALQosInputProvider,
    ALQosNormalizationInput,
    ALQosNormalizationResult,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    type ALMessageDropReasonCode,
    type ALMessagePlanningObservations
} from '../al-contracts/al-policy.ts';
import { toALReceiverAckQosInputProvider } from '../al-contracts/validate-al-ack-support.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliverySettlementSink
} from '../alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import { computeALOutboundAckRefusal } from '../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import type {
    ALOutboundCancelOutcome,
    ALOutboundEnqueueResult,
    ALOutboundPreparedSendResult,
    ALOutboundRuntimeDiagnosticsSink
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundRetryTrackingPlan,
    ALOutboundSupersedenceTrackingPlan,
    type ALOutboundDropReasonCode
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    reconstructALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../alm/outbound/to-al-outbound-message.ts';
import {
    EnqueuedType,
    OverlayId,
    OverlayInfo,
    PeerId
} from '../api/api-config.ts';
import {
    isOverlayForGroupRef,
    isSameGroupRef,
    toScopedOverlayId
} from '../api/api-type-utils.ts';
import { isSessionInGroup, readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '../api/group-types.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { NotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { isOverlayIdentity } from '../repository/overlays-repository.ts';
import { CircuitBreaker } from '../resilience/circuit-breaker.ts';
import { Either } from '../resilience/Either.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { QueueBoxUtilities } from '../services/queue-box-utilities.ts';
import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type {
    QRtcDataChannel,
    RtcDataChannelHealth,
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult
} from '../webrtc/qrtc-data-channel.ts';
import { isRtcEnqueueBreakerSuccess } from './is-rtc-enqueue-breaker-success.ts';
import {
    OverlayMulticastDispatchPlan,
    OverlayMulticasterContext,
    WebRtcOverlayMulticaster,
    WebRtcOverlayMulticasterFactory
} from './overlay-multicast-contracts.ts';
import { RtcOutboundSubmission } from './rtc-outbound-submission.ts';
import {
    computeRtcRoomSnapshotAdmission,
    toRtcRoomSnapshotHandlingPlan,
    type RtcRoomSnapshotAdmission
} from './rtc-room-snapshot-admission.ts';
import { toRtcAckTrackingPlan } from './to-rtc-ack-tracking-plan.ts';
import {
    computeFrozenAudience,
    computeRtcFrozenAudienceRefusal,
    toRtcEmptyAudienceDispatchPlan,
    toRtcFrozenAudienceDispatchPlan,
    toRtcFrozenAudienceRepairPlan,
    toRtcOriginFrozenMessage
} from './web-rtc-overlay-frozen-audience.ts';
import {
    planRtcFailedPeerRepair,
    toRtcRetriedCopyRetransmission,
    toRtcRetryExpectedPeerIdsUpdate,
    toRtcTargetedRepairCopy
} from './web-rtc-overlay-missing-recipient-repair.ts';

interface RtcOutboundObservation {
    readonly overlayId: OverlayId | undefined;
    readonly room: GroupSnapshot | undefined;
    readonly overlay: OverlayInfo | undefined;
    readonly connectedPeerIds: readonly PeerId[];
    readonly nowMs: number;
}

export namespace WebRtcOverlayMulticastManager {
    export interface Channel {
        readHealth(): Pick<RtcDataChannelHealth, 'readyState'>;
        sendJson(message: ALMessage, options?: RtcDataChannelSendOptions): RtcDataChannelSendResult;
    }

    export interface Peer {
        readonly channel: Channel | undefined;
    }

    export interface Connection {
        readonly input: Pick<WebRtcConnectionService.InputDto, 'sessionId'>;
        readyPeerIdsForLane(): readonly PeerId[];
        readPeer(peerId: PeerId): Peer | undefined;
    }

    export interface Dependencies {
        readonly connectionService: Connection;
        readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
        readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
        readonly multicasterFactory: WebRtcOverlayMulticasterFactory;
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundSettlements: ALDeliverySettlementSink | undefined;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
        readonly dequeueResilience: ResourceInboxResilience;
        readonly circuitBreaker: CircuitBreaker;
        readonly rateLimiter: RateLimiter;
    }
}

export class WebRtcOverlayMulticastManager {
    public static readonly ENQUEUE_TYPE = EnqueuedType.RTC_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.ENQUEUE_TYPE
    ]);

    private readonly multicasterByOverlayId = new Map<OverlayId, WebRtcOverlayMulticaster>();
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly qosProvider: ALQosInputProvider | undefined;
    private disposed = false;

    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly connectionService: WebRtcOverlayMulticastManager.Connection;
    public readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
    public readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
    public readonly multicasterFactory: WebRtcOverlayMulticasterFactory;
    private readonly circuitBreaker: CircuitBreaker;
    private readonly rateLimiter: RateLimiter;
    private readonly clock: ALOutboundMessageRuntime.Clock;
    private readonly submission: RtcOutboundSubmission;

    constructor(dependencies: WebRtcOverlayMulticastManager.Dependencies) {
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.connectionService = dependencies.connectionService;
        this.groupCache = dependencies.groupCache;
        this.overlayCache = dependencies.overlayCache;
        this.multicasterFactory = dependencies.multicasterFactory;
        this.circuitBreaker = dependencies.circuitBreaker;
        this.rateLimiter = dependencies.rateLimiter;
        this.qosProvider = toALReceiverAckQosInputProvider(dependencies.qosProvider);
        this.clock = dependencies.outboundRuntime.clock;
        this.submission = new RtcOutboundSubmission(dependencies.connectionService, this.clock);
        this.outboundRuntime = new ALOutboundMessageRuntime<ALOutboundTransportMessage>(
            {
                ...dependencies.outboundRuntime,
                carrier: 'rtc',
                decodePreparedMessage: decodeALOutboundTransportMessage,
                dequeue: {
                    types: WebRtcOverlayMulticastManager.OUTBOX_DEQUEUE_TYPES,
                    resilience: dependencies.dequeueResilience
                },
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WebRtcOverlayMulticastManager.ENQUEUE_TYPE
                    ),
                readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
                planOutgoingMessage: (msg) => this.planOutgoingMessage(msg),
                planDequeuedMessage: (msg) => this.planDequeuedMessage(msg),
                afterDequeueAdmission: undefined,
                readPendingAdmissionAuthority: async (message, prepared) =>
                    this.readPendingAdmissionAuthority(message, prepared),
                sendPreparedMessage: async (prepared, _phase, lifecycle) =>
                    await this.sendPreparedMessage(
                        reconstructALOutboundTransportMessage(prepared, lifecycle.canonicalMessage),
                        lifecycle,
                        prepared.ingressPeerId
                    ),
                planRepairMessage: async (msg, request) => await this.planRepairMessage(msg, request),
                diagnostics: dependencies.outboundDiagnostics,
                settlements: dependencies.outboundSettlements
            }
        );
    }

    getOrCreateMulticaster(overlayId: OverlayId): WebRtcOverlayMulticaster {
        let multicaster = this.multicasterByOverlayId.get(overlayId);

        if (!multicaster) {
            multicaster = this.multicasterFactory(overlayId);
            this.multicasterByOverlayId.set(overlayId, multicaster);
        }

        return multicaster;
    }

    dispose(): void {
        this.disposed = true;
        this.outboundRuntime.dispose();
        this.multicasterByOverlayId.clear();
    }

    cancel(msgId: string): ALOutboundCancelOutcome {
        return this.outboundRuntime.cancel(msgId);
    }

    async enqueueIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        const [result] = await this.enqueueAllIfAbsent([msg]);
        return result!;
    }

    /** One circuit-breaker call and one rate-limiter token for the whole group, whose messages commit as one. */
    async enqueueAllIfAbsent(msgs: readonly ALMessage[]): Promise<readonly ALOutboundEnqueueResult[]> {
        if (this.disposed) {
            return msgs.map((msg) => WebRtcOverlayMulticastManager.toDisposedEnqueueResult(msg));
        }

        const either = await CircuitBreaker.tryToExecute<readonly ALOutboundEnqueueResult[]>(
            this.circuitBreaker,
            () => {
                return RateLimiter.tryToExecuteOrDefault<readonly ALOutboundEnqueueResult[]>(
                    this.rateLimiter,
                    () => this.outboundRuntime.enqueueAllIfAbsent(msgs),
                    msgs.map((msg) =>
                        WebRtcOverlayMulticastManager.toProtectedEnqueueResult(msg, {
                            kind: 'unroutable',
                            reason: 'rate-limited',
                            detail: 'RTC enqueue rate limit exceeded'
                        })
                    )
                );
            },
            (results) => results.every(isRtcEnqueueBreakerSuccess)
        );

        return either.fold(
            (error) => msgs.map((msg) => WebRtcOverlayMulticastManager.toCircuitBreakerResult(msg, error)),
            (value) => value
        );
    }

    private static toCircuitBreakerResult(
        msg: ALMessage,
        error: Error
    ): ALOutboundEnqueueResult {
        if (error.message === 'Not allowed to execute') {
            return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(msg, {
                kind: 'unroutable',
                reason: 'circuit-open',
                detail: 'RTC enqueue circuit breaker open'
            });
        }

        return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(msg, {
            kind: 'failed',
            detail: `RTC enqueue failed: ${error.message}`
        });
    }

    private static toProtectedEnqueueResult(
        msg: ALMessage,
        verdict: Extract<ALDeliveryAdmissionVerdict, { kind: 'unroutable' | 'failed'; }>
    ): ALOutboundEnqueueResult {
        return { verdict, message: msg, entries: [], reason: verdict.detail };
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        const verdict: ALDeliveryAdmissionVerdict = {
            kind: 'skipped',
            reason: 'disposed',
            detail: 'RTC overlay multicast manager is disposed.'
        };
        return { verdict, message: msg, entries: [], reason: verdict.detail };
    }

    async forwardIfRequired(
        msg: ALMessage,
        fromPeerId?: PeerId
    ): Promise<readonly ResourceEntry[]> {
        const forwarding = this.planForwarding(msg, fromPeerId);
        return forwarding === undefined
            ? []
            : (await this.outboundRuntime.enqueueIfAbsent(forwarding.msg, forwarding)).entries;
    }

    async forwardRetriedCopy(copy: ALInboundMessageRuntime.RetriedCopy): Promise<void> {
        await this.outboundRuntime.retransmitAdmittedMessage(
            toRtcRetriedCopyRetransmission(copy, this.planForwarding(copy.msg, copy.fromPeerId))
        );
    }

    /** A peer is present while it is a member of the room of the message and ready on this lane. */
    isRoomPeerPresent(msg: ALMessage, peerId: string): boolean {
        const groupRef = readALTargetGroupRef(msg);
        const snapshot = groupRef ? this.readGroupSnapshotByRef(groupRef) : undefined;
        return snapshot !== undefined && isSessionInGroup(snapshot, peerId) &&
            this.connectionService.readyPeerIdsForLane().includes(peerId);
    }

    private planForwarding(
        msg: ALMessage,
        fromPeerId: PeerId | undefined
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
        if (!msg.targets) {
            return undefined;
        }

        if (msg.targets.mode === 'unicast') {
            return undefined;
        }

        const source = fromPeerId === undefined ? undefined : { kind: 'rtc-peer' as const, peerId: fromPeerId };
        const admissionPlan = this.planIncomingMessage(msg, source);
        if (admissionPlan.dropReason) {
            return undefined;
        }
        const context = toAcceptedOverlayContext(this.readOutboundObservation(msg));
        if (!context) {
            return undefined;
        }

        const dispatchPlan = this.getOrCreateMulticaster(context.overlayId).createForwardingPlan(msg, context, {
            fromPeerId,
            qos: this.readForwardingQosInput(msg, context, fromPeerId)
        });
        const planned = this.planOutboundDispatch(
            toALOutboundMessage(msg, dispatchPlan.handlingPlan.effective),
            dispatchPlan
        );
        return {
            ...planned,
            preparedMessages: planned.preparedMessages.map((prepared) => ({
                ...prepared,
                ingressPeerId: fromPeerId ?? null
            }))
        };
    }

    private readForwardingQosInput(
        msg: ALMessage,
        context: OverlayMulticasterContext,
        fromPeerId: PeerId | undefined
    ): ALQosNormalizationInput {
        return resolveALQosNormalizationInput(
            msg,
            {
                direction: 'outbound',
                selfPeerId: this.connectionService.input.sessionId,
                fromPeerId,
                connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                overlayNeighborPeerIds: context.overlay.nextHopSessionIds
            },
            this.qosProvider
        );
    }

    planIncomingMessage(
        msg: ALMessage,
        source?: ALInboundMessageRuntime.Source,
        observations?: ALMessagePlanningObservations
    ): ALMessageHandlingPlan {
        const nowMs = observations?.nowMs ?? this.clock.nowMs();
        const fromPeerId = source && source.kind !== 'trusted-server' ? source.peerId : undefined;
        const groupRef = readALTargetGroupRef(msg);
        const snapshot = groupRef ? this.readGroupSnapshotByRef(groupRef) : undefined;
        const overlayId = this.readOutboundObservation(msg).overlayId;
        const overlay = overlayId ? this.overlayCache.read(overlayId) : undefined;
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot,
            overlay,
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId,
            recipientPeerId: undefined,
            nowMs
        });
        const messageContext = {
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId,
            connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
            groupMemberPeerIds: admission.kind === 'authorized' ? admission.memberPeerIds : [],
            overlayNeighborPeerIds: admission.kind === 'authorized' ? admission.forwardingPeerIds : []
        };
        const policyMessage = fromPeerId !== undefined && msg.targets?.mode !== 'unicast'
            ? { ...msg, forwarding: { ...msg.forwarding, nextHopPeerIds: undefined } }
            : msg;
        const plan = planALMessageHandling(
            policyMessage,
            { ...messageContext, ...observations, nowMs },
            resolveALQosNormalizationInput(msg, { ...messageContext, direction: 'inbound' }, this.qosProvider)
        );
        return toRtcRoomSnapshotHandlingPlan(plan, admission, fromPeerId);
    }

    async acceptControlMessage(msg: ALMessage): Promise<void> {
        if (this.disposed) {
            return;
        }

        await this.outboundRuntime.acceptControlMessage(msg, 'peer');
    }

    private readOutboundObservation(msg: ALMessage): RtcOutboundObservation {
        const groupRef = readALTargetGroupRef(msg);
        const explicitId = msg.forwarding?.overlayId;
        const explicit = explicitId ? this.overlayCache.read(explicitId) : undefined;
        const scopedId = groupRef
            ? toScopedOverlayId(groupRef)
            : msg.targets?.mode === 'broadcast'
            ? msg.route.contextId
            : undefined;
        const scoped = explicit === undefined && scopedId !== explicitId && scopedId
            ? this.overlayCache.read(scopedId)
            : undefined;
        const groupId = groupRef?.groupId;
        const groupOverlay = explicit === undefined && scoped === undefined && groupId
            ? this.overlayCache.read(groupId)
            : undefined;
        const overlayId = explicit ? explicitId : scoped ? scopedId : groupOverlay ? groupId : explicitId ?? scopedId;
        return {
            overlayId,
            overlay: explicit ?? scoped ?? groupOverlay,
            room: groupRef
                ? this.readGroupSnapshotByRef(groupRef)
                : overlayId
                ? this.groupCache.read(overlayId)
                : undefined,
            connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
            nowMs: this.clock.nowMs()
        };
    }

    private readGroupSnapshotByRef(ref: GroupRef): GroupSnapshot | undefined {
        return this.groupCache.readAllValues()
            .find((group) => isSameGroupRef(group.group, ref));
    }

    private planDirectDispatch(
        msg: ALMessage
    ): OverlayMulticastDispatchPlan {
        const handlingPlan = this.planIncomingMessage(msg);

        return {
            handlingPlan,
            transportMessages: handlingPlan.forwarding.nextHopPeerIds.map((
                peerId
            ) => ({
                ...msg,
                forwarding: {
                    ...msg.forwarding,
                    nextHopPeerIds: [peerId]
                }
            }))
        };
    }

    private readOutgoingQosPolicy(
        msg: ALMessage,
        context: OverlayMulticasterContext | undefined
    ): ALQosNormalizationResult {
        return normalizeALQosPolicy(
            msg,
            resolveALQosNormalizationInput(
                msg,
                {
                    direction: 'outbound',
                    selfPeerId: this.connectionService.input.sessionId,
                    connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                    groupMemberPeerIds: this.readOutboundObservation(msg).room?.activeSessions
                        .map((session) => session.sessionId),
                    overlayNeighborPeerIds: context?.overlay.nextHopSessionIds
                },
                this.qosProvider
            )
        );
    }

    private planDequeuedMessage(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        return this.planOutgoingMessage(msg, true);
    }

    private planOutgoingMessage(
        original: ALMessage,
        alreadyOwned = false
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const selfPeerId = this.connectionService.input.sessionId;
        const observation = this.readOutboundObservation(original);
        const context = toAcceptedOverlayContext(observation);
        const admission = this.computeOutboundAuthority(original, observation);
        const frozen = context === undefined && original.id.senderId === selfPeerId &&
                original.targets?.mode === 'multicast' &&
                resolveALFrozenMulticastAudience(original.targets) === undefined && admission.kind === 'authorized'
            ? toALFrozenMulticastMessage(original, computeFrozenAudience({ admission, selfPeerId }))
            : toRtcOriginFrozenMessage(original, context, selfPeerId);
        const policy = this.readOutgoingQosPolicy(frozen, context);
        const msg = toALOutboundMessage(frozen, policy.effective);
        const plan = computeALOutboundAckRefusal<ALOutboundTransportMessage>({ msg, carrier: 'rtc', policy })
            .flatMap((refusal) => Either.ofLeft(refusal), computeRtcFrozenAudienceRefusal)
            .fold((refusal) => refusal, () => this.planOriginatingDispatch(msg, context, alreadyOwned));
        return toRtcFrozenAudienceDispatchPlan(toRtcEmptyAudienceDispatchPlan(plan, policy.effective), selfPeerId);
    }

    private planOriginatingDispatch(
        msg: ALMessage,
        context: OverlayMulticasterContext | undefined,
        alreadyOwned: boolean
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        if (!msg.targets) {
            return this.toUnaddressedDispatchPlan(msg, this.readOutgoingQosPolicy(msg, context).effective);
        }

        if (msg.targets.mode === 'unicast') {
            return this.planOutboundDispatch(msg, this.planDirectDispatch(msg));
        }

        const observation = this.readOutboundObservation(msg);
        const admission = this.computeOutboundAuthority(msg, observation);
        if (alreadyOwned && admission.kind === 'pending') {
            throw new NotReadyException(50, admission.reason);
        }
        if (admission.kind === 'pending' || admission.kind === 'unauthorized') {
            return {
                dropReason: admission.reason,
                dropReasonCode: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
                persist: false,
                msg,
                preparedMessages: []
            };
        }
        if (!context) {
            const potential = admission.kind === 'authorized' ? admission.memberPeerIds : [];
            const handling = planALMessageHandling(
                msg,
                {
                    nowMs: observation.nowMs,
                    selfPeerId: this.connectionService.input.sessionId,
                    connectedPeerIds: observation.connectedPeerIds,
                    groupMemberPeerIds: potential,
                    overlayNeighborPeerIds: potential
                },
                resolveALQosNormalizationInput(msg, {
                    direction: 'outbound',
                    selfPeerId: this.connectionService.input.sessionId,
                    connectedPeerIds: observation.connectedPeerIds,
                    groupMemberPeerIds: potential,
                    overlayNeighborPeerIds: potential
                }, this.qosProvider)
            );
            return this.planAbsentOverlay(msg, handling, alreadyOwned);
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        return this.planOutboundDispatch(
            msg,
            multicaster.createOriginatingPlan(
                msg,
                context,
                resolveALQosNormalizationInput(
                    msg,
                    {
                        direction: 'outbound',
                        selfPeerId: this.connectionService.input.sessionId,
                        connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                        groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                        overlayNeighborPeerIds: context.overlay.nextHopSessionIds
                    },
                    this.qosProvider
                )
            )
        );
    }

    private computeOutboundAuthority(msg: ALMessage, observation: RtcOutboundObservation): RtcRoomSnapshotAdmission {
        const groupRef = readALTargetGroupRef(msg);
        const overlay = observation.overlay;
        if (
            groupRef && overlay &&
            (overlay.provenance !== 'server' || overlay.state !== 'active' || !isOverlayForGroupRef(overlay, groupRef))
        ) {
            return {
                kind: 'unauthorized',
                cause: 'authority-rejected',
                reason: 'RTC selected topology is explicitly inactive or foreign'
            };
        }
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot: observation.room,
            overlay: observation.overlay,
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId: undefined,
            recipientPeerId: undefined,
            nowMs: observation.nowMs
        });
        const room = observation.room;
        if (admission.kind === 'not-room' || !room) {
            return admission;
        }
        const identity = room.group.acceptedLayoutIdentity;
        if (
            room.group.transportState !== 'flowing' || !identity || identity.state !== 'active' ||
            (overlay === undefined && identity.presenceRevision !== room.causalRevision.presenceRevision)
        ) {
            return {
                kind: 'unauthorized',
                cause: 'authority-rejected',
                reason: 'RTC accepted room authority is not current and flowing'
            };
        }
        if (observation.overlay && !toAcceptedOverlayContext(observation)) {
            return {
                kind: 'unauthorized',
                cause: 'authority-rejected',
                reason: 'RTC selected topology is not the exact accepted room layout'
            };
        }
        return admission;
    }

    private planAbsentOverlay(
        msg: ALMessage,
        handling: ALMessageHandlingPlan,
        alreadyOwned: boolean
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const eligible = msg.id.senderId === this.connectionService.input.sessionId &&
            readALTargetGroupRef(msg) !== undefined &&
            !(msg.targets?.mode === 'broadcast' && msg.targets.recipientPeerIds !== undefined) &&
            !handling.dropReason && handling.forwarding.nextHopPeerIds.length > 0;
        if (eligible && alreadyOwned) {
            throw new NotReadyException(50, 'Awaiting the exact accepted RTC overlay cache value');
        }
        if (!eligible || !handling.forwarding.persist) {
            return {
                msg,
                dropReasonCode: 'no-route',
                persist: false,
                preparedMessages: [],
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without overlay context`
            };
        }
        return {
            msg,
            persist: true,
            preparedMessages: [],
            dropReasonCode: undefined,
            ackTracking: toRtcAckTrackingPlan(handling.effective, []),
            retryTracking: this.toRetryTrackingPlan(handling.effective),
            repairTracking: this.toRepairTrackingPlan(handling.effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(handling.effective, msg)
        };
    }

    private toUnaddressedDispatchPlan(
        msg: ALMessage,
        effective: ALQosEffectivePolicy
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        if (!msg.forwarding?.nextHopPeerIds?.length) {
            return {
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without targets or next hop`,
                dropReasonCode: 'no-route',
                persist: false,
                msg,
                preparedMessages: []
            };
        }
        return {
            dropReasonCode: undefined,
            persist: true,
            msg,
            preparedMessages: [toALOutboundTransportMessage(msg)],
            ackTracking: toRtcAckTrackingPlan(effective, msg.forwarding.nextHopPeerIds),
            repairTracking: this.toRepairTrackingPlan(effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(effective, msg)
        };
    }

    private planOutboundDispatch(
        msg: ALMessage,
        plan: OverlayMulticastDispatchPlan
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        if (plan.handlingPlan.dropReason) {
            return {
                dropReason: `Skipping planned RTC dispatch: ${plan.handlingPlan.dropReason}`,
                dropReasonCode: toALOutboundDropReasonCodeFromHandlingPlan(plan.handlingPlan.dropReasonCode),
                persist: false,
                msg,
                preparedMessages: []
            };
        }

        if (plan.transportMessages.length === 0) {
            return {
                dropReason: this.describeNoDispatchReason(plan),
                // A repair request has a real (if unimplemented) route; only the no-transport default is routeless.
                dropReasonCode: plan.handlingPlan.repair.enabled ? 'planner-drop' : 'no-route',
                persist: false,
                msg,
                preparedMessages: []
            };
        }

        const missingPeerId = this.readMissingImmediatePeer(plan);
        if (missingPeerId) {
            return {
                dropReason: `Skipping immediate RTC dispatch without RTC channel for peer ${missingPeerId}`,
                dropReasonCode: 'no-route',
                persist: false,
                msg,
                preparedMessages: []
            };
        }

        return {
            dropReasonCode: undefined,
            persist: plan.handlingPlan.forwarding.persist,
            msg,
            preparedMessages: plan.transportMessages.map(toALOutboundTransportMessage),
            receiptNextHopPeerIds: plan.transportMessages.flatMap((message) =>
                message.forwarding?.nextHopPeerIds ?? []
            ),
            ackTracking: toRtcAckTrackingPlan(
                plan.handlingPlan.effective,
                plan.transportMessages
                    .map((message) => message.forwarding?.nextHopPeerIds?.[0])
                    .filter((peerId): peerId is string => peerId !== undefined)
            ),
            retryTracking: this.toRetryTrackingPlan(plan.handlingPlan.effective),
            repairTracking: this.toRepairTrackingPlan(plan.handlingPlan.effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(
                plan.handlingPlan.effective,
                plan.transportMessages[0]
            )
        };
    }

    private readMissingImmediatePeer(plan: OverlayMulticastDispatchPlan): string | undefined {
        if (plan.handlingPlan.forwarding.persist) {
            return undefined;
        }
        return plan.transportMessages
            .map((message) => message.forwarding?.nextHopPeerIds?.[0])
            .find((peerId) => peerId !== undefined && !this.connectionService.readPeer(peerId)?.channel);
    }

    private describeNoDispatchReason(plan: OverlayMulticastDispatchPlan): string {
        if (plan.handlingPlan.repair.enabled) {
            return `Repair requested via ${plan.handlingPlan.repair.algo} but not implemented in RTC multicast manager: ` +
                `${plan.handlingPlan.repair.reason ?? 'No reason provided'}`;
        }

        return 'Skipping RTC outbound dispatch without planned transport messages';
    }

    private async sendPreparedMessage(
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle,
        ingressPeerId: string | null
    ): Promise<ALOutboundPreparedSendResult> {
        if (lifecycle.signal.aborted) {
            return { status: 'cancelled', submissionAttempted: false, reason: 'RTC transport owner was disposed.' };
        }
        const nowMs = this.clock.nowMs();
        if (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= nowMs) {
            return {
                status: 'expired',
                submissionAttempted: false,
                reason: 'RTC message deadline elapsed before native submission.'
            };
        }
        const admission = this.readRtcDispatchAuthority(
            lifecycle.canonicalMessage,
            ingressPeerId,
            msg.forwarding?.nextHopPeerIds?.[0]
        );
        // An admitted origin keeps its captured edge until its own deadline. Current topology
        // still denies native submission; a later attempt must pass this same authority check.
        if (
            admission.kind === 'pending' ||
            (admission.kind === 'unauthorized' && admission.cause === 'edge-unavailable' &&
                ingressPeerId === null &&
                lifecycle.canonicalMessage.id.senderId === this.connectionService.input.sessionId)
        ) {
            return { status: 'not-ready', submissionAttempted: false, reason: admission.reason, retryAfterMs: 50 };
        }
        if (admission.kind === 'unauthorized') {
            return { status: 'no-targets', submissionAttempted: false, reason: admission.reason };
        }
        return this.submission.send(msg, lifecycle);
    }

    private readPendingAdmissionAuthority(
        message: ALMessage,
        preparedMessages: readonly ALOutboundTransportMessage[]
    ): ALOutboundMessageRuntime.PendingAdmissionAuthority {
        const logical = this.computeOutboundAuthority(message, this.readOutboundObservation(message));
        if (logical.kind === 'pending') {
            return { status: 'not-ready', reason: logical.reason, retryAfterMs: 50 };
        }
        if (logical.kind === 'unauthorized') {
            return { status: 'rejected', reason: logical.reason };
        }
        for (const prepared of preparedMessages) {
            const admission = this.readRtcDispatchAuthority(
                message,
                prepared.ingressPeerId,
                prepared.forwarding?.nextHopPeerIds?.[0]
            );
            if (admission.kind === 'pending') {
                return { status: 'not-ready', reason: admission.reason, retryAfterMs: 50 };
            }
            if (admission.kind === 'unauthorized') {
                return { status: 'rejected', reason: admission.reason };
            }
        }
        return { status: 'authorized' };
    }

    private readRtcDispatchAuthority(
        message: ALMessage,
        ingressPeerId: string | null,
        recipientPeerId: string | undefined
    ) {
        const outbound = this.readOutboundObservation(message);
        const logical = this.computeOutboundAuthority(message, outbound);
        if (
            readALTargetGroupRef(message) && recipientPeerId !== undefined && outbound.room &&
            !outbound.room.activeSessions.some((session) => session.sessionId === recipientPeerId)
        ) {
            return {
                kind: 'unauthorized',
                cause: 'authority-rejected',
                reason: 'RTC prepared recipient is no longer active'
            } as const;
        }
        if (logical.kind === 'pending' || logical.kind === 'unauthorized') {
            return logical;
        }
        const roomRef = readALTargetGroupRef(message);
        const overlayId = this.readOutboundObservation(message).overlayId;
        const observation = {
            message,
            snapshot: roomRef ? this.readGroupSnapshotByRef(roomRef) : undefined,
            overlay: overlayId ? this.overlayCache.read(overlayId) : undefined,
            selfPeerId: this.connectionService.input.sessionId,
            nowMs: this.clock.nowMs()
        };
        if (ingressPeerId !== null) {
            const ingress = computeRtcRoomSnapshotAdmission({
                ...observation,
                fromPeerId: ingressPeerId,
                recipientPeerId: undefined
            });
            if (ingress.kind === 'pending' || ingress.kind === 'unauthorized') {
                return ingress;
            }
        }
        return computeRtcRoomSnapshotAdmission({ ...observation, fromPeerId: undefined, recipientPeerId });
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

    private toRepairTrackingPlan(
        effective: ALQosEffectivePolicy
    ): ALOutboundRepairTrackingPlan | undefined {
        if (effective.repair.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.repair.algo,
            maxAttempts: effective.repair.opts.maxRepairs
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

    private planRepairMessage(
        msg: ALMessage,
        request: ALOutboundRepairRequest
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
        if (request.requestedByPeerId) {
            return toRtcFrozenAudienceRepairPlan(
                this.planTargetedRepairDispatch(msg, request.requestedByPeerId, request.repair),
                this.connectionService.input.sessionId
            );
        }

        if (request.failedPeerIds.length > 0) {
            return planRtcFailedPeerRepair({
                msg,
                request,
                selfPeerId: this.connectionService.input.sessionId,
                planOutgoingMessage: (repairMsg) => this.planOutgoingMessage(repairMsg)
            });
        }

        return undefined;
    }

    private planTargetedRepairDispatch(
        msg: ALMessage,
        peerId: string,
        repair: ALOutboundRepairTrackingPlan
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
        if (peerId === this.connectionService.input.sessionId) {
            return undefined;
        }

        if (!this.connectionService.readyPeerIdsForLane().includes(peerId)) {
            return undefined;
        }

        const roomRef = readALTargetGroupRef(msg);
        const overlayId = this.readOutboundObservation(msg).overlayId;
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot: roomRef ? this.readGroupSnapshotByRef(roomRef) : undefined,
            overlay: overlayId ? this.overlayCache.read(overlayId) : undefined,
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId: undefined,
            recipientPeerId: peerId,
            nowMs: this.clock.nowMs()
        });
        if (admission.kind === 'unauthorized' || admission.kind === 'pending') {
            return {
                dropReason: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
                dropReasonCode: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
                persist: false,
                msg,
                preparedMessages: []
            };
        }
        const normalized = this.readOutgoingQosPolicy(msg, toAcceptedOverlayContext(this.readOutboundObservation(msg)));
        return {
            dropReasonCode: undefined,
            persist: false,
            msg,
            preparedMessages: [toRtcTargetedRepairCopy({
                dispatch: this.planOutgoingMessage(msg),
                msg,
                peerId,
                selfPeerId: this.connectionService.input.sessionId
            })],
            ackTracking: toRtcAckTrackingPlan(
                normalized.effective,
                [peerId],
                toRtcRetryExpectedPeerIdsUpdate(normalized.effective.ack.algo)
            ),
            repairTracking: repair
        };
    }
}

/** The five codes shared with inbound handling carry over; an inbound-only code has no outbound route concept. */
function toALOutboundDropReasonCodeFromHandlingPlan(
    code: ALMessageDropReasonCode | undefined
): ALOutboundDropReasonCode {
    switch (code) {
        case 'duplicate':
        case 'superseded':
        case 'expired':
        case 'not-yet-in-sync':
        case 'unauthorized':
            return code;
        case 'unmet-requirements':
        case 'ordering-rejected':
        case 'resync-required':
        case 'overloaded':
        case undefined:
            return 'planner-drop';
    }
}

function toAcceptedOverlayContext(observation: RtcOutboundObservation): OverlayMulticasterContext | undefined {
    const { overlayId, room, overlay, nowMs } = observation;
    const identity = room?.group.acceptedLayoutIdentity;
    if (
        !overlayId || !room || !overlay || overlay.provenance !== 'server' || overlay.state !== 'active' ||
        !isOverlayForGroupRef(overlay, room.group) || !identity || !isOverlayIdentity(overlay, identity)
    ) {
        return undefined;
    }
    return { overlayId, room, overlay, nowMs };
}
