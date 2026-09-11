import {
    isOverlayForGroupRef,
    isSameGroupRef,
    toScopedOverlayId
} from '@shared/api/api-type-utils.ts';

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
    type ALMessagePlanningObservations
} from '../al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus,
    ALOutboundPreparedSendResult,
    ALOutboundRuntimeDiagnosticsSink
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan
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
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '../api/group-types.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { NotReadyException } from '../queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxResilience } from '../queuebox/resource-inbox/resource-inbox-resilience.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { isOverlayIdentity } from '../repository/overlays-repository.ts';
import { CircuitBreaker } from '../resilience/circuit-breaker.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { QueueBoxUtilities } from '../services/queue-box-utilities.ts';
import type { WebRtcConnectionService } from '../services/web-rtc-connection-service.ts';
import type {
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
import {
    computeRtcRoomSnapshotAdmission,
    toRtcRoomSnapshotHandlingPlan,
    type RtcRoomSnapshotAdmission
} from './rtc-room-snapshot-admission.ts';
import { toRtcOutboundTracking } from './to-rtc-outbound-tracking.ts';
import { writeRtcChannelMessage } from './write-rtc-channel-message.ts';

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
                planDequeuedMessage: (msg) => this.planOutgoingMessage(msg, true),
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
                diagnostics: dependencies.outboundDiagnostics
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
                    WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
                        msg,
                        'rate-limited',
                        'RTC enqueue rate limit exceeded'
                    )
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
            return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
                msg,
                'circuit-open',
                'RTC enqueue circuit breaker open'
            );
        }

        return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
            msg,
            'failed',
            `RTC enqueue failed: ${error.message}`
        );
    }

    private static toProtectedEnqueueResult(
        msg: ALMessage,
        status: Extract<ALOutboundEnqueueStatus, 'rate-limited' | 'circuit-open' | 'failed'>,
        reason: string
    ): ALOutboundEnqueueResult {
        return {
            status,
            message: msg,
            entries: [],
            reason
        };
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        return {
            status: 'skipped',
            message: msg,
            entries: [],
            reason: 'RTC overlay multicast manager is disposed.'
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
        const context = toAcceptedOverlayContext(this.readOutboundObservation(msg));
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
        const observation = this.readOutboundObservation(msg);
        const nowMs = observations?.nowMs ?? observation.nowMs;
        const fromPeerId = source && source.kind !== 'trusted-server' ? source.peerId : undefined;
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot: observation.room,
            overlay: observation.overlay,
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId,
            recipientPeerId: undefined,
            nowMs
        });
        const messageContext = {
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId,
            connectedPeerIds: observation.connectedPeerIds,
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
        const overlayId = explicit ? explicitId : scoped ? scopedId : explicitId ?? scopedId;
        return {
            overlayId,
            overlay: explicit ?? scoped,
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
                    groupMemberPeerIds: context
                        ? readGroupMemberSessionIds(context.room)
                        : undefined,
                    overlayNeighborPeerIds: context?.overlay.nextHopSessionIds
                },
                this.qosProvider
            )
        );
    }

    private planOutgoingMessage(
        original: ALMessage,
        alreadyOwned = false
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        const observation = this.readOutboundObservation(original);
        const context = toAcceptedOverlayContext(observation);
        const qos = resolveALQosNormalizationInput(original, {
            direction: 'outbound',
            selfPeerId: this.connectionService.input.sessionId,
            connectedPeerIds: observation.connectedPeerIds,
            groupMemberPeerIds: observation.room ? readGroupMemberSessionIds(observation.room) : undefined,
            overlayNeighborPeerIds: context?.overlay.nextHopSessionIds
        }, this.qosProvider);
        const effective = normalizeALQosPolicy(original, qos).effective;
        const msg = toALOutboundMessage(original, effective);

        if (!msg.targets) {
            return this.toUnaddressedDispatchPlan(msg, effective);
        }

        if (msg.targets.mode === 'unicast') {
            return this.planOutboundDispatch(msg, this.planDirectDispatch(msg));
        }

        const admission = this.computeOutboundAuthority(msg, observation);
        if ((alreadyOwned || !context) && (admission.kind === 'pending' || admission.kind === 'unauthorized')) {
            if (alreadyOwned && admission.kind === 'pending') {
                throw new NotReadyException(50, admission.reason);
            }
            return {
                msg,
                persist: false,
                preparedMessages: [],
                dropReason: alreadyOwned
                    ? 'Skipping revoked RTC outbound authority'
                    : `Skipping RTC outbound message ${msg.id.msgId} without overlay context`
            };
        }
        if (!context) {
            const potential = admission.kind === 'authorized' ? admission.memberPeerIds : [];
            const handling = planALMessageHandling(msg, {
                nowMs: observation.nowMs,
                selfPeerId: this.connectionService.input.sessionId,
                connectedPeerIds: observation.connectedPeerIds,
                groupMemberPeerIds: potential,
                overlayNeighborPeerIds: potential
            }, qos);
            return this.planAbsentOverlay(msg, handling, alreadyOwned);
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        const plan = multicaster.createOriginatingPlan(msg, context, qos);
        return this.planOutboundDispatch(msg, {
            ...plan,
            handlingPlan: toRtcRoomSnapshotHandlingPlan(plan.handlingPlan, admission, undefined)
        });
    }

    private computeOutboundAuthority(msg: ALMessage, observation: RtcOutboundObservation): RtcRoomSnapshotAdmission {
        const groupRef = readALTargetGroupRef(msg);
        const overlay = observation.overlay;
        if (
            groupRef && overlay &&
            (overlay.provenance !== 'server' || overlay.state !== 'active' || !isOverlayForGroupRef(overlay, groupRef))
        ) {
            return { kind: 'unauthorized', reason: 'RTC selected topology is explicitly inactive or foreign' };
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
            return { kind: 'unauthorized', reason: 'RTC accepted room authority is not current and flowing' };
        }
        if (observation.overlay && !toAcceptedOverlayContext(observation)) {
            return { kind: 'unauthorized', reason: 'RTC selected topology is not the exact accepted room layout' };
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
                persist: false,
                preparedMessages: [],
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without overlay context`
            };
        }
        return {
            msg,
            persist: true,
            preparedMessages: [],
            ...toRtcOutboundTracking(handling.effective, msg, [])
        };
    }

    private toUnaddressedDispatchPlan(
        msg: ALMessage,
        effective: ALQosEffectivePolicy
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        if (!msg.forwarding?.nextHopPeerIds?.length) {
            return {
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without targets or next hop`,
                persist: false,
                msg,
                preparedMessages: []
            };
        }
        const tracking = toRtcOutboundTracking(effective, msg, msg.forwarding.nextHopPeerIds);
        return {
            persist: true,
            msg,
            preparedMessages: [toALOutboundTransportMessage(msg)],
            ackTracking: tracking.ackTracking,
            repairTracking: tracking.repairTracking,
            supersedenceTracking: tracking.supersedenceTracking
        };
    }

    private planOutboundDispatch(
        msg: ALMessage,
        plan: OverlayMulticastDispatchPlan
    ): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
        if (plan.handlingPlan.dropReason) {
            return {
                dropReason: `Skipping planned RTC dispatch: ${plan.handlingPlan.dropReason}`,
                persist: false,
                msg,
                preparedMessages: []
            };
        }

        if (plan.transportMessages.length === 0) {
            return {
                dropReason: this.describeNoDispatchReason(plan),
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
                    persist: false,
                    msg,
                    preparedMessages: []
                };
            }
        }

        return {
            persist: plan.handlingPlan.forwarding.persist,
            msg,
            preparedMessages: plan.transportMessages.map(toALOutboundTransportMessage),
            ...toRtcOutboundTracking(
                plan.handlingPlan.effective,
                plan.transportMessages[0],
                plan.transportMessages
                    .map((message) => message.forwarding?.nextHopPeerIds?.[0])
                    .filter((peerId): peerId is string => peerId !== undefined)
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
            return { status: 'cancelled', reason: 'RTC transport owner was disposed.' };
        }
        const nowMs = this.clock.nowMs();
        if (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= nowMs) {
            return { status: 'expired', reason: 'RTC message deadline elapsed before native submission.' };
        }
        const admission = this.readRtcDispatchAuthority(
            lifecycle.canonicalMessage,
            ingressPeerId,
            msg.forwarding?.nextHopPeerIds?.[0]
        );
        if (admission.kind === 'pending') {
            return { status: 'not-ready', reason: admission.reason, retryAfterMs: 50 };
        }
        if (admission.kind === 'unauthorized') {
            return { status: 'no-targets', reason: admission.reason };
        }
        const peerId = msg.forwarding?.nextHopPeerIds?.[0];
        if (!peerId) {
            return { status: 'no-targets', reason: 'Skipping RTC send without immediate next hop' };
        }

        const peer = this.connectionService.readPeer(peerId);
        if (!peer?.channel) {
            return {
                status: 'not-ready',
                reason: `No RTC channel for peer ${peerId}`,
                retryAfterMs: 50
            };
        }

        const health = peer.channel.readHealth();
        if (health.readyState !== 'open') {
            return {
                status: 'not-ready',
                reason: `RTC channel for peer ${peerId} is ${health.readyState}`,
                retryAfterMs: 50
            };
        }

        return writeRtcChannelMessage(peer.channel, msg, { lifecycle, clock: this.clock });
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
        if (logical.kind === 'pending' || logical.kind === 'unauthorized') {
            return logical;
        }
        const observation = {
            message,
            snapshot: outbound.room,
            overlay: outbound.overlay,
            selfPeerId: this.connectionService.input.sessionId,
            nowMs: outbound.nowMs
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

        const admission = this.readRtcDispatchAuthority(msg, null, peerId);
        if (admission.kind === 'unauthorized' || admission.kind === 'pending') {
            return {
                dropReason: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
                persist: false,
                msg,
                preparedMessages: []
            };
        }
        const normalized = this.readOutgoingQosPolicy(msg, toAcceptedOverlayContext(this.readOutboundObservation(msg)));
        const tracking = toRtcOutboundTracking(normalized.effective, msg, [peerId]);
        return {
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
            ackTracking: { ...tracking.ackTracking, mode: 'replace' },
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
