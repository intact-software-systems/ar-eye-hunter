import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALControlAcceptance,
    ALControlPersistenceValue,
    ALParsedControlMessage,
    ALPendingAckSnapshot
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
    ALSupersedenceObservation
} from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { type ALAdmissionBackend, type ALAdmissionWriteContext } from '../al-admission-backend.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../al-admission-value-validation.ts';
import type { ALBufferedOrderedMessageSnapshot } from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import { computeALOrderingObservation, type ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    acceptALSupersedenceObservation,
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { ALInboundDurableEffectStore } from './al-inbound-durable-effect-store.ts';
import { decodeALInboundBufferedSnapshot, decodeALInboundOrderingSnapshot } from './al-inbound-ordering-validation.ts';
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

interface ALInboundMessageOwner {
    readonly msgId: string;
    readonly senderId: string;
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
        entry: ResourceEntry;
    }>
    | Readonly<{
        kind: 'enqueue-inbox';
        entry: ResourceEntry;
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
        backend: input.backend,
        nowMs: () => Date.now()
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
        readonly nowMs: () => number;
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    private readonly namespace: string;
    private readonly orderingTrackTtlMs: number;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionBackend;
    private readonly effects: ALInboundDurableEffectStore;
    private readonly nowMs: () => number;

    constructor(input: ProviderBackedALInboundAdmissionStore.Dependencies) {
        this.namespace = input.namespace;
        this.orderingTrackTtlMs = input.orderingTrackTtlMs;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
        this.nowMs = input.nowMs;
        this.effects = new ALInboundDurableEffectStore({
            backend: input.backend,
            namespace: input.namespace,
            retention: input.retention,
            nowMs: input.nowMs
        });
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
        const nowMs = this.nowMs();
        const clientRecord = await this.backend.read(
            this.toVersionKey(msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
        );
        const prePlan = planner(msg, fromPeerId, {
            dedupStore: undefined,
            orderingStore: undefined,
            supersedenceStore: undefined
        });
        const dedupExpiresAt = await this.backend.read(this.toDedupKey(prePlan.dedupKey), decodeALAdmissionNumber);
        const ordering = await this.readOrderingState(msg);
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);
        const pendingAck = (await this.backend.read(
            this.toControlPendingKey(msg.id.msgId),
            (value) => decodeALAdmissionControlValue(value, msg.id.msgId, 'pending')
        ))?.value;
        const acks = (await this.backend.read(
            this.toControlAcksKey(msg.id.msgId),
            (value) => decodeALAdmissionControlValue(value, msg.id.msgId, 'acks')
        ))?.values ?? [];
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
        const snapshot = await this.backend.read(this.toOrderingKey(trackKey), decodeALInboundOrderingSnapshot);
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const buffered = await this.backend.list(
            prefix,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
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
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const snapshot = await this.backend.read(
            this.toBufferedKey(trackKey, seq),
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        if (!snapshot) {
            return undefined;
        }

        const nowMs = this.nowMs();
        const clientRecord = await this.backend.read(
            this.toVersionKey(snapshot.msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, snapshot.msg.id.senderId)
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
        const pendingAck = (await this.backend.read(
            this.toControlPendingKey(snapshot.msg.id.msgId),
            (value) => decodeALAdmissionControlValue(value, snapshot.msg.id.msgId, 'pending')
        ))?.value;
        const acks = (await this.backend.read(
            this.toControlAcksKey(snapshot.msg.id.msgId),
            (value) => decodeALAdmissionControlValue(value, snapshot.msg.id.msgId, 'acks')
        ))?.values ?? [];

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
        return await this.effects.readDeliveryPredecessors(trackKey, beforeSeq);
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
        const nowMs = this.nowMs();
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
            return await this.backend.write((transaction) => this.writeCommitBundle(transaction, bundle));
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return 'conflict';
            }
            throw error;
        }
    }

    private async writeCommitBundle(
        transaction: ALAdmissionWriteContext,
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict'> {
        const current = await transaction.read(
            this.toVersionKey(bundle.senderId),
            (value) => decodeALAdmissionClientRecord(value, bundle.senderId)
        );
        const currentVersion = current?.version;
        if (currentVersion !== bundle.expectedVersion) {
            return 'conflict';
        }
        for (const mutation of bundle.mutations) {
            await this.applyMutation(transaction, mutation);
        }
        for (const effect of bundle.durableEffects) {
            await this.effects.persistEffect(transaction, effect);
        }
        await this.bumpVersion(transaction, bundle.senderId, currentVersion);
        return 'committed';
    }

    async claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]> {
        return await this.effects.claimReadyEffects(input);
    }

    async completeEffect(effectId: string, workerId: string): Promise<void> {
        await this.effects.completeEffect(effectId, workerId);
    }

    async rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void> {
        await this.effects.rescheduleEffect(input);
    }

    async peekNextEffectReadyAt(_nowMs?: number): Promise<number | undefined> {
        return await this.effects.readNextEffectReadyAt();
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance> {
        const parsed = parseALControlMessage(msg);
        if (!parsed) {
            return { handled: false, completedPendingAcks: [] };
        }
        return await this.backend.write(async (tx) => {
            const msgId = parsed.type === 'ack' ? parsed.payload.ackedMsgId : parsed.payload.msgId;
            const ownerPrefix = this.toMsgOwnerPrefix(msgId);
            const owners = await tx.list(
                ownerPrefix,
                (value, key) => this.decodeMessageOwner(value, key, ownerPrefix, msgId)
            );
            const nowMs = this.nowMs();
            const acceptance = parsed.type === 'ack'
                ? await this.writeAcknowledgement(tx, parsed.payload, nowMs)
                : await this.writeNegativeControlHistory(tx, parsed, nowMs);
            for (const senderId of new Set(owners.map((owner) => owner.value.senderId))) {
                await this.bumpVersion(tx, senderId);
            }
            return acceptance;
        });
    }

    private async writeAcknowledgement(
        tx: ALAdmissionWriteContext,
        ack: ALAckPayload,
        nowMs: number
    ): Promise<ALControlAcceptance> {
        const currentAcks = (await tx.read(
            this.toControlAcksKey(ack.ackedMsgId),
            (value) => decodeALAdmissionControlValue(value, ack.ackedMsgId, 'acks')
        ))?.values ?? [];
        const current = (await tx.read(
            this.toControlPendingKey(ack.ackedMsgId),
            (value) => decodeALAdmissionControlValue(value, ack.ackedMsgId, 'pending')
        ))?.value;
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
            await this.effects.persistEffect(tx, this.toAckEffectWrite(ack.toPeerId, acceptance.completed));
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
            const current = (await tx.read(key, (value) =>
                decodeALAdmissionControlValue(value, parsed.payload.msgId, 'nacks')))?.values ?? [];
            await tx.set(
                key,
                { kind: 'nacks', values: [...current, parsed.payload] } satisfies NacksControlValue,
                expiresAt
            );
        }
        else {
            const key = this.toControlRepairsKey(parsed.payload.msgId);
            const current = (await tx.read(key, (value) =>
                decodeALAdmissionControlValue(value, parsed.payload.msgId, 'repairs')))?.values ?? [];
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

        const latest = await this.backend.read(
            this.toSupersedenceLatestKey(key),
            (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
        );
        const replacement = await this.backend.read(
            this.toSupersedenceReplacementKey(msgId),
            (value) => decodeALAdmissionSupersedenceValue(value, 'replacement')
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
                    this.toMsgOwnerKey(mutation.msgId, mutation.senderId),
                    { msgId: mutation.msgId, senderId: mutation.senderId } satisfies ALInboundMessageOwner,
                    toExpireAtTimestampFromNow(this.retention.msgOwnerTtlMs, this.nowMs())
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
                    nowMs: this.nowMs()
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
                this.retention.bufferedMessageTtlMs,
                this.nowMs()
            )
        );
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
        const version = currentVersion ??
            (await tx.read(this.toVersionKey(senderId), (value) => decodeALAdmissionClientRecord(value, senderId)))
                ?.version;
        await tx.set(
            this.toVersionKey(senderId),
            {
                senderId,
                version: (version ?? 0) + 1
            } satisfies ALVersionedClientRecord,
            toExpireAtTimestampFromNow(this.retention.versionTtlMs, this.nowMs())
        );
    }

    private toVersionKey(senderId: string): string {
        return `${this.namespace}:version:${senderId}`;
    }

    private toMsgOwnerKey(msgId: string, senderId: string): string {
        return `${this.toMsgOwnerPrefix(msgId)}${encodeURIComponent(senderId)}`;
    }

    private toMsgOwnerPrefix(msgId: string): string {
        return `${this.namespace}:msg-owner:${encodeURIComponent(msgId)}:`;
    }

    private decodeMessageOwner(
        value: unknown,
        key: string,
        prefix: string,
        expectedMsgId: string
    ): ALInboundMessageOwner {
        const owner = decodeALAdmissionRecord(value, ['msgId', 'senderId']);
        const msgId = decodeALAdmissionString(owner.msgId);
        const senderId = decodeALAdmissionString(owner.senderId);
        let slotSenderId: string;
        try {
            slotSenderId = decodeURIComponent(key.slice(prefix.length));
        }
        catch {
            throw new TypeError('Stored inbound message owner key is invalid');
        }
        if (msgId !== expectedMsgId || senderId !== slotSenderId) {
            throw new TypeError('Stored inbound message owner identity does not match its slot');
        }
        return { msgId, senderId };
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
