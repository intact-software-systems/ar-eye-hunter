import { Temporal } from '@js-temporal/polyfill';
import type {
    ALAckPayload,
    ALAckStatus,
    ALCompletedPendingAck,
    ALControlAcceptance,
    ALControlPersistenceValue,
    ALNackPayload,
    ALPendingAckSnapshot,
    ALRepairPayload,
} from '../al-contracts/al-control.ts';
import { newALAckControlMessage, parseALControlMessage, } from '../al-contracts/al-control.ts';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../al-contracts/al-policy.ts';
import { resolveALMessageExpireAtMs } from '../al-contracts/al-policy.ts';
import type {
    ALDedupStoreLike,
    ALOrderingObservation,
    ALOrderingTrackSnapshot,
    ALReadyable,
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedencePersistenceValue,
} from '../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../al-contracts/al-runtime.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { IndexedDbStringPersistenceProvider } from '../persistence/IndexedDbStringPersistenceProvider.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import type { ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type { ALBufferedOrderedMessageSnapshot } from './ALRuntimeStateStores.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import type { ALRuntimeStoreRetentionConfig, NormalizedALRuntimeStoreRetentionConfig } from './ALStoreRetention.ts';
import {
    normalizeALRuntimeStoreRetention,
    resolveExpireAtTimestampWithFallback,
    toExpireAtTimestampFromNow,
} from './ALStoreRetention.ts';

type StoredValue = Readonly<{
    key: string;
    value: unknown;
    expireAtTimestamp: number;
}>;

type StoredResourceEntry = Readonly<{
    key: ResourceEntry['key'];
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    status: ResourceEntry['status'];
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
    db?: ResourceEntry['db'];
}>;

type LatestSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'latest' }>>;
type ReplacementSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'replacement' }>>;
type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending' }>>;
type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks' }>>;
type NacksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'nacks' }>>;
type RepairsControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'repairs' }>>;

export type ALVersionedClientRecord = Readonly<{
    senderId: string;
    version: number;
}>;

export type ALInboundPlanner = (
    msg: ALMessage,
    fromPeerId: string,
    runtime: Readonly<{
        dedupStore?: ALDedupStoreLike;
        orderingStore?: Readonly<{
            peek(msg: ALMessage, nowMs?: number): ALOrderingObservation;
        }>;
        supersedenceStore?: Readonly<{
            peek(input: ALSupersedenceInput, nowMs?: number): ALSupersedenceObservation;
        }>;
    }>,
) => ALMessageHandlingPlan;

export type ALInboundSupersedenceReadState = Readonly<{
    key?: string;
    latest?: LatestSupersedenceValue;
    replacement?: ReplacementSupersedenceValue;
}>;

export type ALInboundMessageReadDto = Readonly<{
    kind: 'incoming';
    msg: ALMessage;
    fromPeerId: string;
    nowMs: number;
    clientRecord?: ALVersionedClientRecord;
    orderingSnapshot?: ALOrderingTrackSnapshot;
    orderingAcceptance: Readonly<{
        observation: ALOrderingObservation;
        nextSnapshot?: ALOrderingTrackSnapshot;
    }>;
    bufferedSnapshots: readonly ALBufferedOrderedMessageSnapshot[];
    supersedence: ALInboundSupersedenceReadState;
    supersedenceAcceptance?: Readonly<{
        observation: ALSupersedenceObservation;
        latestWrite?: LatestSupersedenceValue;
        replacementWrites: readonly Readonly<{
            msgId: string;
            value: ReplacementSupersedenceValue;
        }>[];
    }>;
    pendingAck?: ALPendingAckSnapshot;
    acks: readonly ALAckPayload[];
    plan: ALMessageHandlingPlan;
}>;

export type ALInboundBufferedReleaseReadDto = Readonly<{
    kind: 'buffered-release';
    nowMs: number;
    clientRecord?: ALVersionedClientRecord;
    snapshot: ALBufferedOrderedMessageSnapshot;
    supersedence: ALInboundSupersedenceReadState;
    supersedenceAcceptance?: Readonly<{
        observation: ALSupersedenceObservation;
        latestWrite?: LatestSupersedenceValue;
        replacementWrites: readonly Readonly<{
            msgId: string;
            value: ReplacementSupersedenceValue;
        }>[];
    }>;
    pendingAck?: ALPendingAckSnapshot;
    acks: readonly ALAckPayload[];
}>;

export type ALInboundAdmissionMutation =
    | Readonly<{
    kind: 'set-msg-owner';
    msgId: string;
    senderId: string;
}>
    | Readonly<{
    kind: 'set-dedup';
    dedupKey: string;
    expireAtTimestamp: number;
}>
    | Readonly<{
    kind: 'set-ordering';
    trackKey: string;
    snapshot: ALOrderingTrackSnapshot;
}>
    | Readonly<{
    kind: 'delete-ordering';
    trackKey: string;
}>
    | Readonly<{
    kind: 'set-supersedence-latest';
    supersedenceKey: string;
    value: LatestSupersedenceValue;
}>
    | Readonly<{
    kind: 'set-supersedence-replacement';
    msgId: string;
    value: ReplacementSupersedenceValue;
}>
    | Readonly<{
    kind: 'set-control-pending';
    msgId: string;
    value: PendingControlValue;
}>
    | Readonly<{
    kind: 'delete-control-pending';
    msgId: string;
}>
    | Readonly<{
    kind: 'set-buffered';
    snapshot: ALBufferedOrderedMessageSnapshot;
}>
    | Readonly<{
    kind: 'delete-buffered';
    trackKey: string;
    seq: number;
}>;

export type ALInboundWriteRequest = Readonly<{
    senderId: string;
    expectedVersion?: number;
    mutations: readonly ALInboundAdmissionMutation[];
}>;

export type ALInboundDurableEffect =
    | Readonly<{
    kind: 'dispatch-local';
    msg: ALMessage;
    entry: ResourceEntry;
    plan: ALMessageHandlingPlan;
}>
    | Readonly<{
    kind: 'enqueue-inbox';
    msg: ALMessage;
    entry: ResourceEntry;
    plan: ALMessageHandlingPlan;
}>
    | Readonly<{
    kind: 'send-control';
    msg: ALMessage;
}>
    | Readonly<{
    kind: 'forward-message';
    msg: ALMessage;
    fromPeerId: string;
    plan: ALMessageHandlingPlan;
}>
    | Readonly<{
    kind: 'release-buffered';
    trackKey: string;
    seq: number;
}>;

export type ALInboundDurableEffectWrite = Readonly<{
    effectId: string;
    payload: ALInboundDurableEffect;
    expireAtTimestamp?: number;
}>;

export type ALPersistedInboundEffect = Readonly<{
    effectId: string;
    payload: ALInboundDurableEffect;
    status: 'pending' | 'running';
    attempts: number;
    retryAtMs: number;
    leaseOwner?: string;
    leaseUntilMs?: number;
    lastError?: string;
    updatedAtMs: number;
    expireAtTimestamp: number;
}>;

type StoredALInboundDurableEffect =
    | Readonly<{
    kind: 'dispatch-local';
    msg: ALMessage;
    entry: StoredResourceEntry;
    plan: ALMessageHandlingPlan;
}>
    | Readonly<{
    kind: 'enqueue-inbox';
    msg: ALMessage;
    entry: StoredResourceEntry;
    plan: ALMessageHandlingPlan;
}>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'send-control' }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'forward-message' }>>
    | Extract<ALInboundDurableEffect, Readonly<{ kind: 'release-buffered' }>>;

type StoredALPersistedInboundEffect = Omit<ALPersistedInboundEffect, 'payload'> & Readonly<{
    payload: StoredALInboundDurableEffect;
}>;

export type ALInboundCommitBundle = Readonly<{
    senderId: string;
    expectedVersion?: number;
    mutations: readonly ALInboundAdmissionMutation[];
    durableEffects: readonly ALInboundDurableEffectWrite[];
}>;

export type ALInboundAdmissionStoreConfig =
    | Readonly<{
    kind: 'memory';
    namespace: string;
    orderingTrackTtlMs: number;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
    state: ALInboundAdmissionMemoryState;
}>
    | Readonly<{
    kind: 'backend';
    namespace: string;
    backend: ALInboundAdmissionBackend;
    orderingTrackTtlMs: number;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>
    | Readonly<{
    kind: 'provider';
    namespace: string;
    provider: PersistenceProvider<string, unknown>;
    coordinationKey?: string;
    orderingTrackTtlMs: number;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>
    | Readonly<{
    kind: 'indexeddb';
    namespace: string;
    dbName?: string;
    storeName?: string;
    orderingTrackTtlMs: number;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>;

export interface ALInboundAdmissionStore extends ALReadyable {
    readIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planner: ALInboundPlanner,
    ): Promise<ALInboundMessageReadDto>;

    readBufferedRelease(
        trackKey: string,
        seq: number,
    ): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    planStoredEntry(
        msg: ALMessage,
        planner: ALInboundPlanner,
    ): Promise<ALMessageHandlingPlan>;

    commitMutations(
        request: ALInboundWriteRequest,
    ): Promise<'committed' | 'conflict'>;

    commitBundle(
        bundle: ALInboundCommitBundle,
    ): Promise<'committed' | 'conflict'>;

    claimReadyEffects(
        workerId: string,
        maxCount: number,
        leaseMs: number,
        nowMs?: number,
    ): Promise<readonly ALPersistedInboundEffect[]>;

    completeEffect(
        effectId: string,
        workerId: string,
    ): Promise<void>;

    rescheduleEffect(
        effectId: string,
        workerId: string,
        retryAtMs: number,
        lastError?: string,
    ): Promise<void>;

    peekNextEffectReadyAt(
        nowMs?: number,
    ): Promise<number | undefined>;

    acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance>;
}

export type ALInboundAdmissionMemoryState = {
    readonly data: Map<string, StoredValue>;
    writeTail: Promise<void>;
};

export type ALInboundAdmissionBackend = Readonly<{
    ready(): Promise<void>;
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]>;
    write<T>(fn: (tx: ALInboundAdmissionWriteContext) => Promise<T>): Promise<T>;
}>;

export type ALInboundAdmissionWriteContext = Readonly<{
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]>;
    set<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
    remove(key: string): Promise<void>;
}>;

const providerWriteTailByCoordinationKey = new Map<string, Promise<void>>();

export function createInMemoryALInboundAdmissionState(): ALInboundAdmissionMemoryState {
    return {
        data: new Map<string, StoredValue>(),
        writeTail: Promise.resolve(),
    };
}

export function createALInboundAdmissionStore(
    config: ALInboundAdmissionStoreConfig,
): ALInboundAdmissionStore {
    const retention = normalizeALRuntimeStoreRetention(config.retention);
    switch (config.kind) {
        case 'memory':
            return new ProviderBackedALInboundAdmissionStore(
                config.namespace,
                config.orderingTrackTtlMs,
                config.supersedenceTrackTtlMs,
                retention,
                new InMemoryAdmissionBackend(config.state),
            );
        case 'backend':
            return new ProviderBackedALInboundAdmissionStore(
                config.namespace,
                config.orderingTrackTtlMs,
                config.supersedenceTrackTtlMs,
                retention,
                config.backend,
            );
        case 'provider':
            return new ProviderBackedALInboundAdmissionStore(
                config.namespace,
                config.orderingTrackTtlMs,
                config.supersedenceTrackTtlMs,
                retention,
                new PersistenceProviderAdmissionBackend(
                    config.provider,
                    config.coordinationKey ?? config.namespace,
                ),
            );
        case 'indexeddb':
            return new ProviderBackedALInboundAdmissionStore(
                config.namespace,
                config.orderingTrackTtlMs,
                config.supersedenceTrackTtlMs,
                retention,
                new IndexedDbAdmissionBackend(
                    config.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME,
                    config.storeName ?? IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                ),
            );
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    constructor(
        private readonly namespace: string,
        private readonly orderingTrackTtlMs: number,
        private readonly supersedenceTrackTtlMs: number,
        private readonly retention: NormalizedALRuntimeStoreRetentionConfig,
        private readonly backend: ALInboundAdmissionBackend,
    ) {
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planner: ALInboundPlanner,
    ): Promise<ALInboundMessageReadDto> {
        const nowMs = Date.now();
        const clientRecord = await this.backend.get<ALVersionedClientRecord>(
            this.toVersionKey(msg.id.senderId),
        );
        const prePlan = planner(
            msg,
            fromPeerId,
            {
                dedupStore: undefined,
                orderingStore: undefined,
                supersedenceStore: undefined,
            },
        );
        const dedupExpiresAt = await this.backend.get<number>(this.toDedupKey(prePlan.dedupKey));
        const orderingTrackKey = toALOrderingTrackKey(msg);
        const orderingSnapshot = orderingTrackKey
            ? await this.backend.get<ALOrderingTrackSnapshot>(this.toOrderingKey(orderingTrackKey))
            : undefined;
        const bufferedSnapshots = orderingTrackKey
            ? [...await this.backend.list<ALBufferedOrderedMessageSnapshot>(this.toBufferedTrackPrefix(orderingTrackKey))]
                .map(entry => entry.value)
                .sort((left, right) => left.seq - right.seq)
            : [];
        const orderingAcceptance = acceptOrderingObservation(
            orderingSnapshot,
            msg,
            nowMs,
            this.orderingTrackTtlMs,
        );
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);
        const pendingAck = toPendingSnapshot(
            await this.backend.get<ALControlPersistenceValue>(this.toControlPendingKey(msg.id.msgId)),
        );
        const acks = toAcks(
            await this.backend.get<ALControlPersistenceValue>(this.toControlAcksKey(msg.id.msgId)),
        );
        const plan = planner(
            msg,
            fromPeerId,
            {
                dedupStore: {
                    has: (key, queryNowMs = nowMs) =>
                        key === prePlan.dedupKey
                        && dedupExpiresAt !== undefined
                        && dedupExpiresAt > queryNowMs,
                },
                orderingStore: {
                    peek: (candidate, queryNowMs = nowMs) => {
                        if (
                            orderingTrackKey === undefined
                            || candidate.id.msgId !== msg.id.msgId
                            || toALOrderingTrackKey(candidate) !== orderingTrackKey
                        ) {
                            return {
                                status: 'untracked',
                                missingSeqs: [],
                                releasableSeqs: [],
                            } satisfies ALOrderingObservation;
                        }

                        return peekOrderingObservation(
                            orderingSnapshot,
                            candidate,
                            queryNowMs,
                            this.orderingTrackTtlMs,
                        );
                    },
                },
                supersedenceStore: {
                    peek: (input, queryNowMs = nowMs) => {
                        if (
                            input.msgId !== msg.id.msgId
                            || input.key !== prePlan.supersedence.key
                            || input.replacesMsgId !== prePlan.supersedence.replacesMsgId
                        ) {
                            return {
                                status: 'untracked',
                            } satisfies ALSupersedenceObservation;
                        }

                        return peekSupersedenceObservation(
                            input,
                            supersedence.latest,
                            supersedence.replacement,
                            queryNowMs,
                            this.supersedenceTrackTtlMs,
                        );
                    },
                },
            },
        );
        const supersedenceAcceptance = toSupersedenceInput(msg, plan)
            ? acceptSupersedenceObservation(
                toSupersedenceInput(msg, plan)!,
                supersedence.latest,
                supersedence.replacement,
                nowMs,
                this.supersedenceTrackTtlMs,
            )
            : undefined;

        return {
            kind: 'incoming',
            msg,
            fromPeerId,
            nowMs,
            clientRecord,
            orderingSnapshot: normalizeOrderingSnapshot(orderingSnapshot, nowMs, this.orderingTrackTtlMs),
            orderingAcceptance,
            bufferedSnapshots,
            supersedence,
            supersedenceAcceptance,
            pendingAck,
            acks,
            plan,
        };
    }

    async readBufferedRelease(
        trackKey: string,
        seq: number,
    ): Promise<ALInboundBufferedReleaseReadDto | undefined> {
        const snapshot = await this.backend.get<ALBufferedOrderedMessageSnapshot>(
            this.toBufferedKey(trackKey, seq),
        );
        if (!snapshot) {
            return undefined;
        }

        const nowMs = Date.now();
        const clientRecord = await this.backend.get<ALVersionedClientRecord>(
            this.toVersionKey(snapshot.msg.id.senderId),
        );
        const supersedence = await this.readSupersedenceState(
            snapshot.plan.supersedence.key,
            snapshot.msg.id.msgId,
        );
        const releasedPlan = {
            ...snapshot.plan,
            localDelivery: {
                ...snapshot.plan.localDelivery,
                enabled: true,
                deferred: false,
            },
        } satisfies ALMessageHandlingPlan;
        const supersedenceInput = toSupersedenceInput(snapshot.msg, releasedPlan);
        const pendingAck = toPendingSnapshot(
            await this.backend.get<ALControlPersistenceValue>(this.toControlPendingKey(snapshot.msg.id.msgId)),
        );
        const acks = toAcks(
            await this.backend.get<ALControlPersistenceValue>(this.toControlAcksKey(snapshot.msg.id.msgId)),
        );

        return {
            kind: 'buffered-release',
            nowMs,
            clientRecord,
            snapshot,
            supersedence,
            supersedenceAcceptance: supersedenceInput
                ? acceptSupersedenceObservation(
                    supersedenceInput,
                    supersedence.latest,
                    supersedence.replacement,
                    nowMs,
                    this.supersedenceTrackTtlMs,
                )
                : undefined,
            pendingAck,
            acks,
        };
    }

    async planStoredEntry(
        msg: ALMessage,
        planner: ALInboundPlanner,
    ): Promise<ALMessageHandlingPlan> {
        const prePlan = planner(
            msg,
            msg.id.senderId,
            {
                dedupStore: undefined,
                orderingStore: undefined,
                supersedenceStore: undefined,
            },
        );
        const nowMs = Date.now();
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);

        return planner(
            msg,
            msg.id.senderId,
            {
                dedupStore: undefined,
                orderingStore: undefined,
                supersedenceStore: {
                    peek: (input, queryNowMs = nowMs) => {
                        if (
                            input.msgId !== msg.id.msgId
                            || input.key !== prePlan.supersedence.key
                            || input.replacesMsgId !== prePlan.supersedence.replacesMsgId
                        ) {
                            return {
                                status: 'untracked',
                            } satisfies ALSupersedenceObservation;
                        }

                        return peekSupersedenceObservation(
                            input,
                            supersedence.latest,
                            supersedence.replacement,
                            queryNowMs,
                            this.supersedenceTrackTtlMs,
                        );
                    },
                },
            },
        );
    }

    async commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict'> {
        return await this.commitBundle({
            senderId: request.senderId,
            expectedVersion: request.expectedVersion,
            mutations: request.mutations,
            durableEffects: [],
        });
    }

    async commitBundle(
        bundle: ALInboundCommitBundle,
    ): Promise<'committed' | 'conflict'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

        try {
            return await this.backend.write(async tx => {
                const current = await tx.get<ALVersionedClientRecord>(this.toVersionKey(bundle.senderId));
                const currentVersion = current?.version;
                if (currentVersion !== bundle.expectedVersion) {
                    return 'conflict';
                }

                for (const mutation of bundle.mutations) {
                    await this.applyMutation(tx, mutation);
                }

                for (const effect of bundle.durableEffects) {
                    await this.persistEffect(tx, effect);
                }

                await this.bumpVersion(tx, bundle.senderId, currentVersion);

                return 'committed';
            });
        } catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) return 'conflict';
            throw error;
        }
    }

    async claimReadyEffects(
        workerId: string,
        maxCount: number,
        leaseMs: number,
        nowMs = Date.now(),
    ): Promise<readonly ALPersistedInboundEffect[]> {
        if (maxCount <= 0) {
            return [];
        }

        return await this.backend.write(async tx => {
            const claimed: ALPersistedInboundEffect[] = [];
            const effects = [...await tx.list<ALPersistedInboundEffect | StoredALPersistedInboundEffect>(this.toEffectPrefix())]
                .map(entry => toPersistedInboundEffect(entry.value))
                .filter((effect): effect is ALPersistedInboundEffect => effect !== undefined)
                .sort((left, right) =>
                    left.retryAtMs - right.retryAtMs
                    || left.effectId.localeCompare(right.effectId));

            for (const effect of effects) {
                if (claimed.length >= maxCount) {
                    break;
                }

                if (!this.isEffectReady(effect, nowMs)) {
                    continue;
                }

                const nextEffect: ALPersistedInboundEffect = {
                    ...effect,
                    status: 'running',
                    attempts: effect.attempts + 1,
                    leaseOwner: workerId,
                    leaseUntilMs: nowMs + leaseMs,
                    updatedAtMs: nowMs,
                };
                await tx.set(
                    this.toEffectKey(effect.effectId),
                    toStoredPersistedInboundEffect(nextEffect),
                    effect.expireAtTimestamp,
                );
                claimed.push(nextEffect);
            }

            return claimed;
        });
    }

    async completeEffect(
        effectId: string,
        workerId: string,
    ): Promise<void> {
        await this.backend.write(async tx => {
            const current = toPersistedInboundEffect(
                await tx.get<ALPersistedInboundEffect | StoredALPersistedInboundEffect>(this.toEffectKey(effectId)),
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.remove(this.toEffectKey(effectId));
        });
    }

    async rescheduleEffect(
        effectId: string,
        workerId: string,
        retryAtMs: number,
        lastError?: string,
    ): Promise<void> {
        await this.backend.write(async tx => {
            const current = toPersistedInboundEffect(
                await tx.get<ALPersistedInboundEffect | StoredALPersistedInboundEffect>(this.toEffectKey(effectId)),
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.set(
                this.toEffectKey(effectId),
                toStoredPersistedInboundEffect({
                    ...current,
                    status: 'pending',
                    retryAtMs,
                    leaseOwner: undefined,
                    leaseUntilMs: undefined,
                    lastError,
                    updatedAtMs: Date.now(),
                } satisfies ALPersistedInboundEffect),
                current.expireAtTimestamp,
            );
        });
    }

    async peekNextEffectReadyAt(
        nowMs = Date.now(),
    ): Promise<number | undefined> {
        let nextAt: number | undefined;

        for (const entry of await this.backend.list<ALPersistedInboundEffect | StoredALPersistedInboundEffect>(this.toEffectPrefix())) {
            const effect = toPersistedInboundEffect(entry.value);
            if (!effect) {
                continue;
            }
            const candidateAt =
                effect.status === 'running'
                    ? effect.leaseUntilMs
                    : effect.retryAtMs;
            if (candidateAt === undefined) {
                continue;
            }

            if (effect.status === 'running' && candidateAt > nowMs) {
                nextAt = nextAt === undefined ? candidateAt : Math.min(nextAt, candidateAt);
                continue;
            }

            nextAt = nextAt === undefined ? candidateAt : Math.min(nextAt, candidateAt);
        }

        return nextAt;
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance> {
        const parsed = parseALControlMessage(msg);
        if (!parsed) {
            return {
                handled: false,
                completedPendingAcks: [],
            };
        }

        return await this.backend.write(async tx => {
            const trackedMsgId = parsed.type === 'ack'
                ? parsed.payload.ackedMsgId
                : parsed.payload.msgId;
            const ownerSenderId = await tx.get<string>(this.toMsgOwnerKey(trackedMsgId));
            const nowMs = Date.now();

            switch (parsed.type) {
                case 'ack': {
                    const msgId = parsed.payload.ackedMsgId;
                    const currentAcks = toAcks(
                        await tx.get<ALControlPersistenceValue>(this.toControlAcksKey(msgId)),
                    );
                    const currentPending = toPendingSnapshot(
                        await tx.get<ALControlPersistenceValue>(this.toControlPendingKey(msgId)),
                    );
                    const nextAcks = [...currentAcks, parsed.payload];
                    const acceptance = acceptAckPayload(
                        currentPending,
                        nextAcks,
                        parsed.payload,
                    );

                    await tx.set(
                        this.toControlAcksKey(msgId),
                        {
                            kind: 'acks',
                            values: nextAcks,
                        } satisfies AcksControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );

                    if (acceptance.pending) {
                        await tx.set(
                            this.toControlPendingKey(msgId),
                            {
                                kind: 'pending',
                                value: acceptance.pending,
                            } satisfies PendingControlValue,
                            resolveExpireAtTimestampWithFallback(
                                acceptance.pending.expireAtTimestamp,
                                this.retention.controlPendingTtlMs,
                                nowMs,
                            ),
                        );
                    } else {
                        await tx.remove(this.toControlPendingKey(msgId));
                    }

                    const result = {
                        handled: true,
                        completedPendingAcks: acceptance.completed ? [acceptance.completed] : [],
                    } satisfies ALControlAcceptance;
                    if (acceptance.completed) {
                        await this.persistEffect(
                            tx,
                            this.toAckEffectWrite(
                                parsed.payload.toPeerId,
                                acceptance.completed.toPeerId,
                                acceptance.completed.msgId,
                                acceptance.completed.status,
                                acceptance.completed.expireAtTimestamp,
                            ),
                        );
                    }
                    if (ownerSenderId) {
                        await this.bumpVersion(tx, ownerSenderId);
                    }
                    return result;
                }
                case 'nack': {
                    const msgId = parsed.payload.msgId;
                    const currentNacks = toNacks(
                        await tx.get<ALControlPersistenceValue>(this.toControlNacksKey(msgId)),
                    );
                    await tx.set(
                        this.toControlNacksKey(msgId),
                        {
                            kind: 'nacks',
                            values: [...currentNacks, parsed.payload],
                        } satisfies NacksControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );
                    const result = {
                        handled: true,
                        completedPendingAcks: [],
                    } satisfies ALControlAcceptance;
                    if (ownerSenderId) {
                        await this.bumpVersion(tx, ownerSenderId);
                    }
                    return result;
                }
                case 'repair': {
                    const msgId = parsed.payload.msgId;
                    const currentRepairs = toRepairs(
                        await tx.get<ALControlPersistenceValue>(this.toControlRepairsKey(msgId)),
                    );
                    await tx.set(
                        this.toControlRepairsKey(msgId),
                        {
                            kind: 'repairs',
                            values: [...currentRepairs, parsed.payload],
                        } satisfies RepairsControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );
                    const result = {
                        handled: true,
                        completedPendingAcks: [],
                    } satisfies ALControlAcceptance;
                    if (ownerSenderId) {
                        await this.bumpVersion(tx, ownerSenderId);
                    }
                    return result;
                }
            }
        });
    }

    private async readSupersedenceState(
        key: string | undefined,
        msgId: string,
    ): Promise<ALInboundSupersedenceReadState> {
        if (!key) {
            return {};
        }

        const latest = toLatestSupersedence(
            await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceLatestKey(key)),
        );
        const replacement = toReplacementSupersedence(
            await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceReplacementKey(msgId)),
        );

        return {
            key,
            latest,
            replacement,
        };
    }

    private async applyMutation(
        tx: ALInboundAdmissionWriteContext,
        mutation: ALInboundAdmissionMutation,
    ): Promise<void> {
        switch (mutation.kind) {
            case 'set-msg-owner':
                await tx.set(
                    this.toMsgOwnerKey(mutation.msgId),
                    mutation.senderId,
                    toExpireAtTimestampFromNow(this.retention.msgOwnerTtlMs),
                );
                return;
            case 'set-dedup':
                await tx.set(this.toDedupKey(mutation.dedupKey), mutation.expireAtTimestamp, mutation.expireAtTimestamp);
                return;
            case 'set-ordering':
                await tx.set(
                    this.toOrderingKey(mutation.trackKey),
                    mutation.snapshot,
                    mutation.snapshot.updatedAtMs + this.orderingTrackTtlMs,
                );
                return;
            case 'delete-ordering':
                await tx.remove(this.toOrderingKey(mutation.trackKey));
                return;
            case 'set-supersedence-latest':
                await tx.set(
                    this.toSupersedenceLatestKey(mutation.supersedenceKey),
                    mutation.value,
                    mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                );
                return;
            case 'set-supersedence-replacement':
                await tx.set(
                    this.toSupersedenceReplacementKey(mutation.msgId),
                    mutation.value,
                    mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                );
                return;
            case 'set-control-pending':
                await tx.set(
                    this.toControlPendingKey(mutation.msgId),
                    mutation.value,
                    resolveExpireAtTimestampWithFallback(
                        mutation.value.value.expireAtTimestamp,
                        this.retention.controlPendingTtlMs,
                    ),
                );
                return;
            case 'delete-control-pending':
                await tx.remove(this.toControlPendingKey(mutation.msgId));
                return;
            case 'set-buffered':
                await tx.set(
                    this.toBufferedKey(mutation.snapshot.trackKey, mutation.snapshot.seq),
                    mutation.snapshot,
                    resolveExpireAtTimestampWithFallback(
                        resolveALMessageExpireAtMs(
                            mutation.snapshot.msg,
                            mutation.snapshot.plan.effective,
                        ),
                        this.retention.bufferedMessageTtlMs,
                    ),
                );
                return;
            case 'delete-buffered':
                await tx.remove(this.toBufferedKey(mutation.trackKey, mutation.seq));
                return;
        }
    }

    private async persistEffect(
        tx: ALInboundAdmissionWriteContext,
        effect: ALInboundDurableEffectWrite,
    ): Promise<void> {
        const key = this.toEffectKey(effect.effectId);
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveEffectExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= Date.now()) {
            return;
        }

        const existing = toPersistedInboundEffect(
            await tx.get<ALPersistedInboundEffect | StoredALPersistedInboundEffect>(key),
        );
        if (existing) {
            return;
        }

        await tx.set(
            key,
            toStoredPersistedInboundEffect({
                effectId: effect.effectId,
                payload: effect.payload,
                status: 'pending',
                attempts: 0,
                retryAtMs: Date.now(),
                updatedAtMs: Date.now(),
                expireAtTimestamp,
            } satisfies ALPersistedInboundEffect),
            expireAtTimestamp,
        );
    }

    private resolveEffectExpireAtTimestamp(
        effect: ALInboundDurableEffect,
    ): number {
        switch (effect.kind) {
            case 'dispatch-local':
            case 'enqueue-inbox':
            case 'forward-message':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg, effect.plan.effective),
                    this.retention.durableEffectTtlMs,
                );
            case 'send-control':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg),
                    this.retention.durableEffectTtlMs,
                );
            case 'release-buffered':
                return toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs);
        }
    }

    private isEffectReady(
        effect: ALPersistedInboundEffect,
        nowMs: number,
    ): boolean {
        if (effect.status === 'pending') {
            return effect.retryAtMs <= nowMs;
        }

        return effect.leaseUntilMs !== undefined && effect.leaseUntilMs <= nowMs;
    }

    private toAckEffectWrite(
        senderId: string,
        toPeerId: string,
        ackedMsgId: string,
        status: ALAckStatus,
        expireAtTimestamp?: number,
    ): ALInboundDurableEffectWrite {
        return {
            effectId: this.toEffectId('ack', ackedMsgId, toPeerId, status),
            expireAtTimestamp,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage(
                    senderId,
                    toPeerId,
                    ackedMsgId,
                    status,
                ),
            },
        };
    }

    private async bumpVersion(
        tx: ALInboundAdmissionWriteContext,
        senderId: string,
        currentVersion?: number,
    ): Promise<void> {
        const version = currentVersion ?? (await tx.get<ALVersionedClientRecord>(this.toVersionKey(senderId)))?.version;
        await tx.set(
            this.toVersionKey(senderId),
            {
                senderId,
                version: (version ?? 0) + 1,
            } satisfies ALVersionedClientRecord,
            toExpireAtTimestampFromNow(this.retention.versionTtlMs),
        );
    }

    private toVersionKey(senderId: string): string {
        return `${this.namespace}:version:${senderId}`;
    }

    private toMsgOwnerKey(msgId: string): string {
        return `${this.namespace}:msg-owner:${msgId}`;
    }

    private toDedupKey(dedupKey: string): string {
        return `${this.namespace}:dedup:${dedupKey}`;
    }

    private toOrderingKey(trackKey: string): string {
        return `${this.namespace}:ordering:${trackKey}`;
    }

    private toSupersedenceLatestKey(key: string): string {
        return `${this.namespace}:supersedence:latest:${key}`;
    }

    private toSupersedenceReplacementKey(msgId: string): string {
        return `${this.namespace}:supersedence:replacement:${msgId}`;
    }

    private toControlAcksKey(msgId: string): string {
        return `${this.namespace}:control:acks:${msgId}`;
    }

    private toControlNacksKey(msgId: string): string {
        return `${this.namespace}:control:nacks:${msgId}`;
    }

    private toControlRepairsKey(msgId: string): string {
        return `${this.namespace}:control:repairs:${msgId}`;
    }

    private toControlPendingKey(msgId: string): string {
        return `${this.namespace}:control:pending:${msgId}`;
    }

    private toBufferedKey(trackKey: string, seq: number): string {
        return `${this.namespace}:buffered:${trackKey}:${seq}`;
    }

    private toBufferedTrackPrefix(trackKey: string): string {
        return `${this.namespace}:buffered:${trackKey}:`;
    }

    private toEffectKey(effectId: string): string {
        return `${this.namespace}:effect:${effectId}`;
    }

    private toEffectPrefix(): string {
        return `${this.namespace}:effect:`;
    }

    private toEffectClaimKey(): string {
        return `${this.namespace}:effects:claim-lock`;
    }

    private toEffectId(
        ...parts: readonly (number | string)[]
    ): string {
        return parts.map(part => encodeURIComponent(String(part))).join(':');
    }
}

class InMemoryAdmissionBackend implements ALInboundAdmissionBackend {
    constructor(
        private readonly state: ALInboundAdmissionMemoryState,
    ) {
    }

    async ready(): Promise<void> {
    }

    async get<V>(key: string): Promise<V | undefined> {
        const stored = this.state.data.get(key);
        if (!stored) {
            return undefined;
        }

        if (isExpired(stored.expireAtTimestamp)) {
            this.state.data.delete(key);
            return undefined;
        }

        return stored.value as V;
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]> {
        const entries: Array<Readonly<{ key: string; value: V; }>> = [];

        for (const [key, stored] of this.state.data.entries()) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            if (isExpired(stored.expireAtTimestamp)) {
                this.state.data.delete(key);
                continue;
            }

            entries.push({
                key,
                value: stored.value as V,
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALInboundAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = this.state.writeTail;
        let release: (() => void) | undefined;
        this.state.writeTail = new Promise<void>(resolve => {
            release = resolve;
        });

        await previous;

        try {
            return await fn({
                get: async key => await this.get(key),
                list: async prefix => await this.list(prefix),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    this.state.data.set(
                        key,
                        {
                            key,
                            value,
                            expireAtTimestamp,
                        },
                    );
                },
                remove: async key => {
                    this.state.data.delete(key);
                },
            });
        } finally {
            release?.();
        }
    }
}

class IndexedDbAdmissionBackend implements ALInboundAdmissionBackend {
    private dbPromise?: Promise<IDBDatabase>;

    constructor(
        private readonly dbName: string,
        private readonly storeName: string,
    ) {
    }

    async ready(): Promise<void> {
        await this.openDb();
    }

    async get<V>(key: string): Promise<V | undefined> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const stored = await requestToPromise<StoredValue | undefined>(store.get(key));
        if (!stored) {
            await transactionDone(tx);
            return undefined;
        }

        if (isExpired(stored.expireAtTimestamp)) {
            store.delete(key);
            await transactionDone(tx);
            return undefined;
        }

        await transactionDone(tx);
        return stored.value as V;
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const values: Array<Readonly<{ key: string; value: V; }>> = [];

        await cursorEach(store, async cursor => {
            const stored = cursor.value as StoredValue;
            if (!stored.key.startsWith(prefix)) {
                return;
            }

            if (isExpired(stored.expireAtTimestamp)) {
                cursor.delete();
                return;
            }

            values.push({
                key: stored.key,
                value: stored.value as V,
            });
        });

        await transactionDone(tx);
        return values;
    }

    async write<T>(fn: (tx: ALInboundAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.openDb();
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);

        const result = await fn({
            get: async <V>(key: string): Promise<V | undefined> => {
                const stored = await requestToPromise<StoredValue | undefined>(store.get(key));
                if (!stored) {
                    return undefined;
                }

                if (isExpired(stored.expireAtTimestamp)) {
                    store.delete(key);
                    return undefined;
                }

                return stored.value as V;
            },
            list: async <V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]> => {
                const values: Array<Readonly<{ key: string; value: V; }>> = [];
                await cursorEach(store, async cursor => {
                    const stored = cursor.value as StoredValue;
                    if (!stored.key.startsWith(prefix)) {
                        return;
                    }

                    if (isExpired(stored.expireAtTimestamp)) {
                        cursor.delete();
                        return;
                    }

                    values.push({
                        key: stored.key,
                        value: stored.value as V,
                    });
                });
                return values;
            },
            set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                await requestToPromise(
                    store.put({
                        key,
                        value,
                        expireAtTimestamp,
                    } satisfies StoredValue),
                );
            },
            remove: async key => {
                await requestToPromise(store.delete(key));
            },
        });

        await transactionDone(tx);
        return result;
    }

    private async openDb(): Promise<IDBDatabase> {
        if (!this.dbPromise) {
            this.dbPromise = openIndexedDbWithStore(
                this.dbName,
                {
                    name: this.storeName,
                    keyPath: 'key',
                },
            ).then(db => {
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = undefined;
                };
                return db;
            });
        }

        return await this.dbPromise;
    }
}

class PersistenceProviderAdmissionBackend implements ALInboundAdmissionBackend {
    constructor(
        private readonly provider: PersistenceProvider<string, unknown>,
        private readonly coordinationKey: string,
    ) {
    }

    async ready(): Promise<void> {
    }

    async get<V>(key: string): Promise<V | undefined> {
        return await this.provider.getItem(key) as V | undefined;
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]> {
        const entries: Array<Readonly<{ key: string; value: V; }>> = [];

        for (const key of await this.provider.getAllKeys()) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const value = await this.provider.getItem(key);
            if (value === undefined) {
                continue;
            }

            entries.push({
                key,
                value: value as V,
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALInboundAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = providerWriteTailByCoordinationKey.get(this.coordinationKey) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        providerWriteTailByCoordinationKey.set(this.coordinationKey, tail);

        await previous;

        try {
            return await fn({
                get: async key => await this.get(key),
                list: async prefix => await this.list(prefix),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    await this.provider.setItem(
                        key,
                        value,
                        {
                            expireAtTimestamp,
                        },
                    );
                },
                remove: async key => {
                    await this.provider.removeItem(key);
                },
            });
        } finally {
            release?.();
            if (providerWriteTailByCoordinationKey.get(this.coordinationKey) === tail) {
                providerWriteTailByCoordinationKey.delete(this.coordinationKey);
            }
        }
    }
}

export function peekOrderingObservation(
    snapshot: ALOrderingTrackSnapshot | undefined,
    msg: ALMessage,
    nowMs: number,
    trackTtlMs: number,
): ALOrderingObservation {
    return observeOrdering(snapshot, msg, nowMs, trackTtlMs, false).observation;
}

export function acceptOrderingObservation(
    snapshot: ALOrderingTrackSnapshot | undefined,
    msg: ALMessage,
    nowMs: number,
    trackTtlMs: number,
): Readonly<{
    observation: ALOrderingObservation;
    nextSnapshot?: ALOrderingTrackSnapshot;
}> {
    return observeOrdering(snapshot, msg, nowMs, trackTtlMs, true);
}

export function peekSupersedenceObservation(
    input: ALSupersedenceInput,
    latest: LatestSupersedenceValue | undefined,
    replacement: ReplacementSupersedenceValue | undefined,
    nowMs: number,
    trackTtlMs: number,
): ALSupersedenceObservation {
    if (!input.key) {
        return {
            status: 'untracked',
        };
    }

    const activeLatest = normalizeLatestSupersedence(latest, nowMs, trackTtlMs);
    const activeReplacement = normalizeReplacementSupersedence(replacement, nowMs, trackTtlMs);
    if (activeReplacement) {
        return {
            status: 'superseded',
            key: input.key,
            latestMsgId: activeReplacement.byMsgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    if (!activeLatest) {
        return {
            status: 'current',
            key: input.key,
            latestMsgId: input.msgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    if (activeLatest.latestMsgId === input.msgId) {
        return {
            status: 'current',
            key: input.key,
            latestMsgId: activeLatest.latestMsgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    if (input.replacesMsgId && activeLatest.latestMsgId === input.replacesMsgId) {
        return {
            status: 'replaces-current',
            key: input.key,
            latestMsgId: activeLatest.latestMsgId,
            replacesMsgId: input.replacesMsgId,
        };
    }

    const comparison = compareSupersedenceVersion(
        input.seq,
        input.ts,
        activeLatest.latestSeq,
        activeLatest.latestTs,
    );

    return comparison >= 0
        ? {
            status: 'replaces-current',
            key: input.key,
            latestMsgId: activeLatest.latestMsgId,
            replacesMsgId: input.replacesMsgId,
        }
        : {
            status: 'superseded',
            key: input.key,
            latestMsgId: activeLatest.latestMsgId,
            replacesMsgId: input.replacesMsgId,
        };
}

export function acceptSupersedenceObservation(
    input: ALSupersedenceInput,
    latest: LatestSupersedenceValue | undefined,
    replacement: ReplacementSupersedenceValue | undefined,
    nowMs: number,
    trackTtlMs: number,
): Readonly<{
    observation: ALSupersedenceObservation;
    latestWrite?: LatestSupersedenceValue;
    replacementWrites: readonly Readonly<{
        msgId: string;
        value: ReplacementSupersedenceValue;
    }>[];
}> {
    const observation = peekSupersedenceObservation(
        input,
        latest,
        replacement,
        nowMs,
        trackTtlMs,
    );
    if (!input.key || observation.status === 'superseded') {
        return {
            observation,
            replacementWrites: [],
        };
    }

    const activeLatest = normalizeLatestSupersedence(latest, nowMs, trackTtlMs);
    const replacementWrites: Array<Readonly<{ msgId: string; value: ReplacementSupersedenceValue; }>> = [];
    const latestWrite: LatestSupersedenceValue = {
        kind: 'latest',
        latestMsgId: input.msgId,
        latestSeq: input.seq,
        latestTs: input.ts,
        updatedAtMs: nowMs,
    };

    if (activeLatest?.latestMsgId && activeLatest.latestMsgId !== input.msgId) {
        replacementWrites.push({
            msgId: activeLatest.latestMsgId,
            value: {
                kind: 'replacement',
                byMsgId: input.msgId,
                updatedAtMs: nowMs,
            },
        });
    }

    if (input.replacesMsgId && input.replacesMsgId !== input.msgId) {
        replacementWrites.push({
            msgId: input.replacesMsgId,
            value: {
                kind: 'replacement',
                byMsgId: input.msgId,
                updatedAtMs: nowMs,
            },
        });
    }

    return {
        observation: {
            status: 'current',
            key: input.key,
            latestMsgId: input.msgId,
            replacesMsgId: input.replacesMsgId,
        },
        latestWrite,
        replacementWrites,
    };
}

export function trackPendingAckSnapshot(
    msgId: string,
    current: ALPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[],
    toPeerId: string,
    expectedFromPeerIds: readonly string[],
    localReady: boolean,
    expireAtTimestamp?: number,
): Readonly<{
    pending?: ALPendingAckSnapshot;
    completed?: ALCompletedPendingAck;
}> {
    const expected = new Set(current?.expectedFromPeerIds ?? []);
    for (const peerId of expectedFromPeerIds) {
        expected.add(peerId);
    }

    const acked = new Set(current?.ackedFromPeerIds ?? []);
    for (const ack of acks) {
        if (expected.size === 0 || expected.has(ack.fromPeerId)) {
            acked.add(ack.fromPeerId);
        }
    }

    const pending: ALPendingAckSnapshot = {
        toPeerId,
        status: 'subtree-complete',
        localReady: (current?.localReady ?? false) || localReady,
        expectedFromPeerIds: [...expected],
        ackedFromPeerIds: [...acked],
        expireAtTimestamp: expireAtTimestamp ?? current?.expireAtTimestamp,
    };

    return finalizePendingAck(msgId, pending);
}

export function markPendingAckLocalReadySnapshot(
    msgId: string,
    current: ALPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[],
): Readonly<{
    pending?: ALPendingAckSnapshot;
    completed?: ALCompletedPendingAck;
}> {
    if (!current) {
        return {};
    }

    return trackPendingAckSnapshot(
        msgId,
        current,
        acks,
        current.toPeerId,
        current.expectedFromPeerIds,
        true,
        current.expireAtTimestamp,
    );
}

function finalizePendingAck(
    msgId: string,
    pending: ALPendingAckSnapshot,
): Readonly<{
    pending?: ALPendingAckSnapshot;
    completed?: ALCompletedPendingAck;
}> {
    if (!pending.localReady) {
        return {
            pending,
        };
    }

    const acked = new Set(pending.ackedFromPeerIds);
    const complete = pending.expectedFromPeerIds.length === 0
        || pending.expectedFromPeerIds.every(peerId => acked.has(peerId));
    if (!complete) {
        return {
            pending,
        };
    }

    return {
        completed: {
            msgId,
            toPeerId: pending.toPeerId,
            status: pending.status,
            expireAtTimestamp: pending.expireAtTimestamp,
        },
    };
}

function acceptAckPayload(
    current: ALPendingAckSnapshot | undefined,
    nextAcks: readonly ALAckPayload[],
    ack: ALAckPayload,
): Readonly<{
    pending?: ALPendingAckSnapshot;
    completed?: ALCompletedPendingAck;
}> {
    if (!current) {
        return {};
    }

    const acked = new Set(current.ackedFromPeerIds);
    if (current.expectedFromPeerIds.length === 0 || current.expectedFromPeerIds.includes(ack.fromPeerId)) {
        acked.add(ack.fromPeerId);
    }

    return trackPendingAckSnapshot(
        ack.ackedMsgId,
        {
            ...current,
            ackedFromPeerIds: [...acked],
        },
        nextAcks,
        current.toPeerId,
        current.expectedFromPeerIds,
        current.localReady,
    );
}

function normalizeOrderingSnapshot(
    snapshot: ALOrderingTrackSnapshot | undefined,
    nowMs: number,
    trackTtlMs: number,
): ALOrderingTrackSnapshot | undefined {
    if (!snapshot) {
        return undefined;
    }

    return snapshot.updatedAtMs + trackTtlMs <= nowMs
        ? undefined
        : snapshot;
}

function observeOrdering(
    snapshot: ALOrderingTrackSnapshot | undefined,
    msg: ALMessage,
    nowMs: number,
    trackTtlMs: number,
    apply: boolean,
): Readonly<{
    observation: ALOrderingObservation;
    nextSnapshot?: ALOrderingTrackSnapshot;
}> {
    const normalized = normalizeOrderingSnapshot(snapshot, nowMs, trackTtlMs);
    const state = normalized
        ? {
            lastContiguousSeq: normalized.lastContiguousSeq,
            bufferedSeqs: new Set<number>(normalized.bufferedSeqs),
            updatedAtMs: normalized.updatedAtMs,
        }
        : undefined;
    const trackKey = toALOrderingTrackKey(msg);
    const seq = msg.ordering?.seq;

    if (trackKey === undefined || seq === undefined) {
        return {
            observation: {
                status: 'untracked',
                missingSeqs: [],
                releasableSeqs: [],
            },
        };
    }

    if (!state) {
        if (seq > 1) {
            const missingSeqs = Array.from({ length: seq - 1 }, (_, index) => index + 1);
            const nextSnapshot = apply
                ? {
                    lastContiguousSeq: 0,
                    bufferedSeqs: [seq],
                    updatedAtMs: nowMs,
                } satisfies ALOrderingTrackSnapshot
                : undefined;
            return {
                observation: {
                    status: 'gap',
                    trackKey,
                    seq,
                    expectedSeq: 1,
                    lastContiguousSeq: 0,
                    missingSeqs,
                    releasableSeqs: [],
                },
                nextSnapshot,
            };
        }

        const nextSnapshot = apply
            ? {
                lastContiguousSeq: seq,
                bufferedSeqs: [],
                updatedAtMs: nowMs,
            } satisfies ALOrderingTrackSnapshot
            : undefined;
        return {
            observation: {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: seq,
                lastContiguousSeq: seq,
                missingSeqs: [],
                releasableSeqs: [],
            },
            nextSnapshot,
        };
    }

    if (seq < state.lastContiguousSeq) {
        return {
            observation: {
                status: 'stale',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            },
        };
    }

    if (seq === state.lastContiguousSeq || state.bufferedSeqs.has(seq)) {
        return {
            observation: {
                status: 'duplicate',
                trackKey,
                seq,
                expectedSeq: state.lastContiguousSeq + 1,
                lastContiguousSeq: state.lastContiguousSeq,
                missingSeqs: [],
                releasableSeqs: [],
            },
        };
    }

    if (seq === state.lastContiguousSeq + 1) {
        const releasableSeqs: number[] = [];
        if (apply) {
            state.lastContiguousSeq = seq;
            while (state.bufferedSeqs.has(state.lastContiguousSeq + 1)) {
                state.lastContiguousSeq += 1;
                state.bufferedSeqs.delete(state.lastContiguousSeq);
                releasableSeqs.push(state.lastContiguousSeq);
            }
            state.updatedAtMs = nowMs;
        } else {
            let candidate = seq;
            while (state.bufferedSeqs.has(candidate + 1)) {
                candidate += 1;
                releasableSeqs.push(candidate);
            }
        }

        return {
            observation: {
                status: 'in-order',
                trackKey,
                seq,
                expectedSeq: (apply ? state.lastContiguousSeq : seq) + 1,
                lastContiguousSeq: apply ? state.lastContiguousSeq : seq,
                missingSeqs: [],
                releasableSeqs,
            },
            nextSnapshot: apply
                ? {
                    lastContiguousSeq: state.lastContiguousSeq,
                    bufferedSeqs: [...state.bufferedSeqs].sort((left, right) => left - right),
                    updatedAtMs: state.updatedAtMs,
                }
                : normalized,
        };
    }

    const expectedSeq = state.lastContiguousSeq + 1;
    const missingSeqs: number[] = [];
    for (let candidate = expectedSeq; candidate < seq; candidate += 1) {
        if (!state.bufferedSeqs.has(candidate)) {
            missingSeqs.push(candidate);
        }
    }

    if (apply) {
        state.bufferedSeqs.add(seq);
        state.updatedAtMs = nowMs;
    }

    return {
        observation: {
            status: 'gap',
            trackKey,
            seq,
            expectedSeq,
            lastContiguousSeq: state.lastContiguousSeq,
            missingSeqs,
            releasableSeqs: [],
        },
        nextSnapshot: apply
            ? {
                lastContiguousSeq: state.lastContiguousSeq,
                bufferedSeqs: [...state.bufferedSeqs].sort((left, right) => left - right),
                updatedAtMs: state.updatedAtMs,
            }
            : normalized,
    };
}

function compareSupersedenceVersion(
    leftSeq: number | undefined,
    leftTs: number,
    rightSeq: number | undefined,
    rightTs: number,
): number {
    if (leftSeq !== undefined || rightSeq !== undefined) {
        return (leftSeq ?? Number.NEGATIVE_INFINITY) - (rightSeq ?? Number.NEGATIVE_INFINITY);
    }

    return leftTs - rightTs;
}

function normalizeLatestSupersedence(
    latest: LatestSupersedenceValue | undefined,
    nowMs: number,
    trackTtlMs: number,
): LatestSupersedenceValue | undefined {
    if (!latest) {
        return undefined;
    }

    return latest.updatedAtMs + trackTtlMs <= nowMs
        ? undefined
        : latest;
}

function normalizeReplacementSupersedence(
    replacement: ReplacementSupersedenceValue | undefined,
    nowMs: number,
    trackTtlMs: number,
): ReplacementSupersedenceValue | undefined {
    if (!replacement) {
        return undefined;
    }

    return replacement.updatedAtMs + trackTtlMs <= nowMs
        ? undefined
        : replacement;
}

function toSupersedenceInput(
    msg: ALMessage,
    plan: ALMessageHandlingPlan,
): ALSupersedenceInput | undefined {
    if (!plan.supersedence.enabled || !plan.supersedence.key) {
        return undefined;
    }

    return {
        key: plan.supersedence.key,
        msgId: msg.id.msgId,
        replacesMsgId: plan.supersedence.replacesMsgId,
        seq: msg.ordering?.seq,
        ts: msg.audit?.createdTs ?? msg.id.ts,
    };
}

function toPendingSnapshot(
    value: ALControlPersistenceValue | undefined,
): ALPendingAckSnapshot | undefined {
    return value?.kind === 'pending'
        ? value.value
        : undefined;
}

function toAcks(
    value: ALControlPersistenceValue | undefined,
): readonly ALAckPayload[] {
    return value?.kind === 'acks'
        ? value.values
        : [];
}

function toNacks(
    value: ALControlPersistenceValue | undefined,
): readonly ALNackPayload[] {
    return value?.kind === 'nacks'
        ? value.values
        : [];
}

function toRepairs(
    value: ALControlPersistenceValue | undefined,
): readonly ALRepairPayload[] {
    return value?.kind === 'repairs'
        ? value.values
        : [];
}

function toLatestSupersedence(
    value: ALSupersedencePersistenceValue | undefined,
): LatestSupersedenceValue | undefined {
    return value?.kind === 'latest'
        ? value
        : undefined;
}

function toReplacementSupersedence(
    value: ALSupersedencePersistenceValue | undefined,
): ReplacementSupersedenceValue | undefined {
    return value?.kind === 'replacement'
        ? value
        : undefined;
}

function toStoredPersistedInboundEffect(
    effect: ALPersistedInboundEffect,
): StoredALPersistedInboundEffect {
    return {
        ...effect,
        payload: toStoredInboundDurableEffect(effect.payload),
    };
}

function toPersistedInboundEffect(
    effect: ALPersistedInboundEffect | StoredALPersistedInboundEffect | undefined,
): ALPersistedInboundEffect | undefined {
    if (!effect) {
        return undefined;
    }

    return {
        ...effect,
        payload: toInboundDurableEffect(effect.payload),
    };
}

function toStoredInboundDurableEffect(
    effect: ALInboundDurableEffect | StoredALInboundDurableEffect,
): StoredALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return {
                ...effect,
                entry: toStoredResourceEntry(effect.entry),
            };
        case 'send-control':
        case 'forward-message':
        case 'release-buffered':
            return effect;
    }
}

function toInboundDurableEffect(
    effect: ALInboundDurableEffect | StoredALInboundDurableEffect,
): ALInboundDurableEffect {
    switch (effect.kind) {
        case 'dispatch-local':
        case 'enqueue-inbox':
            return {
                ...effect,
                entry: toResourceEntry(effect.entry),
            };
        case 'send-control':
        case 'forward-message':
        case 'release-buffered':
            return effect;
    }
}

function toStoredResourceEntry(
    entry: ResourceEntry | StoredResourceEntry,
): StoredResourceEntry {
    if (isStoredResourceEntry(entry)) {
        return entry;
    }

    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: entry.audit.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: entry.audit.createdTs.toString(),
            expiryTs: entry.audit.expiryTs.toString(),
        },
        status: entry.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs?.toString(),
            endTs: entry.dequeueAudit.endTs?.toString(),
            nextTs: entry.dequeueAudit.nextTs?.toString(),
            attempts: entry.dequeueAudit.attempts,
        },
        db: entry.db,
    };
}

function toResourceEntry(
    entry: ResourceEntry | StoredResourceEntry,
): ResourceEntry {
    if (!isStoredResourceEntry(entry)) {
        return entry;
    }

    return {
        key: entry.key,
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: Temporal.PlainTime.from(entry.audit.date),
            createdBy: entry.audit.createdBy,
            createdTs: Temporal.PlainDateTime.from(entry.audit.createdTs),
            expiryTs: Temporal.Instant.from(entry.audit.expiryTs),
        },
        status: entry.status,
        dequeueAudit: {
            startTs: entry.dequeueAudit.startTs
                ? Temporal.Instant.from(entry.dequeueAudit.startTs)
                : undefined,
            endTs: entry.dequeueAudit.endTs
                ? Temporal.Instant.from(entry.dequeueAudit.endTs)
                : undefined,
            nextTs: entry.dequeueAudit.nextTs
                ? Temporal.Instant.from(entry.dequeueAudit.nextTs)
                : undefined,
            attempts: entry.dequeueAudit.attempts,
        },
        db: entry.db,
    };
}

function isStoredResourceEntry(
    entry: ResourceEntry | StoredResourceEntry,
): entry is StoredResourceEntry {
    return typeof entry.audit.date === 'string';
}

function isExpired(expireAtTimestamp: number): boolean {
    return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
}

async function requestToPromise<T>(
    request: IDBRequest<T>,
): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

async function cursorEach(
    store: IDBObjectStore,
    handler: (cursor: IDBCursorWithValue) => Promise<void> | void,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = store.openCursor();
        request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve();
                return;
            }

            Promise.resolve(handler(cursor))
                .then(() => cursor.continue())
                .catch(reject);
        };
    });
}

async function transactionDone(
    tx: IDBTransaction,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
}
