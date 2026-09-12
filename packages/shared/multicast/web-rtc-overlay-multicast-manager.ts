import {
    isOverlayForGroupRef,
    isSameGroupRef,
    toScopedOverlayId
} from '@shared/api/api-type-utils.ts';
import { toALOutboundMessage } from '../alm/outbound/to-al-outbound-message.ts';

import { ALMessage, readALTargetGroupRef } from '../al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../al-contracts/al-message-persistence-validation.ts';
import {
    ALMessageHandlingPlan,
    ALQosEffectivePolicy,
    ALQosInputProvider,
    ALQosNormalizationResult,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    type ALMessageDropReasonCode,
    type ALMessagePlanningObservations
} from '../al-contracts/al-policy.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliverySettlementSink
} from '../alm/delivery/al-delivery-lifecycle.ts';
import { toALOutboundEnqueueStatus } from '../alm/delivery/to-al-outbound-enqueue-status.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundPreparedSendResult,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundSettledSendResult
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundAckTrackingPlan,
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
import {
    EnqueuedType,
    OverlayId,
    OverlayInfo,
    PeerId
} from '../api/api-config.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '../api/group-types.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { NotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { CircuitBreaker } from '../resilience/circuit-breaker.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { QueueBoxUtilities } from '../services/queue-box-utilities.ts';
import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type {
    QRtcDataChannel,
    RtcDataChannelHealth,
    RtcDataChannelSendOptions,
    RtcDataChannelSendResult
} from '../webrtc/qrtc-data-channel.ts';
import {
    OverlayMulticastDispatchPlan,
    OverlayMulticasterContext,
    WebRtcOverlayMulticaster,
    WebRtcOverlayMulticasterFactory
} from './overlay-multicast-contracts.ts';
import { computeRtcRoomSnapshotAdmission, toRtcRoomSnapshotHandlingPlan } from './rtc-room-snapshot-admission.ts';

export namespace WebRtcOverlayMulticastManager {
    export interface Channel {
        readHealth(): Pick<RtcDataChannelHealth, 'readyState'>;
        sendJson(message: ALMessage, options?: RtcDataChannelSendOptions): RtcDataChannelSendResult;
    }

    export interface Peer {
        readonly channel: Channel | undefined;
    }

    export interface Connection {
        readonly input: Pick<WebRtcConnectionService['input'], 'sessionId'>;
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
    private readonly qosProvider?: ALQosInputProvider;
    private disposed = false;

    public readonly outbox: QueueBoxResourceEntryRepository;
    public readonly connectionService: WebRtcOverlayMulticastManager.Connection;
    public readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
    public readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
    public readonly multicasterFactory: WebRtcOverlayMulticasterFactory;
    private readonly circuitBreaker: CircuitBreaker;
    private readonly rateLimiter: RateLimiter;
    private readonly clock: ALOutboundMessageRuntime.Clock;

    constructor(dependencies: WebRtcOverlayMulticastManager.Dependencies) {
        this.outbox = dependencies.outboundRuntime.workQueue;
        this.connectionService = dependencies.connectionService;
        this.groupCache = dependencies.groupCache;
        this.overlayCache = dependencies.overlayCache;
        this.multicasterFactory = dependencies.multicasterFactory;
        this.circuitBreaker = dependencies.circuitBreaker;
        this.rateLimiter = dependencies.rateLimiter;
        this.qosProvider = dependencies.qosProvider;
        this.clock = dependencies.outboundRuntime.clock;
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

    async enqueueIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return WebRtcOverlayMulticastManager.toDisposedEnqueueResult(msg);
        }

        const either = await CircuitBreaker.tryToExecute<ALOutboundEnqueueResult>(
            this.circuitBreaker,
            () => {
                return RateLimiter.tryToExecuteOrDefault<ALOutboundEnqueueResult>(
                    this.rateLimiter,
                    () => this.outboundRuntime.enqueueIfAbsent(msg),
                    WebRtcOverlayMulticastManager.toProtectedEnqueueResult(msg, {
                        kind: 'unroutable',
                        reason: 'rate-limited',
                        detail: 'RTC enqueue rate limit exceeded'
                    })
                );
            },
            WebRtcOverlayMulticastManager.isSuccessfulProtectedEnqueueResult
        );

        return either.fold(
            (error) =>
                WebRtcOverlayMulticastManager.toCircuitBreakerResult(
                    msg,
                    error
                ),
            (value) => value
        );
    }

    private static isSuccessfulProtectedEnqueueResult(
        value: ALOutboundEnqueueResult
    ): boolean {
        return value.status !== 'failed' &&
            value.status !== 'rate-limited' &&
            value.status !== 'circuit-open';
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
        return {
            status: toALOutboundEnqueueStatus(verdict),
            verdict,
            message: msg,
            entries: [],
            reason: verdict.detail
        };
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        const verdict: ALDeliveryAdmissionVerdict = {
            kind: 'skipped',
            reason: 'disposed',
            detail: 'RTC overlay multicast manager is disposed.'
        };
        return {
            status: toALOutboundEnqueueStatus(verdict),
            verdict,
            message: msg,
            entries: [],
            reason: verdict.detail
        };
    }

    async forwardIfRequired(
        msg: ALMessage,
        fromPeerId?: PeerId
    ): Promise<readonly ResourceEntry[]> {
        if (!msg.targets) {
            return [];
        }

        if (msg.targets.mode === 'unicast') {
            return [];
        }

        const source = fromPeerId === undefined ? undefined : { kind: 'rtc-peer' as const, peerId: fromPeerId };
        const admissionPlan = this.planIncomingMessage(msg, source);
        if (admissionPlan.dropReason) {
            return [];
        }
        const context = this.readOverlayContext(msg);
        if (!context) {
            return [];
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        const dispatchPlan = multicaster.createForwardingPlan(
            msg,
            context,
            {
                fromPeerId,
                qos: resolveALQosNormalizationInput(
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
                )
            }
        );

        const message = toALOutboundMessage(msg, dispatchPlan.handlingPlan.effective);
        const planned = this.planOutboundDispatch(message, dispatchPlan);
        const admitted = await this.outboundRuntime.enqueueIfAbsent(
            message,
            {
                ...planned,
                preparedMessages: planned.preparedMessages.map((prepared) => ({
                    ...prepared,
                    ingressPeerId: fromPeerId ?? null
                }))
            }
        );
        return admitted.entries;
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
        const overlayId = this.readOverlayId(msg);
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

        await this.outboundRuntime.acceptControlMessage(msg);
    }

    private readOverlayContext(
        msg: ALMessage
    ): OverlayMulticasterContext | undefined {
        const overlayId = this.readOverlayId(msg);
        if (!overlayId) {
            return undefined;
        }

        const groupRef = readALTargetGroupRef(msg);
        const room = groupRef
            ? this.readGroupSnapshotByRef(groupRef)
            : this.groupCache.read(overlayId);
        if (!room) {
            console.warn(`No GroupSnapshot found for overlayId/groupId ${overlayId}`);
            return undefined;
        }

        const overlay = this.overlayCache.read(overlayId);
        if (!overlay || overlay.state === 'removed') {
            console.warn(`No OverlayInfo found for overlayId/groupId ${overlayId}`);
            return undefined;
        }
        if (groupRef && !isOverlayForGroupRef(overlay, groupRef)) {
            console.warn(
                `Overlay ${overlayId} does not match scoped target ${toScopedOverlayId(groupRef)}`
            );
            return undefined;
        }

        return {
            overlayId,
            room,
            overlay,
            nowMs: this.clock.nowMs()
        };
    }

    private readGroupSnapshotByRef(ref: GroupRef): GroupSnapshot | undefined {
        return this.groupCache.readAllValues()
            .find((group) => isSameGroupRef(group.group, ref));
    }

    private readOverlayId(msg: ALMessage): OverlayId | undefined {
        const targetGroupRef = readALTargetGroupRef(msg);
        const explicitOverlayId = msg.forwarding?.overlayId;

        if (explicitOverlayId && this.readOverlayPresence(explicitOverlayId)) {
            return explicitOverlayId;
        }

        if (targetGroupRef) {
            const scopedOverlayId = toScopedOverlayId(targetGroupRef);
            if (this.readOverlayPresence(scopedOverlayId)) {
                return scopedOverlayId;
            }
        }

        if (explicitOverlayId) {
            return explicitOverlayId;
        }

        if (msg.targets?.mode === 'multicast') {
            return msg.targets.groupRef.groupId;
        }

        if (msg.targets?.mode === 'broadcast') {
            return msg.route.contextId;
        }

        return undefined;
    }

    private readOverlayPresence(overlayId: OverlayId): boolean {
        const overlay = this.overlayCache.read(overlayId);
        return overlay !== undefined;
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
                    groupMemberPeerIds: context
                        ? readGroupMemberSessionIds(context.room)
                        : undefined,
                    overlayNeighborPeerIds: context?.overlay.nextHopSessionIds
                },
                this.qosProvider
            )
        );
    }

    private planDequeuedMessage(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const admissionPlan = this.planIncomingMessage(msg);
        if (admissionPlan.dropReasonCode === 'not-yet-in-sync') {
            throw new NotReadyException(50, 'Awaiting RTC room authority before dequeuing the transport copy');
        }
        return this.planOutgoingMessage(msg);
    }

    private planOutgoingMessage(original: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const context = this.readOverlayContext(original);
        const msg = toALOutboundMessage(original, this.readOutgoingQosPolicy(original, context).effective);

        if (!msg.targets) {
            return this.toUnaddressedDispatchPlan(msg, this.readOutgoingQosPolicy(msg, context).effective);
        }

        if (msg.targets.mode === 'unicast') {
            return this.planOutboundDispatch(msg, this.planDirectDispatch(msg));
        }

        if (!context) {
            return {
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without overlay context`,
                dropReasonCode: 'no-route',
                persist: false,
                msg,
                preparedMessages: []
            };
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
            ackTracking: this.toAckTrackingPlan(effective, msg.forwarding.nextHopPeerIds),
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

        if (!plan.handlingPlan.forwarding.persist) {
            const missingPeerId = plan.transportMessages
                .map((message) => message.forwarding?.nextHopPeerIds?.[0])
                .find((peerId) =>
                    peerId !== undefined &&
                    !this.connectionService.readPeer(peerId)?.channel
                );
            if (missingPeerId) {
                return {
                    dropReason: `Skipping immediate RTC dispatch without RTC channel for peer ${missingPeerId}`,
                    dropReasonCode: 'no-route',
                    persist: false,
                    msg,
                    preparedMessages: []
                };
            }
        }

        return {
            dropReasonCode: undefined,
            persist: plan.handlingPlan.forwarding.persist,
            msg,
            preparedMessages: plan.transportMessages.map(toALOutboundTransportMessage),
            ackTracking: this.toAckTrackingPlan(
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
        if (admission.kind === 'pending') {
            return { status: 'not-ready', submissionAttempted: false, reason: admission.reason, retryAfterMs: 50 };
        }
        if (admission.kind === 'unauthorized') {
            return { status: 'no-targets', submissionAttempted: false, reason: admission.reason };
        }
        const peerId = msg.forwarding?.nextHopPeerIds?.[0];
        if (!peerId) {
            return {
                status: 'no-targets',
                submissionAttempted: false,
                reason: 'Skipping RTC send without immediate next hop'
            };
        }

        const peer = this.connectionService.readPeer(peerId);
        if (!peer?.channel) {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `No RTC channel for peer ${peerId}`,
                retryAfterMs: 50
            };
        }

        const health = peer.channel.readHealth();
        if (health.readyState !== 'open') {
            return {
                status: 'not-ready',
                submissionAttempted: false,
                reason: `RTC channel for peer ${peerId} is ${health.readyState}`,
                retryAfterMs: 50
            };
        }

        return this.submitPreparedMessage(peer.channel, msg, lifecycle);
    }

    private readPendingAdmissionAuthority(
        message: ALMessage,
        preparedMessages: readonly ALOutboundTransportMessage[]
    ): ALOutboundMessageRuntime.PendingAdmissionAuthority {
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
        const roomRef = readALTargetGroupRef(message);
        const overlayId = this.readOverlayId(message);
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

    private submitPreparedMessage(
        channel: WebRtcOverlayMulticastManager.Channel,
        msg: ALMessage,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): ALOutboundPreparedSendResult {
        // Promise's executor runs synchronously, before the transport registers this completion callback.
        let resolveSettlement!: (value: QRtcDataChannel.SendSettlement) => void;
        const settled = new Promise<QRtcDataChannel.SendSettlement>((resolve) => {
            resolveSettlement = resolve;
        });
        const expiresAtEpochMs = Math.min(lifecycle.expiresAtMs ?? Infinity, lifecycle.leaseUntilMs ?? Infinity);
        const result = channel.sendJson(msg, {
            signal: lifecycle.signal,
            expiresAtEpochMs: Number.isFinite(expiresAtEpochMs) ? expiresAtEpochMs : undefined,
            onSettled: resolveSettlement
        });
        if (result.status === 'queued' || result.status === 'replaced') {
            return {
                status: 'queued',
                settled: settled.then((value) =>
                    toALOutboundRtcSettlement({
                        status: value.status,
                        submissionAttempted: value.submissionAttempted,
                        reason: value.reason,
                        messageExpiresAtMs: lifecycle.expiresAtMs,
                        observedAtMs: this.clock.nowMs()
                    })
                )
            };
        }
        return toALOutboundRtcSettlement({
            status: result.status,
            submissionAttempted: result.status === 'sent',
            reason: result.reason,
            messageExpiresAtMs: lifecycle.expiresAtMs,
            observedAtMs: this.clock.nowMs()
        });
    }

    private toAckTrackingPlan(
        effective: ALQosEffectivePolicy,
        expectedPeerIds: readonly string[],
        mode?: 'merge' | 'replace'
    ): ALOutboundAckTrackingPlan | undefined {
        if (effective.ack.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            timeoutMs: effective.ack.opts.timeoutMs,
            maxAttempts: effective.retry.algo === 'none'
                ? 0
                : effective.retry.opts.maxAttempts,
            expectedPeerIds: [...new Set(expectedPeerIds)],
            mode
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
            return this.planTargetedRepairDispatch(
                msg,
                request.requestedByPeerId,
                request.repair
            );
        }

        if (request.failedPeerIds.length > 0) {
            return this.planAlternateParentRepairDispatch(msg, request);
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
        const overlayId = this.readOverlayId(msg);
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
        const normalized = this.readOutgoingQosPolicy(msg, this.readOverlayContext(msg));
        return {
            dropReasonCode: undefined,
            persist: false,
            msg,
            preparedMessages: [
                toALOutboundTransportMessage({
                    ...msg,
                    forwarding: {
                        ...msg.forwarding,
                        nextHopPeerIds: [peerId]
                    }
                })
            ],
            ackTracking: this.toAckTrackingPlan(
                normalized.effective,
                [peerId],
                'replace'
            ),
            repairTracking: repair
        };
    }

    private planAlternateParentRepairDispatch(
        msg: ALMessage,
        request: ALOutboundRepairRequest
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> | undefined {
        if (!msg.targets || msg.targets.mode === 'unicast') {
            return undefined;
        }

        const excludedPeerIds = new Set([
            ...(msg.diagnostics?.visitedPeerIds ?? []),
            ...request.failedPeerIds
        ]);
        const repairMsg: ALMessage = {
            ...msg,
            diagnostics: {
                ...msg.diagnostics,
                visitedPeerIds: [...excludedPeerIds]
            }
        };

        const dispatchPlan = this.planOutgoingMessage(repairMsg);
        if (dispatchPlan.preparedMessages.length === 0) {
            return undefined;
        }

        return {
            ...dispatchPlan,
            msg,
            ackTracking: dispatchPlan.ackTracking
                ? {
                    ...dispatchPlan.ackTracking,
                    mode: 'replace'
                }
                : undefined,
            repairTracking: request.repair
        };
    }
}

interface ALOutboundRtcSettlementInput {
    readonly status: QRtcDataChannel.SendSettlement['status'];
    readonly submissionAttempted: boolean;
    readonly reason: string | undefined;
    readonly messageExpiresAtMs: number | undefined;
    readonly observedAtMs: number;
}

function toALOutboundRtcSettlement(input: ALOutboundRtcSettlementInput): ALOutboundSettledSendResult {
    const { status, submissionAttempted, reason, messageExpiresAtMs, observedAtMs } = input;
    if (status === 'expired' && (messageExpiresAtMs === undefined || observedAtMs < messageExpiresAtMs)) {
        return {
            status: 'not-ready',
            submissionAttempted,
            reason: 'RTC attempt lease elapsed before native submission.',
            retryAfterMs: 50
        };
    }
    if (status === 'failed' && submissionAttempted) {
        return { status: 'failed', submissionAttempted, reason, retryAfterMs: 50 };
    }
    if (status === 'dropped' || status === 'closed' || status === 'failed') {
        return { status: 'not-ready', submissionAttempted, reason, retryAfterMs: 50 };
    }
    return { status, submissionAttempted, reason };
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
