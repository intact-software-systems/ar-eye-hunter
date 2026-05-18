import type { ALAckPayload, ALNackPayload, ALRepairPayload, } from '../al-contracts/al-control.ts';
import { parseALControlMessage } from '../al-contracts/al-control.ts';
import type { ALMessage } from '../al-contracts/al-contract.ts';
import type {
    ALReadyable,
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedencePersistenceValue,
} from '../al-contracts/al-runtime.ts';
import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { IndexedDbStringPersistenceProvider } from '../persistence/IndexedDbStringPersistenceProvider.ts';
import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundRepairTrigger,
} from './ALOutboundMessageRuntime.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot,
} from './ALRuntimeStateStores.ts';
import { acceptSupersedenceObservation, } from './ALInboundAdmissionStore.ts';
import { resolveExplicitOutboundMessageExpireAtMs } from './ALMessageExpiry.ts';
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

type LatestSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'latest' }>>;
type ReplacementSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'replacement' }>>;

export type ALOutboundVersionedClientRecord = Readonly<{
    senderId: string;
    version: number;
}>;

export type ALOutboundPlanner<TPrepared> = (
    msg: ALMessage,
) => ALOutboundDispatchPlan<TPrepared>;

export type ALOutboundSupersedenceReadState = Readonly<{
    key?: string;
    latest?: LatestSupersedenceValue;
    replacement?: ReplacementSupersedenceValue;
}>;

export type ALOutboundMessageReadDto<TPrepared> = Readonly<{
    kind: 'outgoing';
    msg: ALMessage;
    nowMs: number;
    clientRecord?: ALOutboundVersionedClientRecord;
    plan: ALOutboundDispatchPlan<TPrepared>;
    sentSnapshot?: ALOutboundSentMessageSnapshot;
    pendingAck?: ALOutboundPendingAckSnapshot;
    repairAttempt?: ALOutboundRepairAttemptSnapshot;
    acks: readonly ALAckPayload[];
    nacks: readonly ALNackPayload[];
    repairs: readonly ALRepairPayload[];
    supersedence: ALOutboundSupersedenceReadState;
    supersedenceAcceptance?: Readonly<{
        observation: ALSupersedenceObservation;
        latestWrite?: LatestSupersedenceValue;
        replacementWrites: readonly Readonly<{
            msgId: string;
            value: ReplacementSupersedenceValue;
        }>[];
    }>;
    priorOutboxKey?: Key;
}>;

export type ALOutboundRepairReadDto<TPrepared> = Readonly<{
    kind: 'repair';
    msgId: string;
    nowMs: number;
    clientRecord?: ALOutboundVersionedClientRecord;
    sentSnapshot?: ALOutboundSentMessageSnapshot;
    pendingAck?: ALOutboundPendingAckSnapshot;
    repairAttempt?: ALOutboundRepairAttemptSnapshot;
    acks: readonly ALAckPayload[];
    nacks: readonly ALNackPayload[];
    plan?: ALOutboundDispatchPlan<TPrepared>;
}>;

export type ALOutboundAdmissionMutation =
    | Readonly<{
    kind: 'set-msg-owner';
    msgId: string;
    senderId: string;
}>
    | Readonly<{
    kind: 'set-sent-message';
    snapshot: ALOutboundSentMessageSnapshot;
    expireAtTimestamp?: number;
}>
    | Readonly<{
    kind: 'delete-sent-message';
    msgId: string;
}>
    | Readonly<{
    kind: 'set-pending-ack';
    snapshot: ALOutboundPendingAckSnapshot;
    expireAtTimestamp?: number;
}>
    | Readonly<{
    kind: 'delete-pending-ack';
    msgId: string;
}>
    | Readonly<{
    kind: 'set-repair-attempt';
    snapshot: ALOutboundRepairAttemptSnapshot;
    expireAtTimestamp?: number;
}>
    | Readonly<{
    kind: 'delete-repair-attempt';
    msgId: string;
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
}>;

export type ALOutboundRepairHint = Readonly<{
    trigger: ALOutboundRepairTrigger;
    requestedByPeerId?: string;
    failedPeerIds: readonly string[];
    orderingTrackKey?: string;
    missingSeqs: readonly number[];
}>;

export type ALOutboundDurableEffect<TPrepared> =
    | Readonly<{
    kind: 'send-prepared';
    msg: ALMessage;
    prepared: TPrepared;
    phase: ALOutboundDispatchPhase;
}>
    | Readonly<{
    kind: 'enqueue-outbox';
    msg: ALMessage;
    entry: ResourceEntry;
    replaceExisting: boolean;
}>
    | Readonly<{
    kind: 'fallback-dispatch';
    msg: ALMessage;
    entry: ResourceEntry;
}>
    | Readonly<{
    kind: 'ack-timeout';
    msgId: string;
}>
    | Readonly<{
    kind: 'repair-hint';
    msgId: string;
    request: ALOutboundRepairHint;
}>
    | Readonly<{
    kind: 'nack-retry';
    msgId: string;
    reason: 'not-yet-in-sync';
}>;

export type ALOutboundDurableEffectWrite<TPrepared> = Readonly<{
    effectId: string;
    payload: ALOutboundDurableEffect<TPrepared>;
    retryAtMs?: number;
    expireAtTimestamp?: number;
}>;

export type ALPersistedOutboundEffect<TPrepared> = Readonly<{
    effectId: string;
    payload: ALOutboundDurableEffect<TPrepared>;
    status: 'pending' | 'running';
    attempts: number;
    retryAtMs: number;
    leaseOwner?: string;
    leaseUntilMs?: number;
    lastError?: string;
    updatedAtMs: number;
    expireAtTimestamp: number;
}>;

export type ALOutboundCommitBundle<TPrepared> = Readonly<{
    senderId: string;
    expectedVersion?: number;
    mutations: readonly ALOutboundAdmissionMutation[];
    durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}>;

export type ALOutboundControlAcceptance = Readonly<{
    handled: boolean;
}>;

export type ALOutboundAdmissionStoreConfig =
    | Readonly<{
    kind: 'memory';
    namespace: string;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
    state: ALOutboundAdmissionMemoryState;
}>
    | Readonly<{
    kind: 'backend';
    namespace: string;
    backend: ALOutboundAdmissionBackend;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>
    | Readonly<{
    kind: 'provider';
    namespace: string;
    provider: PersistenceProvider<string, unknown>;
    coordinationKey?: string;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>
    | Readonly<{
    kind: 'indexeddb';
    namespace: string;
    dbName?: string;
    storeName?: string;
    supersedenceTrackTtlMs: number;
    retention?: ALRuntimeStoreRetentionConfig;
}>;

export interface ALOutboundAdmissionStore extends ALReadyable {
    readOutgoingMessage<TPrepared>(
        msg: ALMessage,
        planner: ALOutboundPlanner<TPrepared>,
    ): Promise<ALOutboundMessageReadDto<TPrepared>>;

    readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>,
    ): Promise<ALOutboundRepairReadDto<TPrepared>>;

    getSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined>;

    getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]>;

    getPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
    ): Promise<'committed' | 'conflict'>;

    acceptControlMessage<TPrepared>(
        msg: ALMessage,
    ): Promise<ALOutboundControlAcceptance>;

    claimReadyEffects<TPrepared>(
        workerId: string,
        maxCount: number,
        leaseMs: number,
        nowMs?: number,
    ): Promise<readonly ALPersistedOutboundEffect<TPrepared>[]>;

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
}

export type ALOutboundAdmissionMemoryState = {
    readonly data: Map<string, StoredValue>;
    writeTail: Promise<void>;
};

export type ALOutboundAdmissionBackend = Readonly<{
    ready(): Promise<void>;
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]>;
    write<T>(fn: (tx: ALOutboundAdmissionWriteContext) => Promise<T>): Promise<T>;
}>;

export type ALOutboundAdmissionWriteContext = Readonly<{
    get<V>(key: string): Promise<V | undefined>;
    list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V; }>[]>;
    lock?(key: string): Promise<void>;
    set<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
    remove(key: string): Promise<void>;
}>;

const providerWriteTailByCoordinationKey = new Map<string, Promise<void>>();

export function createInMemoryALOutboundAdmissionState(): ALOutboundAdmissionMemoryState {
    return {
        data: new Map<string, StoredValue>(),
        writeTail: Promise.resolve(),
    };
}

export function createALOutboundAdmissionStore(
    config: ALOutboundAdmissionStoreConfig,
): ALOutboundAdmissionStore {
    const retention = normalizeALRuntimeStoreRetention(config.retention);
    switch (config.kind) {
        case 'memory':
            return new ProviderBackedALOutboundAdmissionStore(
                config.namespace,
                config.supersedenceTrackTtlMs,
                retention,
                new InMemoryOutboundAdmissionBackend(config.state),
            );
        case 'backend':
            return new ProviderBackedALOutboundAdmissionStore(
                config.namespace,
                config.supersedenceTrackTtlMs,
                retention,
                config.backend,
            );
        case 'provider':
            return new ProviderBackedALOutboundAdmissionStore(
                config.namespace,
                config.supersedenceTrackTtlMs,
                retention,
                new PersistenceProviderOutboundAdmissionBackend(
                    config.provider,
                    config.coordinationKey ?? config.namespace,
                ),
            );
        case 'indexeddb':
            return new ProviderBackedALOutboundAdmissionStore(
                config.namespace,
                config.supersedenceTrackTtlMs,
                retention,
                new IndexedDbOutboundAdmissionBackend(
                    config.dbName ?? IndexedDbStringPersistenceProvider.DEFAULT_DB_NAME,
                    config.storeName ?? IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
                ),
            );
    }
}

class ProviderBackedALOutboundAdmissionStore implements ALOutboundAdmissionStore {
    constructor(
        private readonly namespace: string,
        private readonly supersedenceTrackTtlMs: number,
        private readonly retention: NormalizedALRuntimeStoreRetentionConfig,
        private readonly backend: ALOutboundAdmissionBackend,
    ) {
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readOutgoingMessage<TPrepared>(
        msg: ALMessage,
        planner: ALOutboundPlanner<TPrepared>,
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const nowMs = Date.now();
        const plan = planner(msg);
        const supersedenceInput = toSupersedenceInput(msg, plan);
        const supersedence = await this.readSupersedenceState(supersedenceInput?.key, msg.id.msgId);
        const latestSnapshot = supersedence.latest?.latestMsgId
            ? await this.getSentMessage(supersedence.latest.latestMsgId)
            : undefined;
        const replacedSnapshot = plan.supersedenceTracking?.replacesMsgId
            ? await this.getSentMessage(plan.supersedenceTracking.replacesMsgId)
            : undefined;
        const sentSnapshot = await this.getSentMessage(msg.id.msgId);

        return {
            kind: 'outgoing',
            msg,
            nowMs,
            clientRecord: await this.backend.get<ALOutboundVersionedClientRecord>(this.toVersionKey(msg.id.senderId)),
            plan,
            sentSnapshot,
            pendingAck: await this.getPendingAck(msg.id.msgId),
            repairAttempt: await this.backend.get<ALOutboundRepairAttemptSnapshot>(this.toRepairAttemptKey(msg.id.msgId)),
            acks: await this.readAcks(msg.id.msgId),
            nacks: await this.readNacks(msg.id.msgId),
            repairs: await this.readRepairs(msg.id.msgId),
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
            priorOutboxKey: sentSnapshot?.outboxKey ?? replacedSnapshot?.outboxKey ?? latestSnapshot?.outboxKey,
        };
    }

    async readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>,
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        const sentSnapshot = await this.getSentMessage(msgId);
        const msg = sentSnapshot?.msg;
        return {
            kind: 'repair',
            msgId,
            nowMs: Date.now(),
            clientRecord: msg
                ? await this.backend.get<ALOutboundVersionedClientRecord>(this.toVersionKey(msg.id.senderId))
                : undefined,
            sentSnapshot,
            pendingAck: await this.getPendingAck(msgId),
            repairAttempt: await this.backend.get<ALOutboundRepairAttemptSnapshot>(this.toRepairAttemptKey(msgId)),
            acks: await this.readAcks(msgId),
            nacks: await this.readNacks(msgId),
            plan: msg ? planner(msg) : undefined,
        };
    }

    async getSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.backend.get<ALOutboundSentMessageSnapshot>(this.toSentMessageKey(msgId));
    }

    async getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]> {
        return [...await this.backend.list<ALOutboundSentMessageSnapshot>(this.toSentMessagePrefix())]
            .map(entry => entry.value)
            .sort(
                (left, right) =>
                    (left.msg.audit?.createdTs ?? left.msg.id.ts)
                    - (right.msg.audit?.createdTs ?? right.msg.id.ts),
            );
    }

    async getPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.backend.get<ALOutboundPendingAckSnapshot>(this.toPendingAckKey(msgId));
    }

    async commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
    ): Promise<'committed' | 'conflict'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

        return await this.backend.write(async tx => {
            await tx.lock?.(this.toVersionKey(bundle.senderId));
            const current = await tx.get<ALOutboundVersionedClientRecord>(this.toVersionKey(bundle.senderId));
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
    }

    async acceptControlMessage<TPrepared>(
        msg: ALMessage,
    ): Promise<ALOutboundControlAcceptance> {
        const parsed = parseALControlMessage(msg);
        if (!parsed) {
            return {
                handled: false,
            };
        }

        return await this.backend.write(async tx => {
            const nowMs = Date.now();
            switch (parsed.type) {
                case 'ack': {
                    const payload = parsed.payload;
                    const msgId = payload.ackedMsgId;
                    const nextAcks = appendUniqueAck(
                        toAcks(await tx.get<OutboundControlValue>(this.toControlAcksKey(msgId))),
                        payload,
                    );
                    const currentPending = await tx.get<ALOutboundPendingAckSnapshot>(this.toPendingAckKey(msgId));
                    const nextPending = acceptAckSnapshot(currentPending, nextAcks, payload);

                    await tx.set(
                        this.toControlAcksKey(msgId),
                        {
                            kind: 'acks',
                            values: nextAcks,
                        } satisfies AcksControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );

                    if (nextPending) {
                        await tx.set(this.toPendingAckKey(msgId), nextPending, toPendingAckExpireAtTimestamp(nextPending));
                    } else if (currentPending) {
                        await tx.remove(this.toPendingAckKey(msgId));
                        await tx.remove(this.toRepairAttemptKey(msgId));
                    }

                    await this.bumpOwnerVersionIfPresent(tx, msgId);
                    return {
                        handled: true,
                    };
                }
                case 'nack': {
                    const payload = parsed.payload;
                    const msgId = payload.msgId;
                    const nextNacks = [
                        ...toNacks(await tx.get<OutboundControlValue>(this.toControlNacksKey(msgId))),
                        payload,
                    ];
                    await tx.set(
                        this.toControlNacksKey(msgId),
                        {
                            kind: 'nacks',
                            values: nextNacks,
                        } satisfies NacksControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );

                    if (payload.reason === 'expired' || payload.reason === 'unauthorized' || payload.reason === 'stale') {
                        await tx.remove(this.toPendingAckKey(msgId));
                        await tx.remove(this.toRepairAttemptKey(msgId));
                    } else if (payload.reason === 'gap') {
                        await this.persistEffect(
                            tx,
                            this.toRepairHintEffectWrite<TPrepared>(
                                msgId,
                                {
                                    trigger: 'nack',
                                    requestedByPeerId: payload.fromPeerId,
                                    orderingTrackKey: payload.orderingKey,
                                    missingSeqs: payload.missingSeqs ?? [],
                                    failedPeerIds: [],
                                },
                                payload.observedAtEpochMs,
                            ),
                        );
                    }

                    await this.bumpOwnerVersionIfPresent(tx, msgId);
                    return {
                        handled: true,
                    };
                }
                case 'repair': {
                    const payload = parsed.payload;
                    const msgId = payload.msgId;
                    const nextRepairs = [
                        ...toRepairs(await tx.get<OutboundControlValue>(this.toControlRepairsKey(msgId))),
                        payload,
                    ];
                    await tx.set(
                        this.toControlRepairsKey(msgId),
                        {
                            kind: 'repairs',
                            values: nextRepairs,
                        } satisfies RepairsControlValue,
                        toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs),
                    );
                    await this.persistEffect(
                        tx,
                        this.toRepairHintEffectWrite<TPrepared>(
                            msgId,
                            {
                                trigger: 'repair',
                                requestedByPeerId: payload.fromPeerId,
                                orderingTrackKey: payload.orderingKey,
                                missingSeqs: payload.missingSeqs ?? [],
                                failedPeerIds: [],
                            },
                            payload.observedAtEpochMs,
                        ),
                    );
                    await this.bumpOwnerVersionIfPresent(tx, msgId);
                    return {
                        handled: true,
                    };
                }
            }
        });
    }

    async claimReadyEffects<TPrepared>(
        workerId: string,
        maxCount: number,
        leaseMs: number,
        nowMs = Date.now(),
    ): Promise<readonly ALPersistedOutboundEffect<TPrepared>[]> {
        if (maxCount <= 0) {
            return [];
        }

        return await this.backend.write(async tx => {
            await tx.lock?.(this.toEffectClaimKey());
            const claimed: ALPersistedOutboundEffect<TPrepared>[] = [];
            const effects = [...await tx.list<ALPersistedOutboundEffect<TPrepared>>(this.toEffectPrefix())]
                .map(entry => entry.value)
                .sort((left, right) => left.retryAtMs - right.retryAtMs || left.effectId.localeCompare(right.effectId));

            for (const effect of effects) {
                if (claimed.length >= maxCount) {
                    break;
                }

                if (!this.isEffectReady(effect, nowMs)) {
                    continue;
                }

                const nextEffect: ALPersistedOutboundEffect<TPrepared> = {
                    ...effect,
                    status: 'running',
                    attempts: effect.attempts + 1,
                    leaseOwner: workerId,
                    leaseUntilMs: nowMs + leaseMs,
                    updatedAtMs: nowMs,
                };
                await tx.set(this.toEffectKey(effect.effectId), nextEffect, effect.expireAtTimestamp);
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
            const current = await tx.get<ALPersistedOutboundEffect<unknown>>(this.toEffectKey(effectId));
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
            const current = await tx.get<ALPersistedOutboundEffect<unknown>>(this.toEffectKey(effectId));
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.set(
                this.toEffectKey(effectId),
                {
                    ...current,
                    status: 'pending',
                    retryAtMs,
                    leaseOwner: undefined,
                    leaseUntilMs: undefined,
                    lastError,
                    updatedAtMs: Date.now(),
                } satisfies ALPersistedOutboundEffect<unknown>,
                current.expireAtTimestamp,
            );
        });
    }

    async peekNextEffectReadyAt(
        nowMs = Date.now(),
    ): Promise<number | undefined> {
        let nextAt: number | undefined;
        for (const entry of await this.backend.list<ALPersistedOutboundEffect<unknown>>(this.toEffectPrefix())) {
            const effect = entry.value;
            const candidateAt = effect.status === 'running'
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

    private async readSupersedenceState(
        key: string | undefined,
        msgId: string,
    ): Promise<ALOutboundSupersedenceReadState> {
        if (!key) {
            return {};
        }

        return {
            key,
            latest: toLatestSupersedence(
                await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceLatestKey(key)),
            ),
            replacement: toReplacementSupersedence(
                await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceReplacementKey(msgId)),
            ),
        };
    }

    private async readAcks(msgId: string): Promise<readonly ALAckPayload[]> {
        return toAcks(await this.backend.get<OutboundControlValue>(this.toControlAcksKey(msgId)));
    }

    private async readNacks(msgId: string): Promise<readonly ALNackPayload[]> {
        return toNacks(await this.backend.get<OutboundControlValue>(this.toControlNacksKey(msgId)));
    }

    private async readRepairs(msgId: string): Promise<readonly ALRepairPayload[]> {
        return toRepairs(await this.backend.get<OutboundControlValue>(this.toControlRepairsKey(msgId)));
    }

    private async applyMutation(
        tx: ALOutboundAdmissionWriteContext,
        mutation: ALOutboundAdmissionMutation,
    ): Promise<void> {
        switch (mutation.kind) {
            case 'set-msg-owner':
                await tx.set(
                    this.toMsgOwnerKey(mutation.msgId),
                    mutation.senderId,
                    toExpireAtTimestampFromNow(this.retention.msgOwnerTtlMs),
                );
                return;
            case 'set-sent-message':
                await tx.set(
                    this.toSentMessageKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    resolveExpireAtTimestampWithFallback(
                        mutation.expireAtTimestamp,
                        this.retention.sentMessageTtlMs,
                    ),
                );
                return;
            case 'delete-sent-message':
                await tx.remove(this.toSentMessageKey(mutation.msgId));
                return;
            case 'set-pending-ack':
                await tx.set(
                    this.toPendingAckKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    mutation.expireAtTimestamp ?? toPendingAckExpireAtTimestamp(mutation.snapshot),
                );
                return;
            case 'delete-pending-ack':
                await tx.remove(this.toPendingAckKey(mutation.msgId));
                return;
            case 'set-repair-attempt':
                await tx.set(
                    this.toRepairAttemptKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    resolveExpireAtTimestampWithFallback(
                        mutation.expireAtTimestamp,
                        this.retention.repairAttemptTtlMs,
                    ),
                );
                return;
            case 'delete-repair-attempt':
                await tx.remove(this.toRepairAttemptKey(mutation.msgId));
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
        }
    }

    private async persistEffect<TPrepared>(
        tx: ALOutboundAdmissionWriteContext,
        effect: ALOutboundDurableEffectWrite<TPrepared>,
    ): Promise<void> {
        const key = this.toEffectKey(effect.effectId);
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveEffectExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= Date.now()) {
            return;
        }

        const existing = await tx.get<ALPersistedOutboundEffect<TPrepared>>(key);
        if (existing) {
            return;
        }

        const nowMs = Date.now();
        await tx.set(
            key,
            {
                effectId: effect.effectId,
                payload: effect.payload,
                status: 'pending',
                attempts: 0,
                retryAtMs: effect.retryAtMs ?? nowMs,
                updatedAtMs: nowMs,
                expireAtTimestamp,
            } satisfies ALPersistedOutboundEffect<TPrepared>,
            expireAtTimestamp,
        );
    }

    private resolveEffectExpireAtTimestamp<TPrepared>(
        effect: ALOutboundDurableEffect<TPrepared>,
    ): number {
        switch (effect.kind) {
            case 'send-prepared':
            case 'enqueue-outbox':
            case 'fallback-dispatch':
                return resolveExpireAtTimestampWithFallback(
                    resolveExplicitOutboundMessageExpireAtMs(effect.msg),
                    this.retention.durableEffectTtlMs,
                );
            case 'ack-timeout':
            case 'repair-hint':
            case 'nack-retry':
                return toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs);
        }
    }

    private isEffectReady(
        effect: ALPersistedOutboundEffect<unknown>,
        nowMs: number,
    ): boolean {
        if (effect.status === 'pending') {
            return effect.retryAtMs <= nowMs;
        }

        return effect.leaseUntilMs !== undefined && effect.leaseUntilMs <= nowMs;
    }

    private toRepairHintEffectWrite<TPrepared>(
        msgId: string,
        request: ALOutboundRepairHint,
        observedAtMs: number,
    ): ALOutboundDurableEffectWrite<TPrepared> {
        return {
            effectId: this.toEffectId(
                'repair-hint',
                msgId,
                request.trigger,
                request.requestedByPeerId ?? '-',
                request.orderingTrackKey ?? '-',
                request.missingSeqs.join(','),
                observedAtMs,
            ),
            payload: {
                kind: 'repair-hint',
                msgId,
                request,
            },
        };
    }

    private async bumpOwnerVersionIfPresent(
        tx: ALOutboundAdmissionWriteContext,
        msgId: string,
    ): Promise<void> {
        const ownerSenderId = await tx.get<string>(this.toMsgOwnerKey(msgId));
        if (ownerSenderId) {
            await this.bumpVersion(tx, ownerSenderId);
        }
    }

    private async bumpVersion(
        tx: ALOutboundAdmissionWriteContext,
        senderId: string,
        currentVersion?: number,
    ): Promise<void> {
        await tx.lock?.(this.toVersionKey(senderId));
        const version = currentVersion ?? (await tx.get<ALOutboundVersionedClientRecord>(this.toVersionKey(senderId)))?.version;
        await tx.set(
            this.toVersionKey(senderId),
            {
                senderId,
                version: (version ?? 0) + 1,
            } satisfies ALOutboundVersionedClientRecord,
            toExpireAtTimestampFromNow(this.retention.versionTtlMs),
        );
    }

    private toVersionKey(senderId: string): string {
        return `${this.namespace}:version:${senderId}`;
    }

    private toMsgOwnerKey(msgId: string): string {
        return `${this.namespace}:msg-owner:${msgId}`;
    }

    private toSentMessageKey(msgId: string): string {
        return `${this.toSentMessagePrefix()}${msgId}`;
    }

    private toSentMessagePrefix(): string {
        return `${this.namespace}:sent:`;
    }

    private toPendingAckKey(msgId: string): string {
        return `${this.namespace}:pending-ack:${msgId}`;
    }

    private toRepairAttemptKey(msgId: string): string {
        return `${this.namespace}:repair-attempt:${msgId}`;
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

    private toEffectKey(effectId: string): string {
        return `${this.namespace}:effect:${effectId}`;
    }

    private toEffectPrefix(): string {
        return `${this.namespace}:effect:`;
    }

    private toEffectClaimKey(): string {
        return `${this.namespace}:effects:claim-lock`;
    }

    private toEffectId(...parts: readonly (number | string)[]): string {
        return parts.map(part => encodeURIComponent(String(part))).join(':');
    }
}

class InMemoryOutboundAdmissionBackend implements ALOutboundAdmissionBackend {
    constructor(
        private readonly state: ALOutboundAdmissionMemoryState,
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

    async write<T>(fn: (tx: ALOutboundAdmissionWriteContext) => Promise<T>): Promise<T> {
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
                lock: async () => {
                },
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

class IndexedDbOutboundAdmissionBackend implements ALOutboundAdmissionBackend {
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

    async write<T>(fn: (tx: ALOutboundAdmissionWriteContext) => Promise<T>): Promise<T> {
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
            lock: async () => {
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

class PersistenceProviderOutboundAdmissionBackend implements ALOutboundAdmissionBackend {
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

    async write<T>(fn: (tx: ALOutboundAdmissionWriteContext) => Promise<T>): Promise<T> {
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
                lock: async () => {
                },
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

type AcksControlValue = Readonly<{
    kind: 'acks';
    values: readonly ALAckPayload[];
}>;

type NacksControlValue = Readonly<{
    kind: 'nacks';
    values: readonly ALNackPayload[];
}>;

type RepairsControlValue = Readonly<{
    kind: 'repairs';
    values: readonly ALRepairPayload[];
}>;

type OutboundControlValue = AcksControlValue | NacksControlValue | RepairsControlValue;

function toSupersedenceInput<TPrepared>(
    msg: ALMessage,
    plan: ALOutboundDispatchPlan<TPrepared>,
): ALSupersedenceInput | undefined {
    const tracking = plan.supersedenceTracking;
    if (!tracking?.enabled || !tracking.key) {
        return undefined;
    }

    return {
        key: tracking.key,
        msgId: msg.id.msgId,
        replacesMsgId: tracking.replacesMsgId,
        seq: msg.ordering?.seq,
        ts: msg.audit?.createdTs ?? msg.id.ts,
    };
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

function toAcks(value: OutboundControlValue | undefined): readonly ALAckPayload[] {
    return value?.kind === 'acks' ? value.values : [];
}

function toNacks(value: OutboundControlValue | undefined): readonly ALNackPayload[] {
    return value?.kind === 'nacks' ? value.values : [];
}

function toRepairs(value: OutboundControlValue | undefined): readonly ALRepairPayload[] {
    return value?.kind === 'repairs' ? value.values : [];
}

function appendUniqueAck(
    current: readonly ALAckPayload[],
    next: ALAckPayload,
): readonly ALAckPayload[] {
    if (current.some(ack => ack.fromPeerId === next.fromPeerId && ack.status === next.status)) {
        return current;
    }

    return [...current, next];
}

export function trackOutboundPendingAckSnapshot(
    msgId: string,
    current: ALOutboundPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[],
    tracking: ALOutboundAckTrackingPlan,
    nowMs: number,
): ALOutboundPendingAckSnapshot | undefined {
    const mode = tracking.mode ?? 'merge';
    const expectedPeerIds = mode === 'replace'
        ? new Set<string>()
        : new Set<string>(current?.expectedPeerIds ?? []);
    const ackedPeerIds = mode === 'replace'
        ? new Set<string>()
        : new Set<string>(current?.ackedPeerIds ?? []);

    for (const peerId of tracking.expectedPeerIds) {
        expectedPeerIds.add(peerId);
    }

    for (const ack of acks) {
        if (expectedPeerIds.size === 0 || expectedPeerIds.has(ack.fromPeerId)) {
            ackedPeerIds.add(ack.fromPeerId);
        }
    }

    if (mode === 'replace' && current) {
        for (const peerId of current.ackedPeerIds) {
            if (expectedPeerIds.has(peerId)) {
                ackedPeerIds.add(peerId);
            }
        }
    }

    const next: ALOutboundPendingAckSnapshot = {
        msgId,
        expectedPeerIds: [...expectedPeerIds],
        ackedPeerIds: [...ackedPeerIds],
        timeoutMs: tracking.timeoutMs,
        maxAttempts: tracking.maxAttempts,
        attempts: current?.attempts ?? 0,
        deadlineAtMs: nowMs + tracking.timeoutMs,
    };

    return isAckComplete(next) ? undefined : next;
}

function acceptAckSnapshot(
    current: ALOutboundPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[],
    ack: ALAckPayload,
): ALOutboundPendingAckSnapshot | undefined {
    if (!current) {
        return undefined;
    }

    const ackedPeerIds = new Set(current.ackedPeerIds);
    if (current.expectedPeerIds.length === 0 || current.expectedPeerIds.includes(ack.fromPeerId)) {
        ackedPeerIds.add(ack.fromPeerId);
    }

    for (const storedAck of acks) {
        if (current.expectedPeerIds.length === 0 || current.expectedPeerIds.includes(storedAck.fromPeerId)) {
            ackedPeerIds.add(storedAck.fromPeerId);
        }
    }

    const next: ALOutboundPendingAckSnapshot = {
        ...current,
        ackedPeerIds: [...ackedPeerIds],
    };

    return isAckComplete(next) ? undefined : next;
}

function isAckComplete(pending: ALOutboundPendingAckSnapshot): boolean {
    return pending.expectedPeerIds.length === 0
        || pending.expectedPeerIds.every(peerId => pending.ackedPeerIds.includes(peerId));
}

export function toPendingAckExpireAtTimestamp(snapshot: ALOutboundPendingAckSnapshot): number {
    const remainingTimeoutWindows = Math.max(1, snapshot.maxAttempts - snapshot.attempts + 1);
    return snapshot.deadlineAtMs + snapshot.timeoutMs * remainingTimeoutWindows;
}

export function resolveOutboundMessageExpireAtMs(msg: ALMessage): number {
    return resolveExplicitOutboundMessageExpireAtMs(msg)
        ?? NEVER_EXPIRE_AT_TIMESTAMP;
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
