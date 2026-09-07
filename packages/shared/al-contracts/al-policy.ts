import type { ALMessage, ALTargets } from './al-contract.ts';

import type { ALOrderingObservation, ALSupersedenceObservation } from './al-runtime.ts';

import { normalizeALQosPolicy, toDefaultALSemanticKey } from './normalize-al-qos-policy.ts';

export {
    DEFAULT_AL_QOS_CAPABILITIES,
    normalizeALQosPolicy
} from './normalize-al-qos-policy.ts';

export interface ALRequestedAlgorithm<TAlgo extends string, TOpts extends object> {
    readonly algo: TAlgo;
    readonly opts?: Readonly<Partial<TOpts>>;
}

export interface ALEffectiveAlgorithm<TAlgo extends string, TOpts extends object> {
    readonly algo: TAlgo;
    readonly opts: Readonly<TOpts>;
}

export type ALDeliveryAlgo = 'best-effort' | 'at-least-once';

export type ALForwardingAlgo = 'target';

export type ALRepairAlgo = 'none' | 'retransmit';

export type ALAckAlgo = 'none' | 'hop' | 'subtree';

export type ALExpiryAlgo = 'ttl-only' | 'expires-at' | 'fresh-until';

export type ALRetryAlgo = 'none' | 'exp-backoff';

export type ALDedupAlgo = 'msg-id' | 'msg-id+sender' | 'semantic-key';

export type ALSupersedenceAlgo = 'none' | 'latest-wins';

export type ALFanoutAlgo = 'all' | 'limit' | 'random-k';

export type ALCongestionAlgo = 'drop-low' | 'defer' | 'reject';

export type ALDurabilityAlgo = 'volatile' | 'local-outbox' | 'local-inbox';

export type ALOwnershipAlgo = 'shared' | 'exclusive';

export interface ALForwardingOptions {
    readonly overlayId?: string;
}

export interface ALRepairOptions {
    readonly maxRepairs: number;
}

export interface ALAckOptions {
    readonly timeoutMs: number;
}

export interface ALExpiryOptions {
    readonly ttlHops?: number;
    readonly expiresAtMs?: number;
    readonly maxStalenessMs?: number;
}

export interface ALRetryOptions {
    readonly maxAttempts: number;
}

export interface ALDedupOptions {
    readonly windowMs: number;
    readonly semanticKey?: string;
}

export interface ALSupersedenceOptions {
    readonly supersedenceKey?: string;
    readonly replacesMsgId?: string;
}

export interface ALFanoutOptions {
    readonly limit?: number;
}

export interface ALCongestionOptions {
    readonly priority: number;
}

export interface ALQosPolicyRequest {
    readonly delivery?: ALRequestedAlgorithm<ALDeliveryAlgo, Record<string, never>>;
    readonly forwarding?: ALRequestedAlgorithm<ALForwardingAlgo, ALForwardingOptions>;
    readonly repair?: ALRequestedAlgorithm<ALRepairAlgo, ALRepairOptions>;
    readonly ack?: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions>;
    readonly expiry?: ALRequestedAlgorithm<ALExpiryAlgo, ALExpiryOptions>;
    readonly retry?: ALRequestedAlgorithm<ALRetryAlgo, ALRetryOptions>;
    readonly dedup?: ALRequestedAlgorithm<ALDedupAlgo, ALDedupOptions>;
    readonly supersedence?: ALRequestedAlgorithm<ALSupersedenceAlgo, ALSupersedenceOptions>;
    readonly fanout?: ALRequestedAlgorithm<ALFanoutAlgo, ALFanoutOptions>;
    readonly congestion?: ALRequestedAlgorithm<ALCongestionAlgo, ALCongestionOptions>;
    readonly durability?: ALRequestedAlgorithm<ALDurabilityAlgo, Record<string, never>>;
    readonly ownership?: ALRequestedAlgorithm<ALOwnershipAlgo, Record<string, never>>;
}

export interface ALQosEffectivePolicy {
    readonly delivery: ALEffectiveAlgorithm<ALDeliveryAlgo, Record<string, never>>;
    readonly forwarding: ALEffectiveAlgorithm<ALForwardingAlgo, ALForwardingOptions>;
    readonly repair: ALEffectiveAlgorithm<ALRepairAlgo, ALRepairOptions>;
    readonly ack: ALEffectiveAlgorithm<ALAckAlgo, ALAckOptions>;
    readonly expiry: ALEffectiveAlgorithm<ALExpiryAlgo, ALExpiryOptions>;
    readonly retry: ALEffectiveAlgorithm<ALRetryAlgo, ALRetryOptions>;
    readonly dedup: ALEffectiveAlgorithm<ALDedupAlgo, ALDedupOptions>;
    readonly supersedence: ALEffectiveAlgorithm<ALSupersedenceAlgo, ALSupersedenceOptions>;
    readonly fanout: ALEffectiveAlgorithm<ALFanoutAlgo, ALFanoutOptions>;
    readonly congestion: ALEffectiveAlgorithm<ALCongestionAlgo, ALCongestionOptions>;
    readonly durability: ALEffectiveAlgorithm<ALDurabilityAlgo, Record<string, never>>;
    readonly ownership: ALEffectiveAlgorithm<ALOwnershipAlgo, Record<string, never>>;
}

export interface ALQosNormalizationNote {
    readonly aspect: keyof ALQosEffectivePolicy;
    readonly kind: 'defaulted' | 'downgraded' | 'upgraded' | 'clamped';
    readonly reason: string;
    readonly requested?: string;
    readonly effective?: string;
}

export interface ALQosCapabilities {
    readonly supportedDelivery: readonly ALDeliveryAlgo[];
    readonly supportedForwarding: readonly ALForwardingAlgo[];
    readonly supportedRepair: readonly ALRepairAlgo[];
    readonly supportedAck: readonly ALAckAlgo[];
    readonly supportedExpiry: readonly ALExpiryAlgo[];
    readonly supportedRetry: readonly ALRetryAlgo[];
    readonly supportedDedup: readonly ALDedupAlgo[];
    readonly supportedSupersedence: readonly ALSupersedenceAlgo[];
    readonly supportedFanout: readonly ALFanoutAlgo[];
    readonly supportedCongestion: readonly ALCongestionAlgo[];
    readonly supportedDurability: readonly ALDurabilityAlgo[];
    readonly supportedOwnership: readonly ALOwnershipAlgo[];
    readonly maxTtlHops: number;
    readonly maxFanout: number;
    readonly maxRetryAttempts: number;
    readonly maxAckTimeoutMs: number;
    readonly maxDedupWindowMs: number;
}

export interface ALQosAuthorization {
    readonly allowedOwnerships?: readonly ALOwnershipAlgo[];
    readonly allowedRepairs?: readonly ALRepairAlgo[];
    readonly maxDurability?: ALDurabilityAlgo;
}

export interface ALQosNormalizationInput {
    readonly request?: ALQosPolicyRequest;
    readonly defaults?: Partial<ALQosEffectivePolicy>;
    readonly capabilities?: Partial<ALQosCapabilities>;
    readonly authorization?: ALQosAuthorization;
    readonly live?: {
        readonly overloaded?: boolean;
        readonly connectedNeighborCount?: number;
        readonly hasAlternateRoute?: boolean;
    };
}

export type ALQosMessageDirection = 'inbound' | 'outbound';

export interface ALQosMessageContext {
    readonly direction: ALQosMessageDirection;
    readonly selfPeerId?: string;
    readonly fromPeerId?: string;
    readonly connectedPeerIds?: readonly string[];
    readonly groupMemberPeerIds?: readonly string[];
    readonly overlayNeighborPeerIds?: readonly string[];
    readonly overloaded?: boolean;
}

export interface ALQosInputProvider {
    readonly defaultsForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => Partial<ALQosEffectivePolicy> | undefined;
    readonly capabilitiesForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => Partial<ALQosCapabilities> | undefined;
    readonly authorizationForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => ALQosAuthorization | undefined;
    readonly liveForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => ALQosNormalizationInput['live'] | undefined;
}

export interface ALQosNormalizationResult {
    readonly requested: ALQosPolicyRequest;
    readonly effective: ALQosEffectivePolicy;
    readonly notes: readonly ALQosNormalizationNote[];
    readonly unmetRequirements: readonly string[];
}

export interface ALMessagePlanningObservations {
    readonly nowMs: number;
    readonly dedupSeen?: boolean;
    readonly orderingObservation?: ALOrderingObservation;
    readonly supersedenceObservation?: ALSupersedenceObservation;
}

export interface ALMessagePlanningContext extends ALMessagePlanningObservations {
    readonly selfPeerId: string;
    readonly fromPeerId?: string;
    readonly connectedPeerIds?: readonly string[];
    readonly groupMemberPeerIds?: readonly string[];
    readonly overlayNeighborPeerIds?: readonly string[];
    readonly overloaded?: boolean;
}

export type ALCongestionRuntimeAction = 'none' | 'drop-low' | 'defer' | 'reject';

export interface ALMessageHandlingPlan {
    readonly requested: ALQosPolicyRequest;
    readonly effective: ALQosEffectivePolicy;
    readonly notes: readonly ALQosNormalizationNote[];
    readonly unmetRequirements: readonly string[];
    readonly dedupKey: string;
    readonly dropReason?: string;
    readonly localDelivery: {
        readonly enabled: boolean;
        readonly persist: boolean;
        readonly deferred: boolean;
        readonly reason?: string;
    };
    readonly forwarding: {
        readonly enabled: boolean;
        readonly nextHopPeerIds: readonly string[];
        readonly persist: boolean;
    };
    readonly ack: {
        readonly enabled: boolean;
        readonly algo: ALAckAlgo;
        readonly toPeerId?: string;
        readonly deferred: boolean;
    };
    readonly nack: {
        readonly enabled: boolean;
        readonly toPeerId?: string;
        readonly reason?: string;
        readonly missingSeqs: readonly number[];
    };
    readonly repair: {
        readonly enabled: boolean;
        readonly algo: ALRepairAlgo;
        readonly reason?: string;
    };
    readonly supersedence: {
        readonly enabled: boolean;
        readonly algo: ALSupersedenceAlgo;
        readonly key?: string;
        readonly replacesMsgId?: string;
        readonly status: ALSupersedenceObservation['status'];
        readonly latestMsgId?: string;
    };
    readonly congestion: {
        readonly overloaded: boolean;
        readonly action: ALCongestionRuntimeAction;
        readonly priority: number;
    };
    readonly ownership: {
        readonly algo: ALOwnershipAlgo;
        readonly exclusive: boolean;
    };
    readonly orderingRuntime: ALOrderingObservation;
}

interface ALMessageHandlingDecision {
    readonly result: ALQosNormalizationResult;
    readonly dedupKey: string;
    readonly orderingRuntime: ALOrderingObservation;
    readonly supersedenceRuntime: ALSupersedenceObservation;
    readonly congestion: ALMessageHandlingPlan['congestion'];
}

interface ALMessageDeliveryDecision {
    readonly localDelivery: ALMessageHandlingPlan['localDelivery'];
    readonly forwarding: ALMessageHandlingPlan['forwarding'];
}

interface ALMessageDeliveryPolicy {
    readonly decision: ALMessageHandlingDecision;
    readonly dropReason: string | undefined;
}

interface ALMessageRejection {
    readonly orderingRuntime: ALOrderingObservation;
    readonly dropReason: string | undefined;
}

const LOW_PRIORITY_OVERLOAD_THRESHOLD = 0;

export function resolveALQosNormalizationInput(
    msg: ALMessage,
    context: ALQosMessageContext,
    provider?: ALQosInputProvider
): ALQosNormalizationInput {
    return {
        defaults: provider?.defaultsForMessage?.(msg, context),
        capabilities: provider?.capabilitiesForMessage?.(msg, context),
        authorization: provider?.authorizationForMessage?.(msg, context),
        live: provider?.liveForMessage?.(msg, context)
    };
}

export function planALMessageHandling(
    msg: ALMessage,
    context: ALMessagePlanningContext,
    input: ALQosNormalizationInput = {}
): ALMessageHandlingPlan {
    const decision = computeMessageHandlingDecision(msg, context, input);
    const { result, dedupKey, orderingRuntime, supersedenceRuntime, congestion } = decision;
    const dropReason = resolveMessageDropReason(msg, context, decision);
    const delivery = computeMessageDelivery(msg, context, { decision, dropReason });
    return {
        requested: result.requested,
        effective: result.effective,
        notes: result.notes,
        unmetRequirements: result.unmetRequirements,
        dedupKey,
        dropReason,
        ...delivery,
        ack: planAck(result.effective, context, delivery),
        nack: planNack(result.effective, context, { orderingRuntime, dropReason }),
        repair: dropReason
            ? { enabled: false, algo: 'none' }
            : planRepair(result.effective, delivery.forwarding.enabled, msg.targets),
        supersedence: {
            enabled: result.effective.supersedence.algo !== 'none',
            algo: result.effective.supersedence.algo,
            key: resolveSupersedenceKey(msg, result.effective),
            replacesMsgId: result.effective.supersedence.opts.replacesMsgId,
            status: supersedenceRuntime.status,
            latestMsgId: supersedenceRuntime.latestMsgId
        },
        congestion,
        ownership: planOwnership(result.effective),
        orderingRuntime
    };
}

export function shouldPersistInbox(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo === 'local-inbox';
}

export function shouldPersistOutbox(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo === 'local-outbox' ||
        effective.retry.algo !== 'none';
}

export function resolveSupersedenceKey(
    msg: ALMessage,
    effective: ALQosEffectivePolicy
): string | undefined {
    if (effective.supersedence.algo === 'none') {
        return undefined;
    }

    return effective.supersedence.opts.supersedenceKey ?? toDefaultALSemanticKey(msg);
}

export function resolveALMessageExpireAtMs(
    msg: ALMessage,
    effective?: ALQosEffectivePolicy
): number | undefined {
    const candidates: number[] = [];
    const ttlHops = msg.constraints?.ttlHops ?? effective?.expiry.opts.ttlHops;
    if (ttlHops !== undefined && ttlHops <= 0) {
        candidates.push(0);
    }

    const expiresAtMs = msg.constraints?.expiresAtMs ?? effective?.expiry.opts.expiresAtMs;
    if (expiresAtMs !== undefined) {
        candidates.push(expiresAtMs);
    }

    if (effective?.expiry.algo === 'fresh-until' && effective.expiry.opts.maxStalenessMs !== undefined) {
        const createdTs = msg.audit?.createdTs ?? msg.id.ts;
        candidates.push(createdTs + effective.expiry.opts.maxStalenessMs);
    }

    return candidates.length === 0
        ? undefined
        : Math.min(...candidates);
}

function computeMessageHandlingDecision(
    msg: ALMessage,
    context: ALMessagePlanningContext,
    input: ALQosNormalizationInput
): ALMessageHandlingDecision {
    const neighborCount = context.overlayNeighborPeerIds?.length ?? 0;
    const overloaded = context.overloaded ?? input.live?.overloaded ?? false;
    const result = normalizeALQosPolicy(msg, {
        ...input,
        live: { overloaded, connectedNeighborCount: neighborCount, hasAlternateRoute: neighborCount > 1 }
    });
    return {
        result,
        dedupKey: toDedupKey(msg, result.effective),
        supersedenceRuntime: context.supersedenceObservation ?? { status: 'untracked' },
        orderingRuntime: context.orderingObservation ?? { status: 'untracked', missingSeqs: [], releasableSeqs: [] },
        congestion: planCongestion(result.effective, overloaded)
    };
}

function resolveMessageDropReason(
    msg: ALMessage,
    context: ALMessagePlanningContext,
    decision: ALMessageHandlingDecision
): string | undefined {
    const { result, dedupKey, supersedenceRuntime, orderingRuntime, congestion } = decision;
    if (result.unmetRequirements.length > 0) {
        return `Unmet requirements: ${result.unmetRequirements.join(', ')}`;
    }
    if (context.dedupSeen) {
        return `Duplicate message for dedup key ${dedupKey}`;
    }
    if (supersedenceRuntime.status === 'superseded') {
        return `Message superseded by ${supersedenceRuntime.latestMsgId ?? 'a newer message'}`;
    }
    if (orderingRuntime.status === 'duplicate' || orderingRuntime.status === 'stale') {
        return `Ordering runtime rejected message as ${orderingRuntime.status}`;
    }
    if (isExpired(msg, result.effective, context.nowMs)) {
        return 'Message expired or is too stale';
    }
    if (orderingRuntime.status === 'resync-required') {
        return 'resync-required';
    }
    if (congestion.action === 'reject') {
        return 'Node overloaded and congestion policy rejects handling';
    }
    if (congestion.action === 'drop-low' && congestion.priority <= LOW_PRIORITY_OVERLOAD_THRESHOLD) {
        return 'Node overloaded and congestion policy drops low-priority message';
    }
    return undefined;
}

function computeMessageDelivery(
    msg: ALMessage,
    context: ALMessagePlanningContext,
    policy: ALMessageDeliveryPolicy
): ALMessageDeliveryDecision {
    const { decision, dropReason } = policy;
    const isRecipient = isLogicalRecipient(msg.targets, context.selfPeerId, new Set(context.groupMemberPeerIds ?? []));
    const deferred = !dropReason && isRecipient && decision.orderingRuntime.status === 'gap';
    const nextHopPeerIds = dropReason ? [] : resolveNextHopPeerIds(msg, decision.result.effective, context);
    return {
        localDelivery: {
            enabled: !dropReason && !deferred && isRecipient,
            persist: !dropReason && shouldPersistInbox(decision.result.effective),
            deferred,
            reason: deferred ? `Waiting for missing seqs ${decision.orderingRuntime.missingSeqs.join(', ')}` : undefined
        },
        forwarding: {
            enabled: nextHopPeerIds.length > 0,
            nextHopPeerIds,
            persist: !dropReason && shouldPersistOutbox(decision.result.effective)
        }
    };
}

function planAck(
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext,
    delivery: ALMessageDeliveryDecision
): ALMessageHandlingPlan['ack'] {
    if (effective.ack.algo === 'none') {
        return {
            enabled: false,
            algo: 'none',
            deferred: false
        };
    }

    if (!context.fromPeerId) {
        return {
            enabled: false,
            algo: effective.ack.algo,
            deferred: effective.ack.algo === 'subtree' && delivery.forwarding.enabled
        };
    }

    return {
        enabled: delivery.localDelivery.enabled || delivery.forwarding.enabled,
        algo: effective.ack.algo,
        toPeerId: context.fromPeerId,
        deferred: effective.ack.algo === 'subtree' && delivery.forwarding.enabled
    };
}

function planNack(
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext,
    rejection: ALMessageRejection
): ALMessageHandlingPlan['nack'] {
    const { orderingRuntime, dropReason } = rejection;
    if (!context.fromPeerId) {
        return {
            enabled: false,
            missingSeqs: []
        };
    }

    if (dropReason === 'resync-required') {
        return { enabled: true, toPeerId: context.fromPeerId, reason: 'resync-required', missingSeqs: [] };
    }

    if (!dropReason && orderingRuntime.status === 'gap' && effective.repair.algo !== 'none') {
        return {
            enabled: true,
            toPeerId: context.fromPeerId,
            reason: 'gap',
            missingSeqs: orderingRuntime.missingSeqs
        };
    }

    if (dropReason?.includes('expired')) {
        return {
            enabled: true,
            toPeerId: context.fromPeerId,
            reason: 'expired',
            missingSeqs: []
        };
    }

    if (dropReason?.includes('overloaded')) {
        return {
            enabled: true,
            toPeerId: context.fromPeerId,
            reason: 'overloaded',
            missingSeqs: []
        };
    }

    return {
        enabled: false,
        missingSeqs: []
    };
}

function planRepair(
    effective: ALQosEffectivePolicy,
    shouldForward: boolean,
    targets: ALTargets | undefined
): ALMessageHandlingPlan['repair'] {
    if (effective.repair.algo === 'none') {
        return {
            enabled: false,
            algo: 'none'
        };
    }

    if (targets?.mode === 'unicast' && !shouldForward) {
        return {
            enabled: true,
            algo: effective.repair.algo,
            reason: 'No immediate next hop resolved for unicast message'
        };
    }

    if (targets && targets.mode !== 'unicast' && !shouldForward) {
        return {
            enabled: true,
            algo: effective.repair.algo,
            reason: 'No downstream forwarding candidates resolved for group message'
        };
    }

    return {
        enabled: false,
        algo: effective.repair.algo
    };
}

function planCongestion(
    effective: ALQosEffectivePolicy,
    overloaded: boolean
): ALMessageHandlingPlan['congestion'] {
    if (!overloaded) {
        return {
            overloaded: false,
            action: 'none',
            priority: effective.congestion.opts.priority
        };
    }

    switch (effective.congestion.algo) {
        case 'reject':
            return {
                overloaded: true,
                action: 'reject',
                priority: effective.congestion.opts.priority
            };
        case 'defer':
            return {
                overloaded: true,
                action: 'defer',
                priority: effective.congestion.opts.priority
            };
        default:
            return {
                overloaded: true,
                action: 'drop-low',
                priority: effective.congestion.opts.priority
            };
    }
}

function planOwnership(
    effective: ALQosEffectivePolicy
): ALMessageHandlingPlan['ownership'] {
    return {
        algo: effective.ownership.algo,
        exclusive: effective.ownership.algo === 'exclusive'
    };
}

function resolveNextHopPeerIds(
    msg: ALMessage,
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext
): readonly string[] {
    const connectedPeerIds = new Set(context.connectedPeerIds ?? []);
    const groupMemberPeerIds = new Set(context.groupMemberPeerIds ?? []);
    if (!msg.targets) {
        return [];
    }

    if (msg.targets.mode === 'unicast') {
        const immediatePeerId = msg.forwarding?.nextHopPeerIds?.[0] ?? msg.targets.toPeerId;
        if (
            immediatePeerId === context.selfPeerId ||
            immediatePeerId === context.fromPeerId ||
            (connectedPeerIds.size > 0 && !connectedPeerIds.has(immediatePeerId))
        ) {
            return [];
        }

        return [immediatePeerId];
    }

    const visitedPeerIds = new Set(msg.diagnostics?.visitedPeerIds ?? []);
    const exceptPeerIds = msg.targets.mode === 'broadcast'
        ? new Set(msg.targets.exceptPeerIds ?? [])
        : new Set<string>();
    const hintedNextHops = new Set(msg.forwarding?.nextHopPeerIds ?? []);

    const candidates = (context.overlayNeighborPeerIds ?? []).filter((peerId) => {
        if (peerId === context.selfPeerId || peerId === context.fromPeerId) {
            return false;
        }
        if (visitedPeerIds.has(peerId) || exceptPeerIds.has(peerId)) {
            return false;
        }
        if (connectedPeerIds.size > 0 && !connectedPeerIds.has(peerId)) {
            return false;
        }
        if (groupMemberPeerIds.size > 0 && !groupMemberPeerIds.has(peerId)) {
            return false;
        }
        if (hintedNextHops.size > 0 && !hintedNextHops.has(peerId)) {
            return false;
        }
        return true;
    });

    return applyFanoutSelection(candidates, effective, msg.id.msgId);
}

function applyFanoutSelection(
    candidates: readonly string[],
    effective: ALQosEffectivePolicy,
    msgId: string
): readonly string[] {
    switch (effective.fanout.algo) {
        case 'all':
            return candidates;
        case 'limit': {
            const limit = effective.fanout.opts.limit ?? candidates.length;
            return candidates.slice(0, limit);
        }
        case 'random-k': {
            const limit = effective.fanout.opts.limit ?? candidates.length;
            return [...candidates]
                .sort((left, right) => stableRank(`${msgId}:${left}`) - stableRank(`${msgId}:${right}`))
                .slice(0, limit);
        }
    }
}

function isLogicalRecipient(
    targets: ALTargets | undefined,
    selfPeerId: string,
    groupMemberPeerIds: ReadonlySet<string>
): boolean {
    if (!targets) {
        return true;
    }

    switch (targets.mode) {
        case 'unicast':
            return targets.toPeerId === selfPeerId;
        case 'multicast':
            return groupMemberPeerIds.size === 0 || groupMemberPeerIds.has(selfPeerId);
        case 'broadcast':
            return !targets.exceptPeerIds?.includes(selfPeerId);
    }
}

function isExpired(
    msg: ALMessage,
    effective: ALQosEffectivePolicy,
    nowMs: number
): boolean {
    const ttlHops = msg.constraints?.ttlHops ?? effective.expiry.opts.ttlHops;
    if (ttlHops !== undefined && ttlHops <= 0) {
        return true;
    }

    const expiresAtMs = resolveALMessageExpireAtMs(msg, effective);
    if (expiresAtMs !== undefined && nowMs > expiresAtMs) {
        return true;
    }

    return false;
}

function toDedupKey(
    msg: ALMessage,
    effective: ALQosEffectivePolicy
): string {
    switch (effective.dedup.algo) {
        case 'msg-id':
            return msg.id.msgId;
        case 'msg-id+sender':
            return `${msg.id.senderId}:${msg.id.msgId}`;
        case 'semantic-key':
            return effective.dedup.opts.semanticKey ?? toDefaultALSemanticKey(msg);
    }
}

function stableRank(input: string): number {
    let value = 0;

    for (let i = 0; i < input.length; i += 1) {
        value = (value * 31 + input.charCodeAt(i)) >>> 0;
    }

    return value;
}
