import type {
    ALConstraints,
    ALDelivery,
    ALForwarding,
    ALMessage,
    ALTargets
} from './al-contract.ts';

import type {
    ALAckAlgo,
    ALDeliveryAlgo,
    ALDurabilityAlgo,
    ALEffectiveAlgorithm,
    ALQosAuthorization,
    ALQosCapabilities,
    ALQosEffectivePolicy,
    ALQosNormalizationInput,
    ALQosNormalizationNote,
    ALQosNormalizationResult,
    ALQosPolicyRequest,
    ALRequestedAlgorithm
} from './al-policy.ts';

interface ALDefaultDeliveryPolicy
    extends Pick<ALQosEffectivePolicy, 'delivery' | 'repair' | 'ack' | 'retry' | 'congestion'> {}

interface ALQosPolicyAdjustment {
    readonly effective: ALQosEffectivePolicy;
    readonly notes: readonly ALQosNormalizationNote[];
    readonly unmetRequirements: readonly string[];
}

interface ALAspectNormalization<TAlgo extends string, TOpts extends object> {
    readonly effective: ALEffectiveAlgorithm<TAlgo, TOpts>;
    readonly notes: readonly ALQosNormalizationNote[];
}

interface ALAspectNormalizationInput<TAlgo extends string, TOpts extends object> {
    readonly aspect: keyof ALQosEffectivePolicy;
    readonly requested: ALRequestedAlgorithm<TAlgo, TOpts> | undefined;
    readonly fallback: ALEffectiveAlgorithm<TAlgo, TOpts>;
    readonly supported: readonly TAlgo[];
}

interface ALQosNormalizationPolicy {
    readonly requested: ALQosPolicyRequest;
    readonly defaults: ALQosEffectivePolicy;
    readonly capabilities: ALQosCapabilities;
}

type ALNormalizedQosAspects = {
    readonly [Aspect in keyof ALQosEffectivePolicy]: {
        readonly effective: ALQosEffectivePolicy[Aspect];
        readonly notes: readonly ALQosNormalizationNote[];
    };
};

interface ALNormalizedTransportAspects
    extends
        Pick<
            ALNormalizedQosAspects,
            'delivery' | 'forwarding' | 'repair' | 'ack' | 'retry' | 'fanout' | 'congestion'
        > {}

interface ALNormalizedRetentionAspects
    extends Pick<ALNormalizedQosAspects, 'expiry' | 'dedup' | 'supersedence' | 'durability' | 'ownership'> {}

interface ALNumericClamp {
    readonly aspect: keyof ALQosEffectivePolicy;
    readonly requested: number | undefined;
    readonly effective: number | undefined;
    readonly reason: string;
}

interface ALAlgorithmAuthorization<TAlgo extends string, TOpts extends object> {
    readonly effective: ALEffectiveAlgorithm<TAlgo, TOpts>;
    readonly notes: readonly ALQosNormalizationNote[];
    readonly unmetRequirements: readonly string[];
}

interface ALAlgorithmAuthorizationPolicy<TAlgo extends string, TOpts extends object> {
    readonly aspect: 'ownership' | 'repair';
    readonly effective: ALEffectiveAlgorithm<TAlgo, TOpts>;
    readonly allowed: readonly TAlgo[] | undefined;
    readonly supported: readonly TAlgo[];
}

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

export function toDefaultALSemanticKey(msg: ALMessage): string {
    return `${msg.id.senderId}:${msg.route.topicId}/${msg.route.contextId}/${msg.route.resourceId}`;
}

export function normalizeALQosPolicy(msg: ALMessage, input: ALQosNormalizationInput = {}): ALQosNormalizationResult {
    const capabilities = { ...DEFAULT_AL_QOS_CAPABILITIES, ...input.capabilities };
    const requested = mergePolicyRequests([toALQosPolicyRequest(msg), msg.qos, input.request]);
    const defaults = mergeEffectivePolicy(toDefaultEffectivePolicy(msg), input.defaults);
    const normalized = normalizePolicyAspects({ requested, defaults, capabilities });
    const aligned = alignRequestedDurability(normalized.effective, requested, capabilities);
    const clamped = clampEffectivePolicy(aligned.effective, capabilities);
    const authorized = applyAuthorization(clamped.effective, capabilities, input.authorization);
    const live = applyLiveState(authorized.effective, input.live);
    const consistent = enforceCrossAspectConsistency(live.effective);
    return {
        requested,
        effective: consistent.effective,
        notes: [
            ...normalized.notes,
            ...aligned.notes,
            ...clamped.notes,
            ...authorized.notes,
            ...live.notes,
            ...consistent.notes
        ],
        unmetRequirements: authorized.unmetRequirements
    };
}

function toALQosPolicyRequest(msg: ALMessage): ALQosPolicyRequest {
    return {
        delivery: msg.delivery
            ? { algo: toDeliveryAlgo(msg.delivery) }
            : undefined,
        forwarding: toForwardingRequest(msg.targets, msg.forwarding),
        repair: msg.delivery?.reliability === 'at-least-once'
            ? {
                algo: msg.targets?.mode === 'unicast' ? 'none' : 'retransmit',
                opts: { maxRepairs: 1 }
            }
            : undefined,
        ack: toAckRequest(msg.delivery),
        expiry: toExpiryRequest(msg.constraints, msg),
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
                semanticKey: toDefaultALSemanticKey(msg)
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

function toDeliveryAlgo(delivery: ALDelivery): ALDeliveryAlgo {
    if (delivery.reliability === 'at-least-once') {
        return 'at-least-once';
    }

    return 'best-effort';
}

function toForwardingRequest(
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

function toAckRequest(delivery: ALDelivery | undefined): ALQosPolicyRequest['ack'] {
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

function toExpiryRequest(
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
    const deliveryAlgo = toDeliveryAlgo(
        msg.delivery ?? {
            reliability: 'best-effort',
            ack: 'none'
        }
    );

    return {
        ...toDefaultDeliveryPolicy(deliveryAlgo, msg.targets),
        forwarding: {
            algo: 'target',
            opts: {
                overlayId: msg.forwarding?.overlayId ??
                    (msg.targets?.mode === 'multicast'
                        ? msg.targets.groupRef.groupId
                        : msg.route.contextId)
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
        dedup: {
            algo: 'msg-id',
            opts: {
                windowMs: 60_000,
                semanticKey: toDefaultALSemanticKey(msg)
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

function toDefaultDeliveryPolicy(
    deliveryAlgo: ALDeliveryAlgo,
    targets: ALTargets | undefined
): ALDefaultDeliveryPolicy {
    return {
        delivery: { algo: deliveryAlgo, opts: {} },
        repair: {
            algo: deliveryAlgo === 'at-least-once'
                ? (targets?.mode === 'unicast' ? 'none' : 'retransmit')
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
        retry: {
            algo: deliveryAlgo === 'at-least-once' ? 'exp-backoff' : 'none',
            opts: {
                maxAttempts: 3
            }
        },
        congestion: {
            algo: 'drop-low',
            opts: {
                priority: deliveryAlgo === 'at-least-once' ? 5 : 0
            }
        }
    };
}

function mergePolicyRequests(requests: readonly (ALQosPolicyRequest | undefined)[]): ALQosPolicyRequest {
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

function mergeRequestedAlgorithm<TAlgo extends string, TOpts extends object>(
    base: ALRequestedAlgorithm<TAlgo, TOpts> | undefined,
    override: ALRequestedAlgorithm<TAlgo, TOpts> | undefined
): ALRequestedAlgorithm<TAlgo, TOpts> | undefined {
    if (!base) {
        return override;
    }

    if (!override) {
        return base;
    }

    if (!base.opts || !override.opts) {
        return { algo: override.algo, opts: override.opts ?? base.opts };
    }
    return { algo: override.algo, opts: { ...base.opts, ...override.opts } };
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

function mergeEffectiveAlgorithm<TAlgo extends string, TOpts extends object>(
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
    const preferredSupported = preferred.find((candidate) => supported.some((algorithm) => algorithm === candidate));
    return supported.find((algorithm) => algorithm === preferredSupported) ?? supported[0];
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

function toDefaultMaxStalenessMs(msg: ALMessage): number {
    return msg.payload.typeId.endsWith('.typing.v1') ? 5_000 : 60_000;
}

function normalizePolicyAspects(policy: ALQosNormalizationPolicy): ALQosPolicyAdjustment {
    const aspects = { ...normalizeTransportAspects(policy), ...normalizeRetentionAspects(policy) };
    return {
        effective: {
            delivery: aspects.delivery.effective,
            forwarding: aspects.forwarding.effective,
            repair: aspects.repair.effective,
            ack: aspects.ack.effective,
            expiry: aspects.expiry.effective,
            retry: aspects.retry.effective,
            dedup: aspects.dedup.effective,
            supersedence: aspects.supersedence.effective,
            fanout: aspects.fanout.effective,
            congestion: aspects.congestion.effective,
            durability: aspects.durability.effective,
            ownership: aspects.ownership.effective
        },
        notes: [
            aspects.delivery,
            aspects.forwarding,
            aspects.repair,
            aspects.ack,
            aspects.expiry,
            aspects.retry,
            aspects.dedup,
            aspects.supersedence,
            aspects.fanout,
            aspects.congestion,
            aspects.durability,
            aspects.ownership
        ].flatMap((aspect) => aspect.notes),
        unmetRequirements: []
    };
}

function normalizeTransportAspects(policy: ALQosNormalizationPolicy): ALNormalizedTransportAspects {
    const { requested, defaults, capabilities } = policy;
    return {
        delivery: normalizeAspect({
            aspect: 'delivery',
            requested: requested.delivery,
            fallback: defaults.delivery,
            supported: capabilities.supportedDelivery
        }),
        forwarding: normalizeAspect({
            aspect: 'forwarding',
            requested: requested.forwarding,
            fallback: defaults.forwarding,
            supported: capabilities.supportedForwarding
        }),
        repair: normalizeAspect({
            aspect: 'repair',
            requested: requested.repair,
            fallback: defaults.repair,
            supported: capabilities.supportedRepair
        }),
        ack: normalizeAspect({
            aspect: 'ack',
            requested: requested.ack,
            fallback: defaults.ack,
            supported: capabilities.supportedAck
        }),
        retry: normalizeAspect({
            aspect: 'retry',
            requested: requested.retry,
            fallback: defaults.retry,
            supported: capabilities.supportedRetry
        }),
        fanout: normalizeAspect({
            aspect: 'fanout',
            requested: requested.fanout,
            fallback: defaults.fanout,
            supported: capabilities.supportedFanout
        }),
        congestion: normalizeAspect({
            aspect: 'congestion',
            requested: requested.congestion,
            fallback: defaults.congestion,
            supported: capabilities.supportedCongestion
        })
    };
}

function normalizeRetentionAspects(policy: ALQosNormalizationPolicy): ALNormalizedRetentionAspects {
    const { requested, defaults, capabilities } = policy;
    return {
        expiry: normalizeAspect({
            aspect: 'expiry',
            requested: requested.expiry,
            fallback: defaults.expiry,
            supported: capabilities.supportedExpiry
        }),
        dedup: normalizeAspect({
            aspect: 'dedup',
            requested: requested.dedup,
            fallback: defaults.dedup,
            supported: capabilities.supportedDedup
        }),
        supersedence: normalizeAspect({
            aspect: 'supersedence',
            requested: requested.supersedence,
            fallback: defaults.supersedence,
            supported: capabilities.supportedSupersedence
        }),
        durability: normalizeAspect({
            aspect: 'durability',
            requested: requested.durability,
            fallback: defaults.durability,
            supported: capabilities.supportedDurability
        }),
        ownership: normalizeAspect({
            aspect: 'ownership',
            requested: requested.ownership,
            fallback: defaults.ownership,
            supported: capabilities.supportedOwnership
        })
    };
}

function normalizeAspect<TAlgo extends string, TOpts extends object>(
    policy: ALAspectNormalizationInput<TAlgo, TOpts>
): ALAspectNormalization<TAlgo, TOpts> {
    const { requested, fallback, aspect, supported } = policy;
    if (!requested) {
        return {
            effective: fallback,
            notes: [{
                aspect,
                kind: 'defaulted',
                reason: 'No explicit policy requested for aspect',
                effective: fallback.algo
            }]
        };
    }
    const opts = { ...fallback.opts, ...requested.opts };
    if (supported.includes(requested.algo)) {
        return { effective: { algo: requested.algo, opts }, notes: [] };
    }
    const algo = supported.includes(fallback.algo) ? fallback.algo : pickFallbackAlgorithm(aspect, supported);
    return {
        effective: { algo, opts },
        notes: [{
            aspect,
            kind: 'downgraded',
            reason: 'Requested algorithm is not supported locally',
            requested: requested.algo,
            effective: algo
        }]
    };
}

function clampEffectivePolicy(effective: ALQosEffectivePolicy, capabilities: ALQosCapabilities): ALQosPolicyAdjustment {
    const ttlHops = effective.expiry.opts.ttlHops === undefined
        ? undefined
        : Math.max(0, Math.min(effective.expiry.opts.ttlHops, capabilities.maxTtlHops));
    const limit = effective.fanout.opts.limit === undefined
        ? undefined
        : Math.max(1, Math.min(effective.fanout.opts.limit, capabilities.maxFanout));
    const timeoutMs = Math.max(0, Math.min(effective.ack.opts.timeoutMs, capabilities.maxAckTimeoutMs));
    const maxAttempts = Math.max(0, Math.min(effective.retry.opts.maxAttempts, capabilities.maxRetryAttempts));
    const windowMs = Math.max(0, Math.min(effective.dedup.opts.windowMs, capabilities.maxDedupWindowMs));
    const clamps: readonly ALNumericClamp[] = [
        {
            aspect: 'expiry',
            requested: effective.expiry.opts.ttlHops,
            effective: ttlHops,
            reason: 'ttlHops clamped to local maximum'
        },
        {
            aspect: 'fanout',
            requested: effective.fanout.opts.limit,
            effective: limit,
            reason: 'fanout limit clamped to local maximum'
        },
        {
            aspect: 'ack',
            requested: effective.ack.opts.timeoutMs,
            effective: timeoutMs,
            reason: 'Ack timeout clamped to local maximum'
        },
        {
            aspect: 'retry',
            requested: effective.retry.opts.maxAttempts,
            effective: maxAttempts,
            reason: 'Retry attempts clamped to local maximum'
        },
        {
            aspect: 'dedup',
            requested: effective.dedup.opts.windowMs,
            effective: windowMs,
            reason: 'Dedup window clamped to local maximum'
        }
    ];
    return {
        effective: {
            ...effective,
            expiry: { ...effective.expiry, opts: { ...effective.expiry.opts, ttlHops } },
            fanout: { ...effective.fanout, opts: { ...effective.fanout.opts, limit } },
            ack: { ...effective.ack, opts: { ...effective.ack.opts, timeoutMs } },
            retry: { ...effective.retry, opts: { ...effective.retry.opts, maxAttempts } },
            dedup: { ...effective.dedup, opts: { ...effective.dedup.opts, windowMs } }
        },
        notes: clamps.filter((clamp) => clamp.requested !== clamp.effective).map(toClampNote),
        unmetRequirements: []
    };
}

function toClampNote(clamp: ALNumericClamp): ALQosNormalizationNote {
    return {
        aspect: clamp.aspect,
        kind: 'clamped',
        reason: clamp.reason,
        requested: clamp.requested?.toString(),
        effective: clamp.effective?.toString()
    };
}

function alignRequestedDurability(
    effective: ALQosEffectivePolicy,
    requested: ALQosPolicyRequest,
    capabilities: ALQosCapabilities
): ALQosPolicyAdjustment {
    const requestedDurability = requested.durability?.algo;
    const replacement = requestedDurability &&
        pickHighestAvailableDurability(capabilities.supportedDurability, requestedDurability);
    if (!replacement || durabilityRank(replacement) <= durabilityRank(effective.durability.algo)) {
        return { effective, notes: [], unmetRequirements: [] };
    }
    return {
        effective: { ...effective, durability: { algo: replacement, opts: {} } },
        notes: [{
            aspect: 'durability',
            kind: 'downgraded',
            reason: 'Durability normalized to the strongest supported level under the requested policy',
            requested: requestedDurability,
            effective: replacement
        }],
        unmetRequirements: []
    };
}

function authorizeAlgorithm<TAlgo extends string, TOpts extends object>(
    policy: ALAlgorithmAuthorizationPolicy<TAlgo, TOpts>
): ALAlgorithmAuthorization<TAlgo, TOpts> {
    const { effective, allowed, supported, aspect } = policy;
    if (!allowed || allowed.includes(effective.algo)) {
        return { effective, notes: [], unmetRequirements: [] };
    }
    const replacement = allowed.find((candidate) => supported.includes(candidate));
    if (!replacement) {
        return {
            effective,
            notes: [],
            unmetRequirements: [
                `No authorized ${aspect === 'repair' ? 'repair strategy' : 'ownership'} available for ${effective.algo}`
            ]
        };
    }
    return {
        effective: { ...effective, algo: replacement },
        notes: [{
            aspect,
            kind: 'downgraded',
            reason: aspect === 'repair'
                ? 'Requested repair strategy is not authorized'
                : 'Requested ownership is not authorized',
            requested: effective.algo,
            effective: replacement
        }],
        unmetRequirements: []
    };
}

function applyAuthorization(
    effective: ALQosEffectivePolicy,
    capabilities: ALQosCapabilities,
    authorization: ALQosAuthorization | undefined
): ALQosPolicyAdjustment {
    const ownership = authorizeAlgorithm({
        aspect: 'ownership',
        effective: effective.ownership,
        allowed: authorization?.allowedOwnerships,
        supported: capabilities.supportedOwnership
    });
    const repair = authorizeAlgorithm({
        aspect: 'repair',
        effective: effective.repair,
        allowed: authorization?.allowedRepairs,
        supported: capabilities.supportedRepair
    });
    const durability = authorizeDurability(effective, capabilities, authorization?.maxDurability);
    return {
        effective: {
            ...effective,
            ownership: ownership.effective,
            repair: repair.effective,
            durability: durability.effective.durability
        },
        notes: [...ownership.notes, ...repair.notes, ...durability.notes],
        unmetRequirements: [
            ...ownership.unmetRequirements,
            ...repair.unmetRequirements,
            ...durability.unmetRequirements
        ]
    };
}

function authorizeDurability(
    effective: ALQosEffectivePolicy,
    capabilities: ALQosCapabilities,
    maximum: ALDurabilityAlgo | undefined
): ALQosPolicyAdjustment {
    if (maximum === undefined || durabilityRank(effective.durability.algo) <= durabilityRank(maximum)) {
        return { effective, notes: [], unmetRequirements: [] };
    }
    const replacement = pickHighestAvailableDurability(capabilities.supportedDurability, maximum);
    if (!replacement) {
        return {
            effective,
            notes: [],
            unmetRequirements: [`No authorized durability available for ${effective.durability.algo}`]
        };
    }
    return {
        effective: { ...effective, durability: { algo: replacement, opts: {} } },
        notes: [{
            aspect: 'durability',
            kind: 'downgraded',
            reason: 'Requested durability exceeds authorization',
            requested: effective.durability.algo,
            effective: replacement
        }],
        unmetRequirements: []
    };
}

function applyLiveState(effective: ALQosEffectivePolicy, live: ALQosNormalizationInput['live']): ALQosPolicyAdjustment {
    if (effective.fanout.algo === 'all' || live?.connectedNeighborCount === undefined) {
        return { effective, notes: [], unmetRequirements: [] };
    }
    const currentLimit = effective.fanout.opts.limit ?? live.connectedNeighborCount;
    const limit = Math.max(1, Math.min(currentLimit, live.connectedNeighborCount || 1));
    return {
        effective: { ...effective, fanout: { ...effective.fanout, opts: { ...effective.fanout.opts, limit } } },
        notes: currentLimit === limit
            ? []
            : [{
                aspect: 'fanout',
                kind: 'clamped',
                reason: 'Fanout clamped to currently connected neighbors',
                requested: currentLimit.toString(),
                effective: limit.toString()
            }],
        unmetRequirements: []
    };
}

function enforceCrossAspectConsistency(effective: ALQosEffectivePolicy): ALQosPolicyAdjustment {
    if (effective.delivery.algo !== 'best-effort' || effective.retry.algo === 'none') {
        return { effective, notes: [], unmetRequirements: [] };
    }
    return {
        effective: { ...effective, retry: { ...effective.retry, algo: 'none' } },
        notes: [{
            aspect: 'retry',
            kind: 'downgraded',
            reason: 'Best-effort delivery disables retries',
            requested: effective.retry.algo,
            effective: 'none'
        }],
        unmetRequirements: []
    };
}
