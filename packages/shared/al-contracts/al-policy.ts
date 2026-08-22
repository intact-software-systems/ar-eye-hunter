import {
    toALGroupTargetKey,
    type ALConstraints,
    type ALDelivery,
    type ALForwarding,
    type ALMessage,
    type ALTargets
} from './al-contract.ts';
import type {
    ALDedupStoreLike,
    ALOrderingObservation,
    ALOrderingStoreLike,
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedenceStoreLike
} from './al-runtime.ts';

export type ALRequestedAlgorithm<TAlgo extends string, TOpts extends Record<string, unknown>> = Readonly<{
    algo: TAlgo;
    opts?: Readonly<Partial<TOpts>>;
}>;

export type ALEffectiveAlgorithm<TAlgo extends string, TOpts extends Record<string, unknown>> = Readonly<{
    algo: TAlgo;
    opts: Readonly<TOpts>;
}>;

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

export type ALForwardingOptions = Readonly<{
    overlayId?: string;
}>;

export type ALRepairOptions = Readonly<{
    maxRepairs: number;
}>;

export type ALAckOptions = Readonly<{
    timeoutMs: number;
}>;

export type ALExpiryOptions = Readonly<{
    ttlHops?: number;
    expiresAtMs?: number;
    maxStalenessMs?: number;
}>;

export type ALRetryOptions = Readonly<{
    maxAttempts: number;
}>;

export type ALDedupOptions = Readonly<{
    windowMs: number;
    semanticKey?: string;
}>;

export type ALSupersedenceOptions = Readonly<{
    supersedenceKey?: string;
    replacesMsgId?: string;
}>;

export type ALFanoutOptions = Readonly<{
    limit?: number;
}>;

export type ALCongestionOptions = Readonly<{
    priority: number;
}>;

export type ALQosPolicyRequest = Readonly<{
    delivery?: ALRequestedAlgorithm<ALDeliveryAlgo, Record<string, never>>;
    forwarding?: ALRequestedAlgorithm<ALForwardingAlgo, ALForwardingOptions>;
    repair?: ALRequestedAlgorithm<ALRepairAlgo, ALRepairOptions>;
    ack?: ALRequestedAlgorithm<ALAckAlgo, ALAckOptions>;
    expiry?: ALRequestedAlgorithm<ALExpiryAlgo, ALExpiryOptions>;
    retry?: ALRequestedAlgorithm<ALRetryAlgo, ALRetryOptions>;
    dedup?: ALRequestedAlgorithm<ALDedupAlgo, ALDedupOptions>;
    supersedence?: ALRequestedAlgorithm<ALSupersedenceAlgo, ALSupersedenceOptions>;
    fanout?: ALRequestedAlgorithm<ALFanoutAlgo, ALFanoutOptions>;
    congestion?: ALRequestedAlgorithm<ALCongestionAlgo, ALCongestionOptions>;
    durability?: ALRequestedAlgorithm<ALDurabilityAlgo, Record<string, never>>;
    ownership?: ALRequestedAlgorithm<ALOwnershipAlgo, Record<string, never>>;
}>;

export type ALQosEffectivePolicy = Readonly<{
    delivery: ALEffectiveAlgorithm<ALDeliveryAlgo, Record<string, never>>;
    forwarding: ALEffectiveAlgorithm<ALForwardingAlgo, ALForwardingOptions>;
    repair: ALEffectiveAlgorithm<ALRepairAlgo, ALRepairOptions>;
    ack: ALEffectiveAlgorithm<ALAckAlgo, ALAckOptions>;
    expiry: ALEffectiveAlgorithm<ALExpiryAlgo, ALExpiryOptions>;
    retry: ALEffectiveAlgorithm<ALRetryAlgo, ALRetryOptions>;
    dedup: ALEffectiveAlgorithm<ALDedupAlgo, ALDedupOptions>;
    supersedence: ALEffectiveAlgorithm<ALSupersedenceAlgo, ALSupersedenceOptions>;
    fanout: ALEffectiveAlgorithm<ALFanoutAlgo, ALFanoutOptions>;
    congestion: ALEffectiveAlgorithm<ALCongestionAlgo, ALCongestionOptions>;
    durability: ALEffectiveAlgorithm<ALDurabilityAlgo, Record<string, never>>;
    ownership: ALEffectiveAlgorithm<ALOwnershipAlgo, Record<string, never>>;
}>;

export type ALQosNormalizationNote = Readonly<{
    aspect: keyof ALQosEffectivePolicy;
    kind: 'defaulted' | 'downgraded' | 'upgraded' | 'clamped';
    reason: string;
    requested?: string;
    effective?: string;
}>;

export type ALQosCapabilities = Readonly<{
    supportedDelivery: readonly ALDeliveryAlgo[];
    supportedForwarding: readonly ALForwardingAlgo[];
    supportedRepair: readonly ALRepairAlgo[];
    supportedAck: readonly ALAckAlgo[];
    supportedExpiry: readonly ALExpiryAlgo[];
    supportedRetry: readonly ALRetryAlgo[];
    supportedDedup: readonly ALDedupAlgo[];
    supportedSupersedence: readonly ALSupersedenceAlgo[];
    supportedFanout: readonly ALFanoutAlgo[];
    supportedCongestion: readonly ALCongestionAlgo[];
    supportedDurability: readonly ALDurabilityAlgo[];
    supportedOwnership: readonly ALOwnershipAlgo[];
    maxTtlHops: number;
    maxFanout: number;
    maxRetryAttempts: number;
    maxAckTimeoutMs: number;
    maxDedupWindowMs: number;
}>;

export type ALQosAuthorization = Readonly<{
    allowedOwnerships?: readonly ALOwnershipAlgo[];
    allowedRepairs?: readonly ALRepairAlgo[];
    maxDurability?: ALDurabilityAlgo;
}>;

export type ALQosNormalizationInput = Readonly<{
    request?: ALQosPolicyRequest;
    defaults?: Partial<ALQosEffectivePolicy>;
    capabilities?: Partial<ALQosCapabilities>;
    authorization?: ALQosAuthorization;
    live?: Readonly<{
        overloaded?: boolean;
        connectedNeighborCount?: number;
        hasAlternateRoute?: boolean;
    }>;
    nowMs?: number;
}>;

export type ALQosMessageDirection = 'inbound' | 'outbound';

export type ALQosMessageContext = Readonly<{
    direction: ALQosMessageDirection;
    selfPeerId?: string;
    fromPeerId?: string;
    connectedPeerIds?: readonly string[];
    groupMemberPeerIds?: readonly string[];
    overlayNeighborPeerIds?: readonly string[];
    overloaded?: boolean;
}>;

export type ALQosInputProvider = Readonly<{
    defaultsForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => Partial<ALQosEffectivePolicy> | undefined;
    capabilitiesForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => Partial<ALQosCapabilities> | undefined;
    authorizationForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => ALQosAuthorization | undefined;
    liveForMessage?: (
        msg: ALMessage,
        context: ALQosMessageContext
    ) => ALQosNormalizationInput['live'] | undefined;
}>;

export type ALQosNormalizationResult = Readonly<{
    requested: ALQosPolicyRequest;
    effective: ALQosEffectivePolicy;
    notes: readonly ALQosNormalizationNote[];
    unmetRequirements: readonly string[];
}>;

export type ALMessagePlanningContext = Readonly<{
    selfPeerId: string;
    fromPeerId?: string;
    nowMs?: number;
    connectedPeerIds?: readonly string[];
    groupMemberPeerIds?: readonly string[];
    overlayNeighborPeerIds?: readonly string[];
    seenDedupKeys?: ReadonlySet<string>;
    dedupStore?: ALDedupStoreLike;
    orderingStore?: ALOrderingStoreLike;
    supersedenceStore?: ALSupersedenceStoreLike;
    overloaded?: boolean;
}>;

export type ALCongestionRuntimeAction = 'none' | 'drop-low' | 'defer' | 'reject';

export type ALMessageHandlingPlan = Readonly<{
    requested: ALQosPolicyRequest;
    effective: ALQosEffectivePolicy;
    notes: readonly ALQosNormalizationNote[];
    unmetRequirements: readonly string[];
    dedupKey: string;
    dropReason?: string;
    localDelivery: Readonly<{
        enabled: boolean;
        persist: boolean;
        deferred: boolean;
        reason?: string;
    }>;
    forwarding: Readonly<{
        enabled: boolean;
        nextHopPeerIds: readonly string[];
        persist: boolean;
    }>;
    ack: Readonly<{
        enabled: boolean;
        algo: ALAckAlgo;
        toPeerId?: string;
        deferred: boolean;
    }>;
    nack: Readonly<{
        enabled: boolean;
        toPeerId?: string;
        reason?: string;
        missingSeqs: readonly number[];
    }>;
    repair: Readonly<{
        enabled: boolean;
        algo: ALRepairAlgo;
        reason?: string;
    }>;
    supersedence: Readonly<{
        enabled: boolean;
        algo: ALSupersedenceAlgo;
        key?: string;
        replacesMsgId?: string;
        status: ALSupersedenceObservation['status'];
        latestMsgId?: string;
    }>;
    congestion: Readonly<{
        overloaded: boolean;
        action: ALCongestionRuntimeAction;
        priority: number;
    }>;
    ownership: Readonly<{
        algo: ALOwnershipAlgo;
        exclusive: boolean;
    }>;
    orderingRuntime: ALOrderingObservation;
}>;

export const DEFAULT_AL_QOS_CAPABILITIES: ALQosCapabilities = {
    supportedDelivery: ['best-effort', 'at-least-once'],
    supportedForwarding: ['target'],
    supportedRepair: ['none', 'retransmit'],
    supportedAck: ['none', 'hop', 'subtree'],
    supportedExpiry: ['ttl-only', 'expires-at', 'fresh-until'],
    supportedRetry: ['none', 'exp-backoff'],
    supportedDedup: ['msg-id', 'msg-id+sender', 'semantic-key'],
    supportedSupersedence: ['none', 'latest-wins'],
    supportedFanout: ['all', 'limit', 'random-k'],
    supportedCongestion: ['drop-low', 'defer', 'reject'],
    supportedDurability: ['volatile', 'local-outbox', 'local-inbox'],
    supportedOwnership: ['shared', 'exclusive'],
    maxTtlHops: 32,
    maxFanout: 16,
    maxRetryAttempts: 8,
    maxAckTimeoutMs: 30_000,
    maxDedupWindowMs: 5 * 60_000
};

const DURABILITY_ORDER: readonly ALDurabilityAlgo[] = [
    'volatile',
    'local-outbox',
    'local-inbox'
];

const LOW_PRIORITY_OVERLOAD_THRESHOLD = 0;

export function deriveALQosPolicyRequest(msg: ALMessage): ALQosPolicyRequest {
    return {
        delivery: msg.delivery
            ? { algo: deriveDeliveryAlgo(msg.delivery) }
            : undefined,
        forwarding: deriveForwardingRequest(msg.targets, msg.forwarding),
        repair: msg.delivery?.reliability === 'at-least-once'
            ? {
                algo: msg.targets?.mode === 'unicast' ? 'none' : 'retransmit',
                opts: { maxRepairs: 1 }
            }
            : undefined,
        ack: deriveAckRequest(msg.delivery),
        expiry: deriveExpiryRequest(msg.constraints, msg),
        retry: msg.delivery?.reliability === 'at-least-once'
            ? {
                algo: 'exp-backoff',
                opts: {
                    maxAttempts: 3
                }
            }
            : undefined,
        dedup: {
            algo: 'msg-id',
            opts: {
                windowMs: 60_000,
                semanticKey: toDefaultSemanticKey(msg)
            }
        },
        fanout: msg.forwarding?.fanoutLimit !== undefined
            ? {
                algo: 'limit',
                opts: { limit: msg.forwarding.fanoutLimit }
            }
            : undefined,
        durability: msg.delivery?.reliability === 'at-least-once'
            ? { algo: 'local-outbox' }
            : undefined,
        ownership: msg.delivery?.ownership
            ? { algo: msg.delivery.ownership }
            : undefined
    };
}

export function normalizeALQosPolicy(
    msg: ALMessage,
    input: ALQosNormalizationInput = {}
): ALQosNormalizationResult {
    const notes: ALQosNormalizationNote[] = [];
    const unmetRequirements: string[] = [];

    const capabilities: ALQosCapabilities = {
        ...DEFAULT_AL_QOS_CAPABILITIES,
        ...(input.capabilities ?? {})
    };

    const live = {
        overloaded: input.live?.overloaded ?? false,
        connectedNeighborCount: input.live?.connectedNeighborCount,
        hasAlternateRoute: input.live?.hasAlternateRoute ?? false
    };

    const requested = mergePolicyRequests(
        deriveALQosPolicyRequest(msg),
        msg.qos,
        input.request
    );

    const defaultPolicy = mergeEffectivePolicy(
        toDefaultEffectivePolicy(msg),
        input.defaults
    );

    let effective: ALQosEffectivePolicy = {
        delivery: normalizeAspect(
            'delivery',
            requested.delivery,
            defaultPolicy.delivery,
            capabilities.supportedDelivery,
            notes
        ),
        forwarding: normalizeAspect(
            'forwarding',
            requested.forwarding,
            defaultPolicy.forwarding,
            capabilities.supportedForwarding,
            notes
        ),
        repair: normalizeAspect('repair', requested.repair, defaultPolicy.repair, capabilities.supportedRepair, notes),
        ack: normalizeAspect('ack', requested.ack, defaultPolicy.ack, capabilities.supportedAck, notes),
        expiry: normalizeAspect('expiry', requested.expiry, defaultPolicy.expiry, capabilities.supportedExpiry, notes),
        retry: normalizeAspect('retry', requested.retry, defaultPolicy.retry, capabilities.supportedRetry, notes),
        dedup: normalizeAspect('dedup', requested.dedup, defaultPolicy.dedup, capabilities.supportedDedup, notes),
        supersedence: normalizeAspect(
            'supersedence',
            requested.supersedence,
            defaultPolicy.supersedence,
            capabilities.supportedSupersedence,
            notes
        ),
        fanout: normalizeAspect('fanout', requested.fanout, defaultPolicy.fanout, capabilities.supportedFanout, notes),
        congestion: normalizeAspect(
            'congestion',
            requested.congestion,
            defaultPolicy.congestion,
            capabilities.supportedCongestion,
            notes
        ),
        durability: normalizeAspect(
            'durability',
            requested.durability,
            defaultPolicy.durability,
            capabilities.supportedDurability,
            notes
        ),
        ownership: normalizeAspect(
            'ownership',
            requested.ownership,
            defaultPolicy.ownership,
            capabilities.supportedOwnership,
            notes
        )
    };

    effective = alignDurabilityWithRequestedStrength(effective, requested, capabilities, notes);
    effective = clampEffectivePolicy(effective, capabilities, notes);
    effective = applyAuthorization(effective, capabilities, input.authorization, notes, unmetRequirements);
    effective = applyLiveState(effective, live, capabilities, notes);
    effective = enforceCrossAspectConsistency(effective, notes);

    return {
        requested,
        effective,
        notes,
        unmetRequirements
    };
}

export function resolveALQosNormalizationInput(
    msg: ALMessage,
    context: ALQosMessageContext,
    provider?: ALQosInputProvider
): Omit<ALQosNormalizationInput, 'nowMs'> {
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
    input: Omit<ALQosNormalizationInput, 'nowMs'> = {}
): ALMessageHandlingPlan {
    const nowMs = context.nowMs ?? Date.now();
    const connectedPeerIds = new Set(context.connectedPeerIds ?? []);
    const groupMemberPeerIds = new Set(context.groupMemberPeerIds ?? []);
    const overlayNeighborPeerIds = context.overlayNeighborPeerIds ?? [];
    const overloaded = context.overloaded ?? input.live?.overloaded ?? false;
    const result = normalizeALQosPolicy(
        msg,
        {
            ...input,
            nowMs,
            live: {
                overloaded,
                connectedNeighborCount: overlayNeighborPeerIds.length,
                hasAlternateRoute: overlayNeighborPeerIds.length > 1
            }
        }
    );

    const dedupKey = toDedupKey(msg, result.effective);
    const supersedenceRuntime = context.supersedenceStore?.peek(
        toSupersedenceInput(msg, result.effective),
        nowMs
    ) ?? {
        status: 'untracked'
    };
    const orderingRuntime = context.orderingStore?.peek(msg, nowMs) ?? {
        status: 'untracked',
        missingSeqs: [],
        releasableSeqs: []
    };
    const congestion = planCongestion(result.effective, overloaded);
    const ownership = planOwnership(result.effective);

    let dropReason: string | undefined;

    if (result.unmetRequirements.length > 0) {
        dropReason = `Unmet requirements: ${result.unmetRequirements.join(', ')}`;
    }
    else if (context.seenDedupKeys?.has(dedupKey)) {
        dropReason = `Duplicate message for dedup key ${dedupKey}`;
    }
    else if (context.dedupStore?.has(dedupKey, nowMs)) {
        dropReason = `Duplicate message for dedup key ${dedupKey}`;
    }
    else if (supersedenceRuntime.status === 'superseded') {
        dropReason = `Message superseded by ${supersedenceRuntime.latestMsgId ?? 'a newer message'}`;
    }
    else if (orderingRuntime.status === 'duplicate' || orderingRuntime.status === 'stale') {
        dropReason = `Ordering runtime rejected message as ${orderingRuntime.status}`;
    }
    else if (isExpired(msg, result.effective, nowMs)) {
        dropReason = 'Message expired or is too stale';
    }
    else if (congestion.action === 'reject') {
        dropReason = 'Node overloaded and congestion policy rejects handling';
    }
    else if (congestion.action === 'drop-low' && congestion.priority <= LOW_PRIORITY_OVERLOAD_THRESHOLD) {
        dropReason = 'Node overloaded and congestion policy drops low-priority message';
    }

    const isRecipient = isLogicalRecipient(msg.targets, context.selfPeerId, groupMemberPeerIds);
    const localDeliveryDeferred = !dropReason && isRecipient && orderingRuntime.status === 'gap';
    const localDeliveryReason = localDeliveryDeferred
        ? `Waiting for missing seqs ${orderingRuntime.missingSeqs.join(', ')}`
        : undefined;
    const shouldDeliverLocally = !dropReason &&
        !localDeliveryDeferred &&
        isRecipient;
    const nextHopPeerIds = dropReason
        ? []
        : resolveNextHopPeerIds(msg, result.effective, context, connectedPeerIds, groupMemberPeerIds);
    const shouldForward = nextHopPeerIds.length > 0;

    const ack = planAck(msg, result.effective, context, shouldDeliverLocally, shouldForward);
    const nack = planNack(result.effective, context, orderingRuntime, dropReason);
    const repair = planRepair(result.effective, shouldForward, msg.targets);

    return {
        requested: result.requested,
        effective: result.effective,
        notes: result.notes,
        unmetRequirements: result.unmetRequirements,
        dedupKey,
        dropReason,
        localDelivery: {
            enabled: shouldDeliverLocally,
            persist: shouldPersistInbox(result.effective),
            deferred: localDeliveryDeferred,
            reason: localDeliveryReason
        },
        forwarding: {
            enabled: shouldForward,
            nextHopPeerIds,
            persist: shouldPersistOutbox(result.effective)
        },
        ack,
        nack,
        repair,
        supersedence: {
            enabled: result.effective.supersedence.algo !== 'none',
            algo: result.effective.supersedence.algo,
            key: resolveSupersedenceKey(msg, result.effective),
            replacesMsgId: result.effective.supersedence.opts.replacesMsgId,
            status: supersedenceRuntime.status,
            latestMsgId: supersedenceRuntime.latestMsgId
        },
        congestion,
        ownership,
        orderingRuntime
    };
}

function deriveDeliveryAlgo(delivery: ALDelivery): ALDeliveryAlgo {
    if (delivery.reliability === 'at-least-once') {
        return 'at-least-once';
    }

    return 'best-effort';
}

function deriveForwardingRequest(
    targets: ALTargets | undefined,
    forwarding: ALForwarding | undefined
): ALQosPolicyRequest['forwarding'] {
    if (!targets) {
        return undefined;
    }

    return {
        algo: 'target',
        opts: {
            overlayId: forwarding?.overlayId ??
                (targets.mode === 'multicast' ? targets.groupRef.groupId : undefined)
        }
    };
}

function deriveAckRequest(delivery: ALDelivery | undefined): ALQosPolicyRequest['ack'] {
    if (!delivery) {
        return undefined;
    }

    return {
        algo: toAckAlgo(delivery.ack),
        opts: {
            timeoutMs: delivery.reliability === 'at-least-once' ? 2_000 : 250
        }
    };
}

function deriveExpiryRequest(
    constraints: ALConstraints | undefined,
    msg: ALMessage
): ALQosPolicyRequest['expiry'] {
    if (!constraints) {
        return undefined;
    }

    if (constraints.expiresAtMs !== undefined) {
        return {
            algo: 'expires-at',
            opts: {
                ttlHops: constraints.ttlHops,
                expiresAtMs: constraints.expiresAtMs,
                maxStalenessMs: toDefaultMaxStalenessMs(msg)
            }
        };
    }

    if (constraints.ttlHops !== undefined) {
        return {
            algo: 'ttl-only',
            opts: {
                ttlHops: constraints.ttlHops,
                maxStalenessMs: toDefaultMaxStalenessMs(msg)
            }
        };
    }

    return undefined;
}

function toDefaultEffectivePolicy(msg: ALMessage): ALQosEffectivePolicy {
    const deliveryAlgo = deriveDeliveryAlgo(
        msg.delivery ?? {
            reliability: 'best-effort',
            ack: 'none'
        }
    );

    return {
        delivery: { algo: deliveryAlgo, opts: {} },
        forwarding: {
            algo: 'target',
            opts: {
                overlayId: msg.forwarding?.overlayId ??
                    (msg.targets?.mode === 'multicast'
                        ? msg.targets.groupRef.groupId
                        : msg.route.contextId)
            }
        },
        repair: {
            algo: deliveryAlgo === 'at-least-once'
                ? (msg.targets?.mode === 'unicast' ? 'none' : 'retransmit')
                : 'none',
            opts: {
                maxRepairs: 1
            }
        },
        ack: {
            algo: deliveryAlgo === 'at-least-once' ? 'hop' : 'none',
            opts: {
                timeoutMs: deliveryAlgo === 'at-least-once' ? 2_000 : 250
            }
        },
        expiry: {
            algo: msg.constraints?.expiresAtMs !== undefined ? 'expires-at' : 'ttl-only',
            opts: {
                ttlHops: msg.constraints?.ttlHops,
                expiresAtMs: msg.constraints?.expiresAtMs,
                maxStalenessMs: toDefaultMaxStalenessMs(msg)
            }
        },
        retry: {
            algo: deliveryAlgo === 'at-least-once' ? 'exp-backoff' : 'none',
            opts: {
                maxAttempts: 3
            }
        },
        dedup: {
            algo: 'msg-id',
            opts: {
                windowMs: 60_000,
                semanticKey: toDefaultSemanticKey(msg)
            }
        },
        supersedence: {
            algo: 'none',
            opts: {
                supersedenceKey: undefined,
                replacesMsgId: undefined
            }
        },
        fanout: {
            algo: msg.forwarding?.fanoutLimit !== undefined ? 'limit' : 'all',
            opts: {
                limit: msg.forwarding?.fanoutLimit
            }
        },
        congestion: {
            algo: 'drop-low',
            opts: {
                priority: deliveryAlgo === 'at-least-once' ? 5 : 0
            }
        },
        durability: {
            algo: deliveryAlgo === 'at-least-once' ? 'local-outbox' : 'volatile',
            opts: {}
        },
        ownership: {
            algo: msg.delivery?.ownership ?? 'shared',
            opts: {}
        }
    };
}

function mergePolicyRequests(...requests: Array<ALQosPolicyRequest | undefined>): ALQosPolicyRequest {
    let current: ALQosPolicyRequest = {};

    for (const request of requests) {
        if (!request) {
            continue;
        }

        current = {
            delivery: mergeRequestedAlgorithm(current.delivery, request.delivery),
            forwarding: mergeRequestedAlgorithm(current.forwarding, request.forwarding),
            repair: mergeRequestedAlgorithm(current.repair, request.repair),
            ack: mergeRequestedAlgorithm(current.ack, request.ack),
            expiry: mergeRequestedAlgorithm(current.expiry, request.expiry),
            retry: mergeRequestedAlgorithm(current.retry, request.retry),
            dedup: mergeRequestedAlgorithm(current.dedup, request.dedup),
            supersedence: mergeRequestedAlgorithm(current.supersedence, request.supersedence),
            fanout: mergeRequestedAlgorithm(current.fanout, request.fanout),
            congestion: mergeRequestedAlgorithm(current.congestion, request.congestion),
            durability: mergeRequestedAlgorithm(current.durability, request.durability),
            ownership: mergeRequestedAlgorithm(current.ownership, request.ownership)
        };
    }

    return current;
}

function mergeRequestedAlgorithm<TAlgo extends string, TOpts extends Record<string, unknown>>(
    base: ALRequestedAlgorithm<TAlgo, TOpts> | undefined,
    override: ALRequestedAlgorithm<TAlgo, TOpts> | undefined
): ALRequestedAlgorithm<TAlgo, TOpts> | undefined {
    if (!base) {
        return override;
    }

    if (!override) {
        return base;
    }

    return {
        algo: override.algo,
        opts: ({
            ...(base.opts ?? {}),
            ...(override.opts ?? {})
        }) as Readonly<Partial<TOpts>>
    };
}

function mergeEffectivePolicy(
    base: ALQosEffectivePolicy,
    overrides: Partial<ALQosEffectivePolicy> | undefined
): ALQosEffectivePolicy {
    if (!overrides) {
        return base;
    }

    return {
        delivery: mergeEffectiveAlgorithm(base.delivery, overrides.delivery),
        forwarding: mergeEffectiveAlgorithm(base.forwarding, overrides.forwarding),
        repair: mergeEffectiveAlgorithm(base.repair, overrides.repair),
        ack: mergeEffectiveAlgorithm(base.ack, overrides.ack),
        expiry: mergeEffectiveAlgorithm(base.expiry, overrides.expiry),
        retry: mergeEffectiveAlgorithm(base.retry, overrides.retry),
        dedup: mergeEffectiveAlgorithm(base.dedup, overrides.dedup),
        supersedence: mergeEffectiveAlgorithm(base.supersedence, overrides.supersedence),
        fanout: mergeEffectiveAlgorithm(base.fanout, overrides.fanout),
        congestion: mergeEffectiveAlgorithm(base.congestion, overrides.congestion),
        durability: mergeEffectiveAlgorithm(base.durability, overrides.durability),
        ownership: mergeEffectiveAlgorithm(base.ownership, overrides.ownership)
    };
}

function mergeEffectiveAlgorithm<TAlgo extends string, TOpts extends Record<string, unknown>>(
    base: ALEffectiveAlgorithm<TAlgo, TOpts>,
    override: ALEffectiveAlgorithm<TAlgo, TOpts> | undefined
): ALEffectiveAlgorithm<TAlgo, TOpts> {
    if (!override) {
        return base;
    }

    return {
        algo: override.algo,
        opts: {
            ...base.opts,
            ...override.opts
        }
    };
}

function normalizeAspect<TAlgo extends string, TOpts extends Record<string, unknown>>(
    aspect: keyof ALQosEffectivePolicy,
    requested: ALRequestedAlgorithm<TAlgo, TOpts> | undefined,
    fallback: ALEffectiveAlgorithm<TAlgo, TOpts>,
    supported: readonly TAlgo[],
    notes: ALQosNormalizationNote[]
): ALEffectiveAlgorithm<TAlgo, TOpts> {
    if (!requested) {
        notes.push({
            aspect,
            kind: 'defaulted',
            reason: 'No explicit policy requested for aspect',
            effective: fallback.algo
        });
        return fallback;
    }

    const requestedAlgo = requested.algo;
    const requestedOpts = {
        ...fallback.opts,
        ...(requested.opts ?? {})
    } as TOpts;

    if (supported.includes(requestedAlgo)) {
        return {
            algo: requestedAlgo,
            opts: requestedOpts
        };
    }

    const effectiveAlgo = supported.includes(fallback.algo)
        ? fallback.algo
        : pickFallbackAlgorithm(aspect, supported);

    notes.push({
        aspect,
        kind: 'downgraded',
        reason: 'Requested algorithm is not supported locally',
        requested: requestedAlgo,
        effective: effectiveAlgo
    });

    return {
        algo: effectiveAlgo,
        opts: requestedOpts
    };
}

function pickFallbackAlgorithm<TAlgo extends string>(
    aspect: keyof ALQosEffectivePolicy,
    supported: readonly TAlgo[]
): TAlgo {
    if (supported.length === 0) {
        throw new Error(`No supported algorithms configured for aspect ${aspect}`);
    }

    const preferredByAspect: Partial<Record<keyof ALQosEffectivePolicy, readonly string[]>> = {
        delivery: ['best-effort', 'at-least-once'],
        forwarding: ['target'],
        repair: ['retransmit', 'none'],
        ack: ['hop', 'subtree', 'none'],
        expiry: ['expires-at', 'ttl-only', 'fresh-until'],
        retry: ['exp-backoff', 'none'],
        dedup: ['msg-id', 'msg-id+sender', 'semantic-key'],
        supersedence: ['latest-wins', 'none'],
        fanout: ['limit', 'all', 'random-k'],
        congestion: ['drop-low', 'defer', 'reject'],
        durability: ['local-inbox', 'local-outbox', 'volatile'],
        ownership: ['shared', 'exclusive']
    };

    const preferred = preferredByAspect[aspect] ?? [];
    const preferredSupported = preferred.find((candidate) => supported.includes(candidate as TAlgo));

    return (preferredSupported as TAlgo | undefined) ?? supported[0];
}

function clampEffectivePolicy(
    effective: ALQosEffectivePolicy,
    capabilities: ALQosCapabilities,
    notes: ALQosNormalizationNote[]
): ALQosEffectivePolicy {
    const ttlHops = effective.expiry.opts.ttlHops;
    const clampedTtlHops = ttlHops !== undefined
        ? Math.max(0, Math.min(ttlHops, capabilities.maxTtlHops))
        : ttlHops;

    if (ttlHops !== clampedTtlHops) {
        notes.push({
            aspect: 'expiry',
            kind: 'clamped',
            reason: 'ttlHops clamped to local maximum',
            requested: ttlHops?.toString(),
            effective: clampedTtlHops?.toString()
        });
    }

    const fanoutLimit = effective.fanout.opts.limit;
    const clampedFanout = fanoutLimit !== undefined
        ? Math.max(1, Math.min(fanoutLimit, capabilities.maxFanout))
        : fanoutLimit;

    if (fanoutLimit !== clampedFanout) {
        notes.push({
            aspect: 'fanout',
            kind: 'clamped',
            reason: 'fanout limit clamped to local maximum',
            requested: fanoutLimit?.toString(),
            effective: clampedFanout?.toString()
        });
    }

    const ackTimeoutMs = Math.max(0, Math.min(effective.ack.opts.timeoutMs, capabilities.maxAckTimeoutMs));
    if (ackTimeoutMs !== effective.ack.opts.timeoutMs) {
        notes.push({
            aspect: 'ack',
            kind: 'clamped',
            reason: 'Ack timeout clamped to local maximum',
            requested: effective.ack.opts.timeoutMs.toString(),
            effective: ackTimeoutMs.toString()
        });
    }

    const retryAttempts = Math.max(0, Math.min(effective.retry.opts.maxAttempts, capabilities.maxRetryAttempts));

    if (retryAttempts !== effective.retry.opts.maxAttempts) {
        notes.push({
            aspect: 'retry',
            kind: 'clamped',
            reason: 'Retry attempts clamped to local maximum',
            requested: effective.retry.opts.maxAttempts.toString(),
            effective: retryAttempts.toString()
        });
    }

    const dedupWindowMs = Math.max(0, Math.min(effective.dedup.opts.windowMs, capabilities.maxDedupWindowMs));
    if (dedupWindowMs !== effective.dedup.opts.windowMs) {
        notes.push({
            aspect: 'dedup',
            kind: 'clamped',
            reason: 'Dedup window clamped to local maximum',
            requested: effective.dedup.opts.windowMs.toString(),
            effective: dedupWindowMs.toString()
        });
    }

    return {
        ...effective,
        expiry: {
            ...effective.expiry,
            opts: {
                ...effective.expiry.opts,
                ttlHops: clampedTtlHops
            }
        },
        fanout: {
            ...effective.fanout,
            opts: {
                ...effective.fanout.opts,
                limit: clampedFanout
            }
        },
        ack: {
            ...effective.ack,
            opts: {
                ...effective.ack.opts,
                timeoutMs: ackTimeoutMs
            }
        },
        retry: {
            ...effective.retry,
            opts: {
                ...effective.retry.opts,
                maxAttempts: retryAttempts
            }
        },
        dedup: {
            ...effective.dedup,
            opts: {
                ...effective.dedup.opts,
                windowMs: dedupWindowMs
            }
        }
    };
}

function applyAuthorization(
    effective: ALQosEffectivePolicy,
    capabilities: ALQosCapabilities,
    authorization: ALQosAuthorization | undefined,
    notes: ALQosNormalizationNote[],
    unmetRequirements: string[]
): ALQosEffectivePolicy {
    if (!authorization) {
        return effective;
    }

    let ownership = effective.ownership;
    if (authorization.allowedOwnerships && !authorization.allowedOwnerships.includes(ownership.algo)) {
        const replacement = authorization.allowedOwnerships.find((candidate) =>
            capabilities.supportedOwnership.includes(candidate)
        );
        if (!replacement) {
            unmetRequirements.push(`No authorized ownership available for ${ownership.algo}`);
        }
        else {
            notes.push({
                aspect: 'ownership',
                kind: 'downgraded',
                reason: 'Requested ownership is not authorized',
                requested: ownership.algo,
                effective: replacement
            });
            ownership = {
                algo: replacement,
                opts: {}
            };
        }
    }

    let repair = effective.repair;
    if (authorization.allowedRepairs && !authorization.allowedRepairs.includes(repair.algo)) {
        const replacement = authorization.allowedRepairs.find((candidate) =>
            capabilities.supportedRepair.includes(candidate)
        );
        if (!replacement) {
            unmetRequirements.push(`No authorized repair strategy available for ${repair.algo}`);
        }
        else {
            notes.push({
                aspect: 'repair',
                kind: 'downgraded',
                reason: 'Requested repair strategy is not authorized',
                requested: repair.algo,
                effective: replacement
            });
            repair = {
                algo: replacement,
                opts: repair.opts
            };
        }
    }

    let durability = effective.durability;
    if (
        authorization.maxDurability !== undefined &&
        durabilityRank(durability.algo) > durabilityRank(authorization.maxDurability)
    ) {
        const replacement = pickHighestAvailableDurability(
            capabilities.supportedDurability,
            authorization.maxDurability
        );

        if (!replacement) {
            unmetRequirements.push(`No authorized durability available for ${durability.algo}`);
        }
        else {
            notes.push({
                aspect: 'durability',
                kind: 'downgraded',
                reason: 'Requested durability exceeds authorization',
                requested: durability.algo,
                effective: replacement
            });
            durability = {
                algo: replacement,
                opts: {}
            };
        }
    }

    return {
        ...effective,
        ownership,
        repair,
        durability
    };
}

function alignDurabilityWithRequestedStrength(
    effective: ALQosEffectivePolicy,
    requested: ALQosPolicyRequest,
    capabilities: ALQosCapabilities,
    notes: ALQosNormalizationNote[]
): ALQosEffectivePolicy {
    const requestedDurability = requested.durability?.algo;
    if (!requestedDurability) {
        return effective;
    }

    const replacement = pickHighestAvailableDurability(
        capabilities.supportedDurability,
        requestedDurability
    );

    if (!replacement || durabilityRank(replacement) <= durabilityRank(effective.durability.algo)) {
        return effective;
    }

    notes.push({
        aspect: 'durability',
        kind: 'downgraded',
        reason: 'Durability normalized to the strongest supported level under the requested policy',
        requested: requestedDurability,
        effective: replacement
    });

    return {
        ...effective,
        durability: {
            algo: replacement,
            opts: {}
        }
    };
}

function applyLiveState(
    effective: ALQosEffectivePolicy,
    live: NonNullable<ALQosNormalizationInput['live']>,
    capabilities: ALQosCapabilities,
    notes: ALQosNormalizationNote[]
): ALQosEffectivePolicy {
    let next = effective;

    if (next.fanout.algo !== 'all' && live.connectedNeighborCount !== undefined) {
        const currentLimit = next.fanout.opts.limit ?? live.connectedNeighborCount;
        const clampedLimit = Math.max(1, Math.min(currentLimit, live.connectedNeighborCount || 1));

        if (currentLimit !== clampedLimit) {
            notes.push({
                aspect: 'fanout',
                kind: 'clamped',
                reason: 'Fanout clamped to currently connected neighbors',
                requested: currentLimit.toString(),
                effective: clampedLimit.toString()
            });
        }

        next = {
            ...next,
            fanout: {
                ...next.fanout,
                opts: {
                    ...next.fanout.opts,
                    limit: clampedLimit
                }
            }
        };
    }

    return next;
}

function enforceCrossAspectConsistency(
    effective: ALQosEffectivePolicy,
    notes: ALQosNormalizationNote[]
): ALQosEffectivePolicy {
    let next = effective;

    if (next.delivery.algo === 'best-effort' && next.retry.algo !== 'none') {
        notes.push({
            aspect: 'retry',
            kind: 'downgraded',
            reason: 'Best-effort delivery disables retries',
            requested: next.retry.algo,
            effective: 'none'
        });
        next = {
            ...next,
            retry: {
                ...next.retry,
                algo: 'none'
            }
        };
    }

    return next;
}

export function shouldPersistInbox(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo === 'local-inbox';
}

export function shouldPersistOutbox(effective: ALQosEffectivePolicy): boolean {
    return effective.durability.algo === 'local-outbox' ||
        effective.retry.algo !== 'none';
}

function planAck(
    msg: ALMessage,
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext,
    shouldDeliverLocally: boolean,
    shouldForward: boolean
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
            deferred: effective.ack.algo === 'subtree' && shouldForward
        };
    }

    return {
        enabled: shouldDeliverLocally || shouldForward,
        algo: effective.ack.algo,
        toPeerId: context.fromPeerId,
        deferred: effective.ack.algo === 'subtree' && shouldForward
    };
}

function planNack(
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext,
    orderingRuntime: ALOrderingObservation,
    dropReason?: string
): ALMessageHandlingPlan['nack'] {
    if (!context.fromPeerId) {
        return {
            enabled: false,
            missingSeqs: []
        };
    }

    if (orderingRuntime.status === 'gap' && effective.repair.algo !== 'none') {
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

function toSupersedenceInput(
    msg: ALMessage,
    effective: ALQosEffectivePolicy
): ALSupersedenceInput {
    return {
        key: resolveSupersedenceKey(msg, effective),
        msgId: msg.id.msgId,
        replacesMsgId: effective.supersedence.opts.replacesMsgId,
        seq: msg.ordering?.seq,
        ts: msg.audit?.createdTs ?? msg.id.ts
    };
}

export function resolveSupersedenceKey(
    msg: ALMessage,
    effective: ALQosEffectivePolicy
): string | undefined {
    if (effective.supersedence.algo === 'none') {
        return undefined;
    }

    return effective.supersedence.opts.supersedenceKey ?? toDefaultSemanticKey(msg);
}

function resolveNextHopPeerIds(
    msg: ALMessage,
    effective: ALQosEffectivePolicy,
    context: ALMessagePlanningContext,
    connectedPeerIds: ReadonlySet<string>,
    groupMemberPeerIds: ReadonlySet<string>
): readonly string[] {
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
            return effective.dedup.opts.semanticKey ?? toDefaultSemanticKey(msg);
    }
}

function toDefaultSemanticKey(msg: ALMessage): string {
    return `${msg.id.senderId}:${msg.route.topicId}/${msg.route.contextId}/${msg.route.resourceId}`;
}

function toAckAlgo(ack: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'): ALAckAlgo {
    switch (ack) {
        case 'none':
            return 'none';
        case 'receiver':
            return 'hop';
        case 'all-logical-recipients':
        case 'group-leader':
            return 'subtree';
    }
}

function inferOrderingKeyFromTargets(
    targets: ALTargets | undefined,
    msg: ALMessage
): string {
    if (!targets) {
        return msg.id.senderId;
    }

    switch (targets.mode) {
        case 'unicast':
            return msg.id.senderId;
        case 'multicast':
            return toALGroupTargetKey(targets.groupRef);
        case 'broadcast':
            return msg.route.contextId;
    }
}

function toDefaultMaxStalenessMs(msg: ALMessage): number {
    return msg.payload.typeId.endsWith('.typing.v1') ? 5_000 : 60_000;
}

function durabilityRank(algo: ALDurabilityAlgo): number {
    return DURABILITY_ORDER.indexOf(algo);
}

function pickHighestAvailableDurability(
    supportedDurability: readonly ALDurabilityAlgo[],
    maxDurability: ALDurabilityAlgo
): ALDurabilityAlgo | undefined {
    const maxRank = durabilityRank(maxDurability);
    let candidate: ALDurabilityAlgo | undefined;

    for (const algo of supportedDurability) {
        if (durabilityRank(algo) <= maxRank) {
            if (!candidate || durabilityRank(algo) > durabilityRank(candidate)) {
                candidate = algo;
            }
        }
    }

    return candidate;
}

function stableRank(input: string): number {
    let value = 0;

    for (let i = 0; i < input.length; i += 1) {
        value = (value * 31 + input.charCodeAt(i)) >>> 0;
    }

    return value;
}
