import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALControlAcceptance,
    ALControlPersistenceValue,
    ALNackPayload,
    ALParsedControlMessage,
    ALPendingAckSnapshot,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { newALAckControlMessage, parseALControlMessage } from '../../al-contracts/al-control.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type {
    ALDedupStoreLike,
    ALOrderingObservation,
    ALOrderingTrackSnapshot,
    ALReadyable,
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedencePersistenceValue
} from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { type ALAdmissionBackend, type ALAdmissionWriteContext } from '../al-admission-backend.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import { computeALOrderingObservation, type ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation,
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import {
    toPersistedInboundEffect,
    toStoredPersistedInboundEffect,
    type StoredALPersistedInboundEffect
} from './al-inbound-durable-effect-codec.ts';
import { toALInboundPlannerState, type ALInboundPlannerSnapshot } from './al-inbound-planner-snapshot.ts';
import { acceptALPendingAckPayload } from './transition-al-pending-ack.ts';

type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending'; }>>;
type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks'; }>>;
type NacksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'nacks'; }>>;
type RepairsControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'repairs'; }>>;

export interface ALVersionedClientRecord {
    readonly senderId: string;
    readonly version: number;
}

export type ALInboundPlanner = (
    msg: ALMessage,
    fromPeerId: string,
    runtime: ALInboundPlannerState
) => ALMessageHandlingPlan;

export interface ALInboundPlannerState {
    readonly dedupStore?: ALDedupStoreLike;
    readonly orderingStore?: {
        peek(msg: ALMessage, nowMs?: number): ALOrderingObservation;
    };
    readonly supersedenceStore?: {
        peek(input: ALSupersedenceInput, nowMs?: number): ALSupersedenceObservation;
    };
}

export interface ALInboundSupersedenceReadState {
    readonly key?: string;
    readonly latest?: ALLatestSupersedenceValue;
    readonly replacement?: ALReplacementSupersedenceValue;
}

export interface ALInboundMessageReadDto {
    readonly kind: 'incoming';
    readonly msg: ALMessage;
    readonly fromPeerId: string;
    readonly nowMs: number;
    readonly clientRecord?: ALVersionedClientRecord;
    readonly orderingSnapshot?: ALOrderingTrackSnapshot;
    readonly orderingAcceptance: ALOrderingAcceptance;
    readonly bufferedSnapshots: readonly ALBufferedOrderedMessageSnapshot[];
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceAcceptance?: ALSupersedenceAcceptance;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly plan: ALMessageHandlingPlan;
}

export interface ALInboundBufferedReleaseReadDto {
    readonly kind: 'buffered-release';
    readonly nowMs: number;
    readonly clientRecord?: ALVersionedClientRecord;
    readonly snapshot: ALBufferedOrderedMessageSnapshot;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceAcceptance?: ALSupersedenceAcceptance;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
}

interface ALInboundDeliveryOwner {
    readonly effectId: string;
    readonly inboxKey: ResourceEntry['key'] | undefined;
}

interface ALInboundOrderedDeliverySnapshot extends ALBufferedOrderedMessageSnapshot {
    readonly delivery?: ALInboundDeliveryOwner;
}

export type ALInboundDeliveryPredecessor =
    | { readonly kind: 'effect'; }
    | {
        readonly kind: 'inbox';
        readonly msg: ALMessage;
        readonly key: ResourceEntry['key'];
    };

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
        value: ALLatestSupersedenceValue;
    }>
    | Readonly<{
        kind: 'set-supersedence-replacement';
        msgId: string;
        value: ALReplacementSupersedenceValue;
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

export interface ALInboundWriteRequest {
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly mutations: readonly ALInboundAdmissionMutation[];
}

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

export interface ALInboundDurableEffectWrite {
    readonly effectId: string;
    readonly payload: ALInboundDurableEffect;
    readonly expireAtTimestamp?: number;
}

export interface ALPersistedInboundEffect {
    readonly effectId: string;
    readonly payload: ALInboundDurableEffect;
    readonly status: 'pending' | 'running';
    readonly attempts: number;
    readonly retryAtMs: number;
    readonly leaseOwner?: string;
    readonly leaseUntilMs?: number;
    readonly lastError?: string;
    readonly updatedAtMs: number;
    readonly expireAtTimestamp: number;
}

export interface ALInboundCommitBundle {
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly durableEffects: readonly ALInboundDurableEffectWrite[];
}

export interface CreateALInboundAdmissionStoreInput {
    readonly namespace: string;
    readonly backend: ALAdmissionBackend;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ALInboundAdmissionStore extends ALReadyable {
    readIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planner: ALInboundPlanner
    ): Promise<ALInboundMessageReadDto>;

    readBufferedRelease(
        trackKey: string,
        seq: number
    ): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    readDeliveryPredecessors(trackKey: string, beforeSeq: number): Promise<readonly ALInboundDeliveryPredecessor[]>;

    planStoredEntry(
        msg: ALMessage,
        planner: ALInboundPlanner
    ): Promise<ALMessageHandlingPlan>;

    commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict'>;

    commitBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict'>;

    claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]>;

    completeEffect(
        effectId: string,
        workerId: string
    ): Promise<void>;

    rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void>;

    peekNextEffectReadyAt(
        nowMs?: number
    ): Promise<number | undefined>;

    acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance>;
}

export interface ClaimALInboundEffectsInput {
    readonly workerId: string;
    readonly maxCount: number;
    readonly leaseMs: number;
    readonly nowMs: number;
}

export interface RescheduleALInboundEffectInput {
    readonly effectId: string;
    readonly workerId: string;
    readonly retryAtMs: number;
    readonly lastError: string | undefined;
}

export function createALInboundAdmissionStore(
    input: CreateALInboundAdmissionStoreInput
): ALInboundAdmissionStore {
    return new ProviderBackedALInboundAdmissionStore({
        namespace: input.namespace,
        orderingTrackTtlMs: input.orderingTrackTtlMs,
        supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
        retention: input.retention,
        backend: input.backend
    });
}

namespace ProviderBackedALInboundAdmissionStore {
    export interface PendingAckWrite {
        readonly msgId: string;
        readonly pending: ALPendingAckSnapshot;
        readonly nowMs: number;
    }

    export interface AdmissionRead extends ALInboundPlannerSnapshot {
        readonly clientRecord: ALVersionedClientRecord | undefined;
        readonly pendingAck: ALPendingAckSnapshot | undefined;
        readonly acks: readonly ALAckPayload[];
        readonly buffered: readonly ALBufferedOrderedMessageSnapshot[];
    }

    export interface OrderingRead {
        readonly trackKey: string | undefined;
        readonly snapshot: ALOrderingTrackSnapshot | undefined;
        readonly buffered: readonly ALBufferedOrderedMessageSnapshot[];
    }

    export interface Dependencies {
        readonly namespace: string;
        readonly orderingTrackTtlMs: number;
        readonly supersedenceTrackTtlMs: number;
        readonly retention: NormalizedALRuntimeStoreRetentionConfig;
        readonly backend: ALAdmissionBackend;
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    private readonly namespace: string;
    private readonly orderingTrackTtlMs: number;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionBackend;

    constructor(input: ProviderBackedALInboundAdmissionStore.Dependencies) {
        this.namespace = input.namespace;
        this.orderingTrackTtlMs = input.orderingTrackTtlMs;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planner: ALInboundPlanner
    ): Promise<ALInboundMessageReadDto> {
        const read = await this.readAdmissionState(msg, fromPeerId, planner);
        const plan = planner(msg, fromPeerId, toALInboundPlannerState(read));
        const supersedenceInput = toSupersedenceInput(msg, plan);
        return {
            kind: 'incoming',
            msg,
            fromPeerId,
            nowMs: read.nowMs,
            clientRecord: read.clientRecord,
            pendingAck: read.pendingAck,
            acks: read.acks,
            plan,
            supersedence: read.supersedence,
            orderingSnapshot: normalizeOrderingSnapshot(read.orderingSnapshot, read.nowMs, this.orderingTrackTtlMs),
            orderingAcceptance: computeALOrderingObservation({
                snapshot: read.orderingSnapshot,
                msg,
                nowMs: read.nowMs,
                trackTtlMs: this.orderingTrackTtlMs,
                apply: true
            }),
            bufferedSnapshots: read.buffered,
            supersedenceAcceptance: supersedenceInput
                ? acceptALSupersedenceObservation({
                    supersedence: supersedenceInput,
                    latest: read.supersedence.latest,
                    replacement: read.supersedence.replacement,
                    nowMs: read.nowMs,
                    trackTtlMs: this.supersedenceTrackTtlMs
                })
                : undefined
        };
    }

    private async readAdmissionState(
        msg: ALMessage,
        fromPeerId: string,
        planner: ALInboundPlanner
    ): Promise<ProviderBackedALInboundAdmissionStore.AdmissionRead> {
        const nowMs = Date.now();
        const clientRecord = await this.backend.get<ALVersionedClientRecord>(this.toVersionKey(msg.id.senderId));
        const prePlan = planner(msg, fromPeerId, {
            dedupStore: undefined,
            orderingStore: undefined,
            supersedenceStore: undefined
        });
        const dedupExpiresAt = await this.backend.get<number>(this.toDedupKey(prePlan.dedupKey));
        const ordering = await this.readOrderingState(msg);
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);
        const pendingAck = toPendingSnapshot(
            await this.backend.get<ALControlPersistenceValue>(this.toControlPendingKey(msg.id.msgId))
        );
        const acks = toAcks(await this.backend.get<ALControlPersistenceValue>(this.toControlAcksKey(msg.id.msgId)));
        return {
            msg,
            prePlan,
            nowMs,
            clientRecord,
            pendingAck,
            acks,
            supersedence,
            dedupExpiresAt,
            orderingTrackKey: ordering.trackKey,
            orderingSnapshot: ordering.snapshot,
            orderingTrackTtlMs: this.orderingTrackTtlMs,
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
            admitted: false,
            buffered: ordering.buffered
        };
    }

    private async readOrderingState(msg: ALMessage): Promise<ProviderBackedALInboundAdmissionStore.OrderingRead> {
        const trackKey = toALOrderingTrackKey(msg);
        if (trackKey === undefined) {
            return { trackKey, snapshot: undefined, buffered: [] };
        }
        const snapshot = await this.backend.get<ALOrderingTrackSnapshot>(this.toOrderingKey(trackKey));
        const buffered = await this.backend.list<ALBufferedOrderedMessageSnapshot>(
            this.toBufferedTrackPrefix(trackKey)
        );
        return {
            trackKey,
            snapshot,
            buffered: buffered.map((entry) => entry.value).sort((left, right) => left.seq - right.seq)
        };
    }

    async readBufferedRelease(
        trackKey: string,
        seq: number
    ): Promise<ALInboundBufferedReleaseReadDto | undefined> {
        const snapshot = await this.backend.get<ALBufferedOrderedMessageSnapshot>(
            this.toBufferedKey(trackKey, seq)
        );
        if (!snapshot) {
            return undefined;
        }

        const nowMs = Date.now();
        const clientRecord = await this.backend.get<ALVersionedClientRecord>(
            this.toVersionKey(snapshot.msg.id.senderId)
        );
        const supersedence = await this.readSupersedenceState(
            snapshot.plan.supersedence.key,
            snapshot.msg.id.msgId
        );
        const releasedPlan = {
            ...snapshot.plan,
            localDelivery: {
                ...snapshot.plan.localDelivery,
                enabled: true,
                deferred: false
            }
        } satisfies ALMessageHandlingPlan;
        const supersedenceInput = toSupersedenceInput(snapshot.msg, releasedPlan);
        const pendingAck = toPendingSnapshot(
            await this.backend.get<ALControlPersistenceValue>(this.toControlPendingKey(snapshot.msg.id.msgId))
        );
        const acks = toAcks(
            await this.backend.get<ALControlPersistenceValue>(this.toControlAcksKey(snapshot.msg.id.msgId))
        );

        return {
            kind: 'buffered-release',
            nowMs,
            clientRecord,
            snapshot,
            supersedence,
            supersedenceAcceptance: supersedenceInput
                ? acceptALSupersedenceObservation({
                    supersedence: supersedenceInput,
                    latest: supersedence.latest,
                    replacement: supersedence.replacement,
                    nowMs: nowMs,
                    trackTtlMs: this.supersedenceTrackTtlMs
                })
                : undefined,
            pendingAck,
            acks
        };
    }

    async readDeliveryPredecessors(
        trackKey: string,
        beforeSeq: number
    ): Promise<readonly ALInboundDeliveryPredecessor[]> {
        return await this.backend.write(async (tx) => {
            const predecessors: ALInboundDeliveryPredecessor[] = [];
            const snapshots = await tx.list<ALInboundOrderedDeliverySnapshot>(this.toBufferedTrackPrefix(trackKey));
            for (const { value: snapshot } of snapshots) {
                if (snapshot.seq >= beforeSeq || !snapshot.delivery) {
                    continue;
                }
                const effect = await tx.get<StoredALPersistedInboundEffect>(
                    this.toEffectKey(snapshot.delivery.effectId)
                );
                if (effect && effect.expireAtTimestamp > Date.now()) {
                    predecessors.push({ kind: 'effect' });
                }
                else if (snapshot.delivery.inboxKey) {
                    predecessors.push({ kind: 'inbox', msg: snapshot.msg, key: snapshot.delivery.inboxKey });
                }
            }
            return predecessors;
        });
    }

    async planStoredEntry(
        msg: ALMessage,
        planner: ALInboundPlanner
    ): Promise<ALMessageHandlingPlan> {
        const prePlan = planner(
            msg,
            msg.id.senderId,
            {
                dedupStore: undefined,
                orderingStore: undefined,
                supersedenceStore: undefined
            }
        );
        const nowMs = Date.now();
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);

        return planner(
            msg,
            msg.id.senderId,
            toALInboundPlannerState({
                msg,
                prePlan,
                nowMs,
                supersedence,
                orderingTrackKey: undefined,
                orderingSnapshot: undefined,
                orderingTrackTtlMs: this.orderingTrackTtlMs,
                dedupExpiresAt: undefined,
                supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
                admitted: true
            })
        );
    }

    async commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict'> {
        return await this.commitBundle({
            senderId: request.senderId,
            expectedVersion: request.expectedVersion,
            mutations: request.mutations,
            durableEffects: []
        });
    }

    async commitBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

        try {
            return await this.backend.write(async (tx) => {
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
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return 'conflict';
            }
            throw error;
        }
    }

    async claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]> {
        const { workerId, maxCount, leaseMs, nowMs } = input;
        if (maxCount <= 0) {
            return [];
        }

        return await this.backend.write(async (tx) => {
            const claimed: ALPersistedInboundEffect[] = [];
            const effects = [
                ...await tx.list<StoredALPersistedInboundEffect>(this.toEffectPrefix())
            ]
                .map((entry) => toPersistedInboundEffect(entry.value))
                .filter((effect): effect is ALPersistedInboundEffect => effect !== undefined)
                .sort((left, right) =>
                    left.retryAtMs - right.retryAtMs ||
                    left.effectId.localeCompare(right.effectId)
                );

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
                    updatedAtMs: nowMs
                };
                await tx.set(
                    this.toEffectKey(effect.effectId),
                    toStoredPersistedInboundEffect(nextEffect),
                    effect.expireAtTimestamp
                );
                claimed.push(nextEffect);
            }

            return claimed;
        });
    }

    async completeEffect(
        effectId: string,
        workerId: string
    ): Promise<void> {
        await this.backend.write(async (tx) => {
            const current = toPersistedInboundEffect(
                await tx.get<StoredALPersistedInboundEffect>(this.toEffectKey(effectId))
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.remove(this.toEffectKey(effectId));
        });
    }

    async rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void> {
        const { effectId, workerId, retryAtMs, lastError } = input;
        await this.backend.write(async (tx) => {
            const current = toPersistedInboundEffect(
                await tx.get<StoredALPersistedInboundEffect>(this.toEffectKey(effectId))
            );
            if (!current || current.leaseOwner !== workerId) {
                return;
            }

            await tx.set(
                this.toEffectKey(effectId),
                toStoredPersistedInboundEffect(
                    {
                        ...current,
                        status: 'pending',
                        retryAtMs,
                        leaseOwner: undefined,
                        leaseUntilMs: undefined,
                        lastError,
                        updatedAtMs: Date.now()
                    } satisfies ALPersistedInboundEffect
                ),
                current.expireAtTimestamp
            );
        });
    }

    async peekNextEffectReadyAt(
        nowMs = Date.now()
    ): Promise<number | undefined> {
        let nextAt: number | undefined;

        for (
            const entry of await this.backend.list<StoredALPersistedInboundEffect>(
                this.toEffectPrefix()
            )
        ) {
            const effect = toPersistedInboundEffect(entry.value);
            if (!effect) {
                continue;
            }
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

    async acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance> {
        const parsed = parseALControlMessage(msg);
        if (!parsed) {
            return { handled: false, completedPendingAcks: [] };
        }
        return await this.backend.write(async (tx) => {
            const msgId = parsed.type === 'ack' ? parsed.payload.ackedMsgId : parsed.payload.msgId;
            const ownerSenderId = await tx.get<string>(this.toMsgOwnerKey(msgId));
            const nowMs = Date.now();
            const acceptance = parsed.type === 'ack'
                ? await this.writeAcknowledgement(tx, parsed.payload, nowMs)
                : await this.writeNegativeControlHistory(tx, parsed, nowMs);
            if (ownerSenderId) {
                await this.bumpVersion(tx, ownerSenderId);
            }
            return acceptance;
        });
    }

    private async writeAcknowledgement(
        tx: ALAdmissionWriteContext,
        ack: ALAckPayload,
        nowMs: number
    ): Promise<ALControlAcceptance> {
        const currentAcks = toAcks(await tx.get<ALControlPersistenceValue>(this.toControlAcksKey(ack.ackedMsgId)));
        const current = toPendingSnapshot(
            await tx.get<ALControlPersistenceValue>(this.toControlPendingKey(ack.ackedMsgId))
        );
        const nextAcks = [...currentAcks, ack];
        const acceptance = acceptALPendingAckPayload({ current, nextAcks, ack });
        await tx.set(
            this.toControlAcksKey(ack.ackedMsgId),
            { kind: 'acks', values: nextAcks } satisfies AcksControlValue,
            toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs)
        );
        if (acceptance.pending) {
            await this.writePendingAck(tx, { msgId: ack.ackedMsgId, pending: acceptance.pending, nowMs });
        }
        else {
            await tx.remove(this.toControlPendingKey(ack.ackedMsgId));
        }
        if (acceptance.completed) {
            await this.persistEffect(tx, this.toAckEffectWrite(ack.toPeerId, acceptance.completed));
        }
        return { handled: true, completedPendingAcks: acceptance.completed ? [acceptance.completed] : [] };
    }

    private async writeNegativeControlHistory(
        tx: ALAdmissionWriteContext,
        parsed: Exclude<ALParsedControlMessage, { readonly type: 'ack'; }>,
        nowMs: number
    ): Promise<ALControlAcceptance> {
        const expiresAt = toExpireAtTimestampFromNow(this.retention.controlHistoryTtlMs, nowMs);
        if (parsed.type === 'nack') {
            const key = this.toControlNacksKey(parsed.payload.msgId);
            const current = toNacks(await tx.get<ALControlPersistenceValue>(key));
            await tx.set(
                key,
                { kind: 'nacks', values: [...current, parsed.payload] } satisfies NacksControlValue,
                expiresAt
            );
        }
        else {
            const key = this.toControlRepairsKey(parsed.payload.msgId);
            const current = toRepairs(await tx.get<ALControlPersistenceValue>(key));
            await tx.set(
                key,
                { kind: 'repairs', values: [...current, parsed.payload] } satisfies RepairsControlValue,
                expiresAt
            );
        }
        return { handled: true, completedPendingAcks: [] };
    }

    private async readSupersedenceState(
        key: string | undefined,
        msgId: string
    ): Promise<ALInboundSupersedenceReadState> {
        if (!key) {
            return {};
        }

        const latest = toLatestSupersedence(
            await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceLatestKey(key))
        );
        const replacement = toReplacementSupersedence(
            await this.backend.get<ALSupersedencePersistenceValue>(this.toSupersedenceReplacementKey(msgId))
        );

        return {
            key,
            latest,
            replacement
        };
    }

    private async applyMutation(
        tx: ALAdmissionWriteContext,
        mutation: ALInboundAdmissionMutation
    ): Promise<void> {
        switch (mutation.kind) {
            case 'set-msg-owner':
                return await tx.set(
                    this.toMsgOwnerKey(mutation.msgId),
                    mutation.senderId,
                    toExpireAtTimestampFromNow(this.retention.msgOwnerTtlMs)
                );
            case 'set-dedup':
                return await tx.set(
                    this.toDedupKey(mutation.dedupKey),
                    mutation.expireAtTimestamp,
                    mutation.expireAtTimestamp
                );
            case 'set-ordering':
                return await tx.set(
                    this.toOrderingKey(mutation.trackKey),
                    mutation.snapshot,
                    mutation.snapshot.updatedAtMs + this.orderingTrackTtlMs
                );
            case 'delete-ordering':
                return await tx.remove(this.toOrderingKey(mutation.trackKey));
            case 'set-supersedence-latest':
                return await tx.set(
                    this.toSupersedenceLatestKey(mutation.supersedenceKey),
                    mutation.value,
                    mutation.value.updatedAtMs + this.supersedenceTrackTtlMs
                );
            case 'set-supersedence-replacement':
                return await tx.set(
                    this.toSupersedenceReplacementKey(mutation.msgId),
                    mutation.value,
                    mutation.value.updatedAtMs + this.supersedenceTrackTtlMs
                );
            case 'set-control-pending':
                return await this.writePendingAck(tx, {
                    msgId: mutation.msgId,
                    pending: mutation.value.value,
                    nowMs: Date.now()
                });
            case 'delete-control-pending':
                return await tx.remove(this.toControlPendingKey(mutation.msgId));
            case 'set-buffered':
                return await this.writeBufferedMessage(tx, mutation.snapshot);
            case 'delete-buffered':
                return await tx.remove(this.toBufferedKey(mutation.trackKey, mutation.seq));
        }
    }

    private async writePendingAck(
        tx: ALAdmissionWriteContext,
        input: ProviderBackedALInboundAdmissionStore.PendingAckWrite
    ): Promise<void> {
        await tx.set(
            this.toControlPendingKey(input.msgId),
            { kind: 'pending', value: input.pending } satisfies PendingControlValue,
            resolveExpireAtTimestampWithFallback(
                input.pending.expireAtTimestamp,
                this.retention.controlPendingTtlMs,
                input.nowMs
            )
        );
    }

    private async writeBufferedMessage(
        tx: ALAdmissionWriteContext,
        snapshot: ALBufferedOrderedMessageSnapshot
    ): Promise<void> {
        await tx.set(
            this.toBufferedKey(snapshot.trackKey, snapshot.seq),
            snapshot,
            resolveExpireAtTimestampWithFallback(
                resolveALMessageExpireAtMs(snapshot.msg, snapshot.plan.effective),
                this.retention.bufferedMessageTtlMs
            )
        );
    }

    private async persistEffect(
        tx: ALAdmissionWriteContext,
        effect: ALInboundDurableEffectWrite
    ): Promise<void> {
        const key = this.toEffectKey(effect.effectId);
        const expireAtTimestamp = effect.expireAtTimestamp ?? this.resolveEffectExpireAtTimestamp(effect.payload);
        if (expireAtTimestamp <= Date.now()) {
            return;
        }

        const existing = toPersistedInboundEffect(
            await tx.get<StoredALPersistedInboundEffect>(key)
        );
        if (existing) {
            return;
        }

        await tx.set(
            key,
            toStoredPersistedInboundEffect(
                {
                    effectId: effect.effectId,
                    payload: effect.payload,
                    status: 'pending',
                    attempts: 0,
                    retryAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                    expireAtTimestamp
                } satisfies ALPersistedInboundEffect
            ),
            expireAtTimestamp
        );
        await this.trackEffectDelivery(tx, effect, expireAtTimestamp);
    }

    private async trackEffectDelivery(
        tx: ALAdmissionWriteContext,
        effect: ALInboundDurableEffectWrite,
        expireAtTimestamp: number
    ): Promise<void> {
        const payload = effect.payload;
        if (
            payload.kind !== 'dispatch-local' && payload.kind !== 'enqueue-inbox' && payload.kind !== 'release-buffered'
        ) {
            return;
        }
        const trackKey = payload.kind === 'release-buffered' ? payload.trackKey : toALOrderingTrackKey(payload.msg);
        const seq = payload.kind === 'release-buffered' ? payload.seq : payload.msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return;
        }
        const key = this.toBufferedKey(trackKey, seq);
        const snapshot = await tx.get<ALInboundOrderedDeliverySnapshot>(key);
        if (!snapshot || (payload.kind !== 'release-buffered' && snapshot.msg.id.msgId !== payload.msg.id.msgId)) {
            return;
        }
        // Once admission has scheduled delivery, its real owner sets the fence lifetime.
        // Queue ownership is verified on consumption, including identity, status and expiry.
        const inboxKey = payload.kind === 'enqueue-inbox' ? payload.entry.key : undefined;
        const deliveryExpiry = payload.kind === 'enqueue-inbox'
            ? Math.max(expireAtTimestamp, payload.entry.audit.expiryTs.epochMilliseconds)
            : expireAtTimestamp;
        await tx.set(
            key,
            {
                ...snapshot,
                delivery: { effectId: effect.effectId, inboxKey }
            } satisfies ALInboundOrderedDeliverySnapshot,
            deliveryExpiry
        );
    }

    private resolveEffectExpireAtTimestamp(
        effect: ALInboundDurableEffect
    ): number {
        switch (effect.kind) {
            case 'dispatch-local':
            case 'enqueue-inbox':
            case 'forward-message':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg, effect.plan.effective),
                    this.retention.durableEffectTtlMs
                );
            case 'send-control':
                return resolveExpireAtTimestampWithFallback(
                    resolveALMessageExpireAtMs(effect.msg),
                    this.retention.durableEffectTtlMs
                );
            case 'release-buffered':
                return toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs);
        }
    }

    private isEffectReady(
        effect: ALPersistedInboundEffect,
        nowMs: number
    ): boolean {
        if (effect.status === 'pending') {
            return effect.retryAtMs <= nowMs;
        }

        return effect.leaseUntilMs !== undefined && effect.leaseUntilMs <= nowMs;
    }

    private toAckEffectWrite(
        senderId: string,
        completed: ALCompletedPendingAck
    ): ALInboundDurableEffectWrite {
        return {
            effectId: this.toEffectId('ack', completed.msgId, completed.toPeerId, completed.status),
            expireAtTimestamp: completed.expireAtTimestamp,
            payload: {
                kind: 'send-control',
                msg: newALAckControlMessage(
                    senderId,
                    completed.toPeerId,
                    completed.msgId,
                    completed.status
                )
            }
        };
    }

    private async bumpVersion(
        tx: ALAdmissionWriteContext,
        senderId: string,
        currentVersion?: number
    ): Promise<void> {
        const version = currentVersion ?? (await tx.get<ALVersionedClientRecord>(this.toVersionKey(senderId)))?.version;
        await tx.set(
            this.toVersionKey(senderId),
            {
                senderId,
                version: (version ?? 0) + 1
            } satisfies ALVersionedClientRecord,
            toExpireAtTimestampFromNow(this.retention.versionTtlMs)
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

    private toEffectId(
        ...parts: readonly (number | string)[]
    ): string {
        return parts.map((part) => encodeURIComponent(String(part))).join(':');
    }
}

function normalizeOrderingSnapshot(
    snapshot: ALOrderingTrackSnapshot | undefined,
    nowMs: number,
    trackTtlMs: number
): ALOrderingTrackSnapshot | undefined {
    if (!snapshot) {
        return undefined;
    }

    return snapshot.updatedAtMs + trackTtlMs <= nowMs
        ? undefined
        : snapshot;
}

function toSupersedenceInput(
    msg: ALMessage,
    plan: ALMessageHandlingPlan
): ALSupersedenceInput | undefined {
    if (!plan.supersedence.enabled || !plan.supersedence.key) {
        return undefined;
    }

    return {
        key: plan.supersedence.key,
        msgId: msg.id.msgId,
        replacesMsgId: plan.supersedence.replacesMsgId,
        seq: msg.ordering?.seq,
        ts: msg.audit?.createdTs ?? msg.id.ts
    };
}

function toPendingSnapshot(
    value: ALControlPersistenceValue | undefined
): ALPendingAckSnapshot | undefined {
    return value?.kind === 'pending'
        ? value.value
        : undefined;
}

function toAcks(
    value: ALControlPersistenceValue | undefined
): readonly ALAckPayload[] {
    return value?.kind === 'acks'
        ? value.values
        : [];
}

function toNacks(
    value: ALControlPersistenceValue | undefined
): readonly ALNackPayload[] {
    return value?.kind === 'nacks'
        ? value.values
        : [];
}

function toRepairs(
    value: ALControlPersistenceValue | undefined
): readonly ALRepairPayload[] {
    return value?.kind === 'repairs'
        ? value.values
        : [];
}

function toLatestSupersedence(
    value: ALSupersedencePersistenceValue | undefined
): ALLatestSupersedenceValue | undefined {
    return value?.kind === 'latest'
        ? value
        : undefined;
}

function toReplacementSupersedence(
    value: ALSupersedencePersistenceValue | undefined
): ALReplacementSupersedenceValue | undefined {
    return value?.kind === 'replacement'
        ? value
        : undefined;
}
