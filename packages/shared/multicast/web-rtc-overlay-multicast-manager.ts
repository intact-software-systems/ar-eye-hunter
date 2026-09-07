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
    resolveSupersedenceKey,
    type ALMessagePlanningObservations
} from '../al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import { decodeALOutboundPreparedMessage } from '../alm/outbound/al-outbound-effect-validation.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus,
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
    ALOutboundSupersedenceTrackingPlan
} from '../alm/outbound/al-outbound-message-runtime.ts';
import {
    EnqueuedType,
    OverlayId,
    OverlayInfo,
    PeerId
} from '../api/api-config.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '../api/group-types.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { CircuitBreaker } from '../resilience/circuit-breaker.ts';
import { RateLimiter } from '../resilience/Resilience.ts';
import { QueueBoxUtilities } from '../services/QueueBoxUtilities.ts';
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
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly connectionService: Connection;
        readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
        readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
        readonly multicasterFactory: WebRtcOverlayMulticasterFactory;
        readonly qosProvider: ALQosInputProvider | undefined;
        readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly outboundRuntime: ALOutboundMessageRuntime.Resources;
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
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALMessage>;
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
        this.outbox = dependencies.outbox;
        this.connectionService = dependencies.connectionService;
        this.groupCache = dependencies.groupCache;
        this.overlayCache = dependencies.overlayCache;
        this.multicasterFactory = dependencies.multicasterFactory;
        this.circuitBreaker = dependencies.circuitBreaker;
        this.rateLimiter = dependencies.rateLimiter;
        this.qosProvider = dependencies.qosProvider;
        this.clock = dependencies.outboundRuntime.clock;
        this.outboundRuntime = new ALOutboundMessageRuntime<ALMessage>(
            {
                ...dependencies.outboundRuntime,
                decodePreparedMessage: decodeALOutboundPreparedMessage,
                outbox: this.outbox,
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WebRtcOverlayMulticastManager.ENQUEUE_TYPE
                    ),
                readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
                planOutgoingMessage: (msg) => this.planOutgoingMessage(msg),
                planDequeuedMessage: (msg) => this.planDequeuedMessage(msg),
                beforeDequeueDispatch: undefined,
                onFallbackDequeue: undefined,
                sendPreparedMessage: async (msg, _phase, lifecycle) => await this.sendPreparedMessage(msg, lifecycle),
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

        return await this.dispatchPlan(dispatchPlan);
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

    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        if (this.disposed) {
            return;
        }

        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async acceptControlMessage(msg: ALMessage): Promise<void> {
        if (this.disposed) {
            return;
        }

        await this.outboundRuntime.acceptControlMessage(msg);
    }

    private async dispatchPlan(
        plan: OverlayMulticastDispatchPlan
    ): Promise<readonly ResourceEntry[]> {
        if (plan.handlingPlan.dropReason) {
            console.warn(
                `Skipping planned RTC forwarding dispatch: ${plan.handlingPlan.dropReason}`
            );
            return [];
        }

        if (plan.transportMessages.length === 0) {
            console.warn(this.describeNoDispatchReason(plan));
            return [];
        }

        if (plan.handlingPlan.forwarding.persist) {
            return await this.enqueueMany(plan.transportMessages);
        }

        await this.sendImmediately(plan.transportMessages);
        return [];
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

    private planDequeuedMessage(msg: ALMessage): ALOutboundDispatchPlan<ALMessage> {
        const admissionPlan = this.planIncomingMessage(msg);
        if (admissionPlan.dropReason === 'not-yet-in-sync') {
            throw new Error('Awaiting RTC room authority before dequeuing the transport copy');
        }
        return this.planOutgoingMessage(msg);
    }

    private planOutgoingMessage(msg: ALMessage): ALOutboundDispatchPlan<ALMessage> {
        const context = this.readOverlayContext(msg);

        if (!msg.targets) {
            return this.toUnaddressedDispatchPlan(msg, this.readOutgoingQosPolicy(msg, context).effective);
        }

        if (msg.targets.mode === 'unicast') {
            return this.planOutboundDispatch(this.planDirectDispatch(msg));
        }

        if (!context) {
            return {
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without overlay context`,
                persist: false,
                preparedMessages: []
            };
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        return this.planOutboundDispatch(
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
    ): ALOutboundDispatchPlan<ALMessage> {
        if (!msg.forwarding?.nextHopPeerIds?.length) {
            return {
                dropReason: `Skipping RTC outbound message ${msg.id.msgId} without targets or next hop`,
                persist: false,
                preparedMessages: []
            };
        }
        return {
            persist: true,
            preparedMessages: [msg],
            ackTracking: this.toAckTrackingPlan(effective, msg.forwarding.nextHopPeerIds),
            repairTracking: this.toRepairTrackingPlan(effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(effective, msg)
        };
    }

    private planOutboundDispatch(plan: OverlayMulticastDispatchPlan): ALOutboundDispatchPlan<ALMessage> {
        if (plan.handlingPlan.dropReason) {
            return {
                dropReason: `Skipping planned RTC dispatch: ${plan.handlingPlan.dropReason}`,
                persist: false,
                preparedMessages: []
            };
        }

        if (plan.transportMessages.length === 0) {
            return {
                dropReason: this.describeNoDispatchReason(plan),
                persist: false,
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
                    preparedMessages: []
                };
            }
        }

        return {
            persist: plan.handlingPlan.forwarding.persist,
            preparedMessages: plan.transportMessages,
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
        lifecycle: ALOutboundMessageRuntime.SendLifecycle
    ): Promise<ALOutboundPreparedSendResult> {
        if (lifecycle.signal.aborted) {
            return { status: 'cancelled', reason: 'RTC transport owner was disposed.' };
        }
        const nowMs = this.clock.nowMs();
        if (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= nowMs) {
            return { status: 'expired', reason: 'RTC message deadline elapsed before native submission.' };
        }
        const roomRef = readALTargetGroupRef(msg);
        const overlayId = this.readOverlayId(msg);
        const admission = computeRtcRoomSnapshotAdmission({
            message: msg,
            snapshot: roomRef ? this.readGroupSnapshotByRef(roomRef) : undefined,
            overlay: overlayId ? this.overlayCache.read(overlayId) : undefined,
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId: undefined,
            recipientPeerId: msg.forwarding?.nextHopPeerIds?.[0],
            nowMs
        });
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

        return this.submitPreparedMessage(peer.channel, msg, lifecycle);
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
                        reason: value.reason,
                        messageExpiresAtMs: lifecycle.expiresAtMs,
                        observedAtMs: this.clock.nowMs()
                    })
                )
            };
        }
        return toALOutboundRtcSettlement({
            status: result.status,
            reason: result.reason,
            messageExpiresAtMs: lifecycle.expiresAtMs,
            observedAtMs: this.clock.nowMs()
        });
    }

    private async sendImmediately(messages: readonly ALMessage[]): Promise<void> {
        for (const message of messages) {
            await this.sendPreparedMessage(message, {
                signal: this.outboundRuntime.sendSignal,
                expiresAtMs: message.constraints?.expiresAtMs,
                leaseUntilMs: undefined
            });
        }
    }

    private async enqueueMany(
        messages: readonly ALMessage[]
    ): Promise<readonly ResourceEntry[]> {
        const entries: ResourceEntry[] = [];

        for (const message of messages) {
            entries.push(
                await this.outbox.enqueueIfAbsent(
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        message,
                        WebRtcOverlayMulticastManager.ENQUEUE_TYPE
                    )
                )
            );
        }

        return entries;
    }

    private toAckTrackingPlan(
        effective: ALQosEffectivePolicy,
        expectedPeerIds: readonly string[],
        mode?: 'merge' | 'replace'
    ): ALOutboundAckTrackingPlan | undefined {
        if (effective.ack.algo === 'none' || expectedPeerIds.length === 0) {
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
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
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
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
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
                persist: false,
                preparedMessages: []
            };
        }
        const normalized = this.readOutgoingQosPolicy(msg, this.readOverlayContext(msg));
        return {
            persist: false,
            preparedMessages: [
                {
                    ...msg,
                    forwarding: {
                        ...msg.forwarding,
                        nextHopPeerIds: [peerId]
                    }
                }
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
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
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
    readonly reason: string | undefined;
    readonly messageExpiresAtMs: number | undefined;
    readonly observedAtMs: number;
}

function toALOutboundRtcSettlement(input: ALOutboundRtcSettlementInput): ALOutboundSettledSendResult {
    const { status, reason, messageExpiresAtMs, observedAtMs } = input;
    if (status === 'expired' && (messageExpiresAtMs === undefined || observedAtMs < messageExpiresAtMs)) {
        return { status: 'not-ready', reason: 'RTC attempt lease elapsed before native submission.', retryAfterMs: 50 };
    }
    if (status === 'dropped' || status === 'closed' || status === 'failed') {
        return { status: 'not-ready', reason, retryAfterMs: 50 };
    }
    return { status, reason };
}
