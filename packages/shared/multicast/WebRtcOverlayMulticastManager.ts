import { QueueBoxResourceEntryRepository } from '../queuebox/QueueBoxTypes.ts';
import { ResilienceDto } from '../queuebox/DequeueResourceEntryController.ts';
import { QueueBoxUtilities } from '../services/QueueBoxUtilities.ts';
import { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import { ALMessage } from '../al-contracts/al-contract.ts';
import {
    ALMessageHandlingPlan,
    ALQosInputProvider,
    normalizeALQosPolicy,
    planALMessageHandling,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
} from '../al-contracts/al-policy.ts';
import type { ALDedupStoreLike, ALOrderingStoreLike, ALSupersedenceStoreLike, } from '../al-contracts/al-runtime.ts';
import { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { EnqueuedType, OverlayId, OverlayInfo, PeerId, } from '../api/api-config.ts';
import { type AnyGroupPresence, readGroupMemberSessionIds, } from '../api/group-client-views.ts';
import {
    OverlayMulticastDispatchPlan,
    OverlayMulticasterContext,
    WebRtcOverlayMulticaster,
    WebRtcOverlayMulticasterFactory,
} from './OverlayMulticastContracts.ts';
import { WebRtcConnectionService } from '../services/WebRtcConnectionService.ts';
import type {
    ALOutboundEnqueueResult,
    ALOutboundEnqueueStatus,
    ALOutboundRuntimeStores,
} from '../alm/ALOutboundMessageRuntime.ts';
import {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRepairTrackingPlan,
    ALOutboundSupersedenceTrackingPlan,
} from '../alm/ALOutboundMessageRuntime.ts';
import { CircuitBreaker, RateLimiter, toCircuitBreaker, toRateLimiter, } from '../resilience/Resilience.ts';

export type WebRtcOverlayMulticastManagerOptions = Readonly<{
    qosProvider?: ALQosInputProvider;
    outboundStores?: ALOutboundRuntimeStores;
}>;

export class WebRtcOverlayMulticastManager {
    public static readonly ENQUEUE_TYPE = EnqueuedType.RTC_OUTBOX;
    public static readonly OUTBOX_DEQUEUE_TYPES = new Set<string>([
        this.ENQUEUE_TYPE,
    ]);

    private readonly multicasterByOverlayId = new Map<
        OverlayId,
        WebRtcOverlayMulticaster
    >();
    private readonly outboundRuntime: ALOutboundMessageRuntime<ALMessage>;
    private readonly qosProvider?: ALQosInputProvider;

    constructor(
        public readonly outbox: QueueBoxResourceEntryRepository,
        public readonly connectionService: WebRtcConnectionService,
        public readonly groupCache: ReadableKeyedValues<string, AnyGroupPresence>,
        public readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>,
        public readonly multicasterFactory: WebRtcOverlayMulticasterFactory,
        options: WebRtcOverlayMulticastManagerOptions = {},
        private readonly circuitBreaker: CircuitBreaker = toCircuitBreaker(),
        private readonly rateLimiter: RateLimiter = toRateLimiter(),
    ) {
        this.qosProvider = options.qosProvider;
        this.outboundRuntime = new ALOutboundMessageRuntime<ALMessage>(
            {
                stores: options.outboundStores,
                outbox: this.outbox,
                toOutboxEntry: (msg) =>
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        msg,
                        WebRtcOverlayMulticastManager.ENQUEUE_TYPE,
                    ),
                readMessageFromEntry: (entry) =>
                    JSON.parse(entry.resource) as ALMessage,
                planOutgoingMessage: (msg) => this.planOutgoingMessage(msg),
                sendPreparedMessage: async (msg, phase) =>
                    await this.sendPreparedMessage(msg, phase),
                planRepairMessage: async (msg, request) =>
                    await this.planRepairMessage(msg, request),
            },
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

    async enqueueIfAbsent(msg: ALMessage): Promise<ALOutboundEnqueueResult> {
        const either =
            await CircuitBreaker.tryToExecute<ALOutboundEnqueueResult>(
                this.circuitBreaker,
                () => {
                    return RateLimiter.tryToExecuteOrDefault<ALOutboundEnqueueResult>(
                        this.rateLimiter,
                        () => this.outboundRuntime.enqueueIfAbsent(msg),
                        WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
                            msg,
                            'rate-limited',
                            'RTC enqueue rate limit exceeded',
                        ),
                    );
                },
                WebRtcOverlayMulticastManager.isSuccessfulProtectedEnqueueResult,
            );

        return either.fold(
            (error) => WebRtcOverlayMulticastManager.toCircuitBreakerResult(
                msg,
                error,
            ),
            (value) => value,
        );
    }

    private static isSuccessfulProtectedEnqueueResult(
        value: ALOutboundEnqueueResult,
    ): boolean {
        return value.status !== 'failed' &&
            value.status !== 'rate-limited' &&
            value.status !== 'circuit-open';
    }

    private static toCircuitBreakerResult(
        msg: ALMessage,
        error: Error,
    ): ALOutboundEnqueueResult {
        if (error.message === 'Not allowed to execute') {
            return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
                msg,
                'circuit-open',
                'RTC enqueue circuit breaker open',
            );
        }

        return WebRtcOverlayMulticastManager.toProtectedEnqueueResult(
            msg,
            'failed',
            `RTC enqueue failed: ${error.message}`,
        );
    }

    private static toProtectedEnqueueResult(
        msg: ALMessage,
        status: Extract<
            ALOutboundEnqueueStatus,
            'rate-limited' | 'circuit-open' | 'failed'
        >,
        reason: string,
    ): ALOutboundEnqueueResult {
        return {
            status,
            message: msg,
            entries: [],
            reason,
        };
    }

    async forwardIfRequired(
        msg: ALMessage,
        fromPeerId?: PeerId,
    ): Promise<readonly ResourceEntry[]> {
        if (!msg.targets) {
            return [];
        }

        if (msg.targets.mode === 'unicast') {
            return [];
        }

        const context = this.resolveContext(msg);
        if (!context) {
            return [];
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        const dispatchPlan = multicaster.createForwardingPlan(
            msg,
            context,
            fromPeerId,
            resolveALQosNormalizationInput(
                msg,
                {
                    direction: 'outbound',
                    selfPeerId: this.connectionService.input.sessionId,
                    fromPeerId,
                    connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                    groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                    overlayNeighborPeerIds: context.overlay.nextHopSessionIds,
                },
                this.qosProvider,
            ),
        );

        return await this.dispatchPlan(dispatchPlan);
    }

    planIncomingMessage(
        msg: ALMessage,
        fromPeerId?: PeerId,
        runtime?: Readonly<{
            dedupStore?: ALDedupStoreLike;
            orderingStore?: ALOrderingStoreLike;
            supersedenceStore?: ALSupersedenceStoreLike;
        }>,
    ): ALMessageHandlingPlan {
        const baseContext = {
            selfPeerId: this.connectionService.input.sessionId,
            fromPeerId,
            connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
            dedupStore: runtime?.dedupStore,
            orderingStore: runtime?.orderingStore,
            supersedenceStore: runtime?.supersedenceStore,
        };
        const normalizationInput = resolveALQosNormalizationInput(
            msg,
            {
                direction: 'inbound',
                selfPeerId: this.connectionService.input.sessionId,
                fromPeerId,
                connectedPeerIds: baseContext.connectedPeerIds,
            },
            this.qosProvider,
        );

        if (!msg.targets || msg.targets.mode === 'unicast') {
            return planALMessageHandling(msg, baseContext, normalizationInput);
        }

        const context = this.resolveContext(msg);
        if (!context) {
            return planALMessageHandling(msg, baseContext, normalizationInput);
        }

        return planALMessageHandling(
            msg,
            {
                ...baseContext,
                groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                overlayNeighborPeerIds: context.overlay.nextHopSessionIds,
            },
            resolveALQosNormalizationInput(
                msg,
                {
                    direction: 'inbound',
                    selfPeerId: this.connectionService.input.sessionId,
                    fromPeerId,
                    connectedPeerIds: baseContext.connectedPeerIds,
                    groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                    overlayNeighborPeerIds: context.overlay.nextHopSessionIds,
                },
                this.qosProvider,
            ),
        );
    }

    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto,
    ): Promise<void> {
        await this.outboundRuntime.dequeue(typesToDequeue, resilience);
    }

    async acceptControlMessage(msg: ALMessage): Promise<void> {
        await this.outboundRuntime.acceptControlMessage(msg);
    }

    private async dispatchPlan(
        plan: OverlayMulticastDispatchPlan,
    ): Promise<readonly ResourceEntry[]> {
        if (plan.handlingPlan.dropReason) {
            console.warn(
                `Skipping planned RTC forwarding dispatch: ${plan.handlingPlan.dropReason}`,
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

    private resolveContext(
        msg: ALMessage,
    ): OverlayMulticasterContext | undefined {
        const overlayId = this.resolveOverlayId(msg);
        if (!overlayId) {
            return undefined;
        }

        const room = this.groupCache.read(overlayId) ??
            this.groupCache.peek(overlayId);
        if (!room) {
            console.warn(`No GroupSnapshot found for overlayId/groupId ${overlayId}`);
            return undefined;
        }

        const overlay = this.overlayCache.read(overlayId) ??
            this.overlayCache.peek(overlayId);
        if (!overlay) {
            console.warn(`No OverlayInfo found for overlayId/groupId ${overlayId}`);
            return undefined;
        }

        return {
            overlayId,
            room,
            overlay,
        };
    }

    private resolveOverlayId(msg: ALMessage): OverlayId | undefined {
        if (msg.forwarding?.overlayId) {
            return msg.forwarding.overlayId;
        }

        if (msg.targets?.mode === 'multicast') {
            return msg.targets.groupId;
        }

        if (msg.targets?.mode === 'broadcast') {
            return msg.route.contextId;
        }

        return undefined;
    }

    private createDirectDispatchPlan(
        msg: ALMessage,
    ): OverlayMulticastDispatchPlan {
        const handlingPlan = this.planIncomingMessage(msg);

        return {
            handlingPlan,
            transportMessages: handlingPlan.forwarding.nextHopPeerIds.map((
                peerId,
            ) => ({
                ...msg,
                forwarding: {
                    ...msg.forwarding,
                    nextHopPeerIds: [peerId],
                },
            })),
        };
    }

    private normalizeOutgoingPolicy(
        msg: ALMessage,
        context = this.resolveContext(msg),
    ) {
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
                    overlayNeighborPeerIds: context?.overlay.nextHopSessionIds,
                },
                this.qosProvider,
            ),
        );
    }

    private planOutgoingMessage(msg: ALMessage) {
        const context = this.resolveContext(msg);
        const normalized = this.normalizeOutgoingPolicy(msg, context);

        if (!msg.targets) {
            return msg.forwarding?.nextHopPeerIds?.length
                ? {
                    persist: true,
                    preparedMessages: [msg],
                    ackTracking: this.toAckTrackingPlan(
                        normalized.effective,
                        msg.forwarding.nextHopPeerIds,
                    ),
                    repairTracking: this.toRepairTrackingPlan(normalized.effective),
                    supersedenceTracking: this.toSupersedenceTrackingPlan(
                        normalized.effective,
                        msg,
                    ),
                }
                : {
                    dropReason:
                        `Skipping RTC outbound message ${msg.id.msgId} without targets or next hop`,
                    persist: false,
                    preparedMessages: [],
                };
        }

        if (msg.targets.mode === 'unicast') {
            return this.toOutboundDispatchPlan(this.createDirectDispatchPlan(msg));
        }

        if (!context) {
            return {
                dropReason:
                    `Skipping RTC outbound message ${msg.id.msgId} without overlay context`,
                persist: false,
                preparedMessages: [],
            };
        }

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        return this.toOutboundDispatchPlan(
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
                        overlayNeighborPeerIds: context.overlay.nextHopSessionIds,
                    },
                    this.qosProvider,
                ),
            ),
        );
    }

    private toOutboundDispatchPlan(plan: OverlayMulticastDispatchPlan) {
        if (plan.handlingPlan.dropReason) {
            return {
                dropReason:
                    `Skipping planned RTC dispatch: ${plan.handlingPlan.dropReason}`,
                persist: false,
                preparedMessages: [],
            };
        }

        if (plan.transportMessages.length === 0) {
            return {
                dropReason: this.describeNoDispatchReason(plan),
                persist: false,
                preparedMessages: [],
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
                    dropReason:
                        `Skipping immediate RTC dispatch without RTC channel for peer ${missingPeerId}`,
                    persist: false,
                    preparedMessages: [],
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
                    .filter((peerId): peerId is string => peerId !== undefined),
            ),
            repairTracking: this.toRepairTrackingPlan(plan.handlingPlan.effective),
            supersedenceTracking: this.toSupersedenceTrackingPlan(
                plan.handlingPlan.effective,
                plan.transportMessages[0],
            ),
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
        phase: ALOutboundDispatchPhase,
    ): Promise<void> {
        const peerId = msg.forwarding?.nextHopPeerIds?.[0];
        if (!peerId) {
            const reason = 'Skipping RTC send without immediate next hop';
            if (phase === 'dequeue') {
                throw new Error(reason);
            }

            console.warn(reason);
            return;
        }

        const peer = this.connectionService.readPeer(peerId);
        if (!peer?.channel) {
            const reason = `No RTC channel for peer ${peerId}`;
            if (phase === 'dequeue') {
                throw new Error(reason);
            }

            console.warn(
                `Skipping immediate send without RTC channel for peer ${peerId}`,
            );
            return;
        }

        await peer.channel.send(msg);
    }

    private async sendImmediately(messages: readonly ALMessage[]): Promise<void> {
        for (const message of messages) {
            await this.sendPreparedMessage(message, 'immediate');
        }
    }

    private async enqueueMany(
        messages: readonly ALMessage[],
    ): Promise<readonly ResourceEntry[]> {
        const entries: ResourceEntry[] = [];

        for (const message of messages) {
            entries.push(
                await this.outbox.enqueueIfAbsent(
                    QueueBoxUtilities.toResourceEntryFromMsg(
                        message,
                        WebRtcOverlayMulticastManager.ENQUEUE_TYPE,
                    ),
                ),
            );
        }

        return entries;
    }

    private toAckTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        expectedPeerIds: readonly string[],
        mode?: 'merge' | 'replace',
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
            mode,
        };
    }

    private toRepairTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
    ): ALOutboundRepairTrackingPlan | undefined {
        if (effective.repair.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.repair.algo,
            maxAttempts: effective.repair.opts.maxRepairs,
        };
    }

    private toSupersedenceTrackingPlan(
        effective: ReturnType<typeof normalizeALQosPolicy>['effective'],
        msg: ALMessage,
    ): ALOutboundSupersedenceTrackingPlan | undefined {
        if (effective.supersedence.algo === 'none') {
            return undefined;
        }

        return {
            enabled: true,
            algo: effective.supersedence.algo,
            key: resolveSupersedenceKey(msg, effective),
            replacesMsgId: effective.supersedence.opts.replacesMsgId,
        };
    }

    private planRepairMessage(
        msg: ALMessage,
        request: ALOutboundRepairRequest,
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
        if (request.requestedByPeerId) {
            return this.toTargetedRepairDispatchPlan(
                msg,
                request.requestedByPeerId,
                request.repair,
            );
        }

        if (request.failedPeerIds.length > 0) {
            return this.toAlternateParentRepairDispatchPlan(msg, request);
        }

        return undefined;
    }

    private toTargetedRepairDispatchPlan(
        msg: ALMessage,
        peerId: string,
        repair: ALOutboundRepairTrackingPlan,
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
        if (peerId === this.connectionService.input.sessionId) {
            return undefined;
        }

        if (!this.connectionService.readyPeerIdsForLane().includes(peerId)) {
            return undefined;
        }

        const normalized = this.normalizeOutgoingPolicy(msg);
        return {
            persist: false,
            preparedMessages: [
                {
                    ...msg,
                    forwarding: {
                        ...msg.forwarding,
                        nextHopPeerIds: [peerId],
                    },
                },
            ],
            ackTracking: this.toAckTrackingPlan(
                normalized.effective,
                [peerId],
                'replace',
            ),
            repairTracking: repair,
        };
    }

    private toAlternateParentRepairDispatchPlan(
        msg: ALMessage,
        request: ALOutboundRepairRequest,
    ): ALOutboundDispatchPlan<ALMessage> | undefined {
        if (!msg.targets || msg.targets.mode === 'unicast') {
            return undefined;
        }

        const context = this.resolveContext(msg);
        if (!context) {
            return undefined;
        }

        const excludedPeerIds = new Set([
            ...(msg.diagnostics?.visitedPeerIds ?? []),
            ...request.failedPeerIds,
        ]);
        const repairMsg: ALMessage = {
            ...msg,
            diagnostics: {
                ...msg.diagnostics,
                visitedPeerIds: [...excludedPeerIds],
            },
        };

        const multicaster = this.getOrCreateMulticaster(context.overlayId);
        const repairPlan = multicaster.createOriginatingPlan(
            repairMsg,
            context,
            resolveALQosNormalizationInput(
                repairMsg,
                {
                    direction: 'outbound',
                    selfPeerId: this.connectionService.input.sessionId,
                    connectedPeerIds: this.connectionService.readyPeerIdsForLane(),
                    groupMemberPeerIds: readGroupMemberSessionIds(context.room),
                    overlayNeighborPeerIds: context.overlay.nextHopSessionIds,
                },
                this.qosProvider,
            ),
        );
        const dispatchPlan = this.toOutboundDispatchPlan(repairPlan);
        if (dispatchPlan.preparedMessages.length === 0) {
            return undefined;
        }

        return {
            ...dispatchPlan,
            ackTracking: dispatchPlan.ackTracking
                ? {
                    ...dispatchPlan.ackTracking,
                    mode: 'replace',
                }
                : undefined,
            repairTracking: request.repair,
        };
    }
}
