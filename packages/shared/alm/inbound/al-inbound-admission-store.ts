import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALCompletedPendingAck,
    ALControlAcceptance,
    ALControlPersistenceValue,
    ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
import { decodeALControlMessage, newALAckControlMessage } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import type { ALMessageHandlingPlan, ALMessagePlanningObservations } from '../../al-contracts/al-policy.ts';
import type {
    ALOrderingTrackSnapshot,
    ALReadyable
} from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import {
    PersistenceWriteExpiredError,
    requireLivePersistenceWrite
} from '../../persistence/persistence-write-deadline.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { type ALAdmissionBackend, type ALAdmissionWriteContext } from '../al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionControlValue,
    decodeALAdmissionNumber,
    decodeALAdmissionSupersedenceValue
} from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import type { ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { ALInboundDurableEffectStore } from './al-inbound-durable-effect-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import {
    decodeALInboundBufferedSnapshot,
    decodeALInboundDeliveryProgress,
    decodeALInboundOrderingSnapshot,
    toALStoredInboundBufferedSnapshot,
    type ALInboundOrderedDeliverySnapshot,
    type ALStoredInboundBufferedSnapshot
} from './al-inbound-ordering-validation.ts';
import type { ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import type { ALInboundPlannerSnapshot } from './al-inbound-planner-snapshot.ts';
import {
    decodeALInboundControlOwnerIndex,
    decodeALInboundMessageOwner,
    decodeALStoredInboundMessage,
    toALInboundMessageKey,
    toALInboundMessageOwnerKey,
    type ALInboundMessageReference,
    type ALStoredInboundMessage
} from './al-inbound-source-validation.ts';
import { computeALInboundWorkEntry } from './al-inbound-work-entry.ts';
import { acceptALPendingAckPayload } from './transition-al-pending-ack.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending'; }>>;
type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks'; }>>;

export interface ALInboundMessageOwner {
    readonly msgId: string;
    readonly senderId: string;
    readonly source: ALInboundMessageRuntime.Source;
    readonly supersedenceKey: string | null;
}

export interface ALInboundControlOwnerIndex {
    /**
     * True when the correlation set exceeded its durable 256-entry bound. Overflowed indexes
     * intentionally retain no entries, so controls are rejected without a scan.
     */
    readonly ambiguous: boolean;
    readonly values: readonly Readonly<{
        peerId: string;
        /** Null means this peer could acknowledge same-ID messages from multiple original senders. */
        senderId: string | null;
    }>[];
}

export type ALInboundPlanner = (
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
) => ALMessageHandlingPlan;

export interface ALInboundSupersedenceReadState {
    readonly key?: string;
    readonly latest?: ALLatestSupersedenceValue;
    readonly replacement?: ALReplacementSupersedenceValue;
}

export interface ALInboundDeliveryProgress {
    readonly completedThrough: number;
    readonly expireAtTimestamp: number;
}

export interface ALInboundAdmissionObservations {
    readonly msgId: string;
    readonly senderId: string;
    readonly messageOwner: ALInboundMessageOwner | undefined;
    readonly dedup: Readonly<{ key: string; expiresAtTimestamp: number | undefined; }> | undefined;
    readonly ordering:
        | Readonly<{
            trackKey: string;
            snapshot: ALOrderingTrackSnapshot | undefined;
            buffered: readonly ALInboundOrderedDeliverySnapshot[];
        }>
        | undefined;
    readonly buffered: ALInboundOrderedDeliverySnapshot | undefined;
    readonly deliveryProgress:
        | Readonly<{ trackKey: string; value: ALInboundDeliveryProgress | undefined; }>
        | undefined;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly pendingAck: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
}

export interface ALInboundMessageReadDto {
    readonly namespace: string;
    readonly kind: 'incoming';
    readonly orderingTrackTtlMs: number;
    readonly msg: ALMessage;
    readonly fromPeerId: string;
    readonly source: ALInboundMessageRuntime.Source;
    readonly nowMs: number;
    readonly observations: ALInboundAdmissionObservations;
    readonly orderingSnapshot?: ALOrderingTrackSnapshot;
    readonly orderingAcceptance: ALOrderingAcceptance;
    readonly bufferedSnapshots: readonly ALInboundOrderedDeliverySnapshot[];
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceAcceptance?: ALSupersedenceAcceptance;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly plan: ALMessageHandlingPlan;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ReadALInboundMessageInput {
    readonly msg: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly nowMs: number;
    readonly prePlan: ALMessageHandlingPlan;
}

export interface ALInboundAdmissionRead extends ALInboundPlannerSnapshot {
    readonly namespace: string;
    readonly fromPeerId: string;
    readonly source: ALInboundMessageRuntime.Source;
    readonly observations: ALInboundAdmissionObservations;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ReadALInboundStoredPlanningInput {
    readonly msg: ALMessage;
    readonly nowMs: number;
}

export interface ReadALInboundBufferedReleaseInput {
    readonly trackKey: string;
    readonly seq: number;
    readonly nowMs: number;
}

export interface ALInboundStoredPlanningRead {
    readonly msg: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly nowMs: number;
    readonly supersedenceKey: string | null;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
}

export interface ALInboundBufferedReleaseReadDto {
    readonly namespace: string;
    readonly kind: 'buffered-release';
    readonly orderingTrackTtlMs: number;
    readonly nowMs: number;
    readonly source: ALInboundMessageRuntime.Source;
    readonly observations: ALInboundAdmissionObservations;
    readonly snapshot: ALInboundOrderedDeliverySnapshot;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ALInboundOrderedDeliveryRead {
    readonly completedThrough: number;
    readonly predecessor: ALInboundDeliveryPredecessor | undefined;
}

export type ALInboundDeliveryPredecessor =
    | { readonly kind: 'effect'; }
    | { readonly kind: 'resync-required'; };

export type ALInboundAdmissionMutation =
    | Readonly<{
        kind: 'set-msg-owner';
        value: ALInboundMessageOwner;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-inbound-message';
        value: ALStoredInboundMessage;
        expireAtTimestamp: number;
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
        senderId: string;
        value: PendingControlValue;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'delete-control-pending';
        msgId: string;
        senderId: string;
    }>
    | Readonly<{
        kind: 'set-control-owners';
        msgId: string;
        value: ALInboundControlOwnerIndex;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-buffered';
        snapshot: ALInboundOrderedDeliverySnapshot;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-delivery-progress';
        trackKey: string;
        value: ALInboundDeliveryProgress;
    }>
    | Readonly<{
        kind: 'delete-buffered';
        trackKey: string;
        seq: number;
    }>;

export interface ALInboundWriteRequest {
    readonly senderId: string;
    readonly observations: ALInboundAdmissionObservations;
    readonly mutations: readonly ALInboundAdmissionMutation[];
}

export type ALInboundDurableEffect =
    | ALInboundPendingAdmission
    | Readonly<{
        kind: 'dispatch-local';
        message: ALInboundMessageReference;
    }>
    | Readonly<{
        kind: 'send-control';
        msg: ALMessage;
    }>
    | Readonly<{
        kind: 'forward-message';
        message: ALInboundMessageReference;
        fromPeerId: string;
        plan: ALMessageHandlingPlan;
    }>
    | Readonly<{
        kind: 'release-buffered';
        trackKey: string;
        seq: number;
    }>;

export interface ALInboundDurableEffectWrite {
    readonly entry: ResourceEntry;
    readonly effectId: string;
    readonly payload: ALInboundDurableEffect;
    readonly expireAtTimestamp: number;
}

export interface ALPersistedInboundEffect {
    readonly effectId: string;
    readonly payload: ALInboundDurableEffect;
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly retryAtMs: number;
    readonly leaseUntilMs: number | undefined;
    readonly expireAtTimestamp: number;
}

export interface ALInboundCommitBundle {
    /** Original data-admission eligibility; null identifies later control/finalization bookkeeping. */
    readonly admissionExpiresAtMs: number | null;
    readonly senderId: string;
    readonly observations: ALInboundAdmissionObservations;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly durableEffects: readonly ALInboundDurableEffectWrite[];
}

export interface CreateALInboundAdmissionStoreInput {
    readonly newControlId?: () => string;
    readonly nowMs?: () => number;
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ALInboundAdmissionStore extends ALReadyable {
    readonly namespace: string;
    readonly workQueue: QueueBoxResourceEntryRepository;
    readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead>;

    readBufferedRelease(input: ReadALInboundBufferedReleaseInput): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead>;

    readStoredPlanningState(input: ReadALInboundStoredPlanningInput): Promise<ALInboundStoredPlanningRead>;

    readInboundMessage(reference: ALInboundMessageReference): Promise<ALMessage | undefined>;

    commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict' | 'expired'>;

    commitBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict' | 'expired'>;

    claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]>;

    finalizeExhaustedEffects(input: FinalizeALInboundEffectsInput): Promise<void>;

    completeEffect(reservation: ResourceEntry): Promise<void>;

    rejectEffect(reservation: ResourceEntry): Promise<void>;

    rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void>;

    acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance>;
}

export interface ClaimALInboundEffectsInput {
    readonly entries: readonly ResourceEntry[];
    readonly maxCount: number;
}

export interface FinalizeALInboundEffectsInput {
    readonly maxCount: number;
    readonly signal: AbortSignal;
}

export interface RescheduleALInboundEffectInput {
    readonly reason?: 'not-ready';
    readonly reservation: ResourceEntry;
    readonly retryAtMs: number;
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
        newControlId: input.newControlId ?? crypto.randomUUID.bind(crypto),
        nowMs: input.nowMs ?? Date.now
    });
}

namespace ProviderBackedALInboundAdmissionStore {
    export interface OrderingRead {
        readonly trackKey: string | undefined;
        readonly snapshot: ALOrderingTrackSnapshot | undefined;
        readonly buffered: readonly ALInboundOrderedDeliverySnapshot[];
    }

    export interface Dependencies {
        readonly namespace: string;
        readonly orderingTrackTtlMs: number;
        readonly supersedenceTrackTtlMs: number;
        readonly retention: NormalizedALRuntimeStoreRetentionConfig;
        readonly backend: ALAdmissionWorkBackend;
        readonly nowMs: () => number;
        readonly newControlId: () => string;
    }

    export interface CorrelatedControlRead {
        readonly ack: ALAckPayload;
        readonly senderId: string;
        readonly controlOwners: ALInboundControlOwnerIndex;
        readonly nowMs: number;
        readonly controlMsgId: string;
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    readonly namespace: string;
    readonly workQueue: QueueBoxResourceEntryRepository;
    private readonly orderingTrackTtlMs: number;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly effects: ALInboundDurableEffectStore;
    private readonly nowMs: () => number;
    private readonly newControlId: () => string;

    constructor(input: ProviderBackedALInboundAdmissionStore.Dependencies) {
        this.namespace = input.namespace;
        this.workQueue = input.backend.workQueue;
        this.orderingTrackTtlMs = input.orderingTrackTtlMs;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
        this.nowMs = input.nowMs;
        this.newControlId = input.newControlId;
        this.effects = new ALInboundDurableEffectStore({
            nowMs: this.nowMs,
            backend: input.backend,
            namespace: input.namespace
        });
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead> {
        const { msg, source, nowMs, prePlan } = input;
        const messageOwner = await this.readMessageOwnerRecord(this.backend, msg.id.msgId, msg.id.senderId);
        const dedupExpiresAt = await this.backend.read(this.toDedupKey(prePlan.dedupKey), decodeALAdmissionNumber);
        const ordering = await this.readOrderingState(this.backend, toALOrderingTrackKey(msg));
        const supersedence = await this.readSupersedenceState(this.backend, prePlan.supersedence.key, msg.id.msgId);
        const deliveryProgress = await this.readDeliveryProgress(ordering.trackKey);
        const { pendingAck, acks } = await this.readAcknowledgementState(this.backend, msg.id.msgId, msg.id.senderId);
        const controlOwners = await this.readControlOwnerIndex(msg.id.msgId);
        return {
            namespace: this.namespace,
            msg,
            fromPeerId: source.kind === 'trusted-server' ? msg.id.senderId : source.peerId,
            source,
            prePlan,
            nowMs,
            observations: {
                msgId: msg.id.msgId,
                senderId: msg.id.senderId,
                messageOwner,
                dedup: { key: prePlan.dedupKey, expiresAtTimestamp: dedupExpiresAt },
                ordering: ordering.trackKey === undefined
                    ? undefined
                    : { trackKey: ordering.trackKey, snapshot: ordering.snapshot, buffered: ordering.buffered },
                buffered: undefined,
                deliveryProgress,
                supersedence,
                pendingAck,
                acks,
                controlOwners
            },
            pendingAck,
            acks,
            controlOwners,
            supersedence,
            dedupExpiresAt,
            orderingTrackKey: ordering.trackKey,
            orderingSnapshot: ordering.snapshot,
            orderingTrackTtlMs: this.orderingTrackTtlMs,
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
            retention: this.retention,
            admitted: false,
            bufferedSnapshots: ordering.buffered
        };
    }

    private async readOrderingState(
        database: Pick<ALAdmissionBackend, 'read' | 'list'>,
        trackKey: string | undefined
    ): Promise<ProviderBackedALInboundAdmissionStore.OrderingRead> {
        if (trackKey === undefined) {
            return { trackKey, snapshot: undefined, buffered: [] };
        }
        const snapshot = await database.read(this.toOrderingKey(trackKey), decodeALInboundOrderingSnapshot);
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const stored = await database.list(
            prefix,
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        const buffered: ALInboundOrderedDeliverySnapshot[] = [];
        for (const entry of stored) {
            buffered.push(await this.readBufferedMessage(database, entry.value));
        }
        return { trackKey, snapshot, buffered: buffered.sort((left, right) => left.seq - right.seq) };
    }

    /** The buffered slot only names its message, so ordering decisions resolve the owner row first. */
    private async readBufferedMessage(
        database: Pick<ALAdmissionBackend, 'read'>,
        stored: ALStoredInboundBufferedSnapshot
    ): Promise<ALInboundOrderedDeliverySnapshot> {
        const owner = await this.readStoredMessage(database, stored.message);
        if (
            owner === undefined || toALOrderingTrackKey(owner.msg) !== stored.trackKey ||
            owner.msg.ordering?.seq !== stored.seq
        ) {
            throw new ALAdmissionCorruptionError(
                toALInboundMessageKey(this.namespace, stored.message),
                new TypeError('Buffered inbound ordering slot lost its canonical message')
            );
        }
        return {
            trackKey: stored.trackKey,
            seq: stored.seq,
            msg: owner.msg,
            plan: stored.plan,
            ...(stored.delivery === undefined ? {} : { delivery: stored.delivery })
        };
    }

    async readBufferedRelease(
        input: ReadALInboundBufferedReleaseInput
    ): Promise<ALInboundBufferedReleaseReadDto | undefined> {
        const { trackKey, seq, nowMs } = input;
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const stored = await this.backend.read(
            this.toBufferedKey(trackKey, seq),
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        if (!stored) {
            return undefined;
        }
        const snapshot = await this.readBufferedMessage(this.backend, stored);

        const messageOwner = await this.readMessageOwner(snapshot.msg);
        const deliveryProgress = await this.readDeliveryProgress(trackKey);
        const source = messageOwner.source;
        const supersedence = await this.readSupersedenceState(
            this.backend,
            snapshot.plan.supersedence.key,
            snapshot.msg.id.msgId
        );
        const { pendingAck, acks } = await this.readAcknowledgementState(
            this.backend,
            snapshot.msg.id.msgId,
            snapshot.msg.id.senderId
        );
        const controlOwners = await this.readControlOwnerIndex(snapshot.msg.id.msgId);
        return {
            kind: 'buffered-release',
            orderingTrackTtlMs: this.orderingTrackTtlMs,
            namespace: this.namespace,
            nowMs,
            source,
            observations: {
                msgId: snapshot.msg.id.msgId,
                senderId: snapshot.msg.id.senderId,
                messageOwner,
                dedup: undefined,
                ordering: undefined,
                buffered: snapshot,
                deliveryProgress,
                supersedence,
                pendingAck,
                acks,
                controlOwners
            },
            snapshot,
            supersedence,
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
            pendingAck,
            acks,
            controlOwners,
            retention: this.retention
        };
    }

    async readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead> {
        return await this.effects.readOrderedDelivery(trackKey, beforeSeq);
    }

    private async readDeliveryProgress(trackKey: string | undefined) {
        if (trackKey === undefined) {
            return undefined;
        }
        return {
            trackKey,
            value: await this.backend.read(
                `${this.namespace}:delivered:${trackKey}`,
                decodeALInboundDeliveryProgress
            )
        };
    }

    async readStoredPlanningState(input: ReadALInboundStoredPlanningInput): Promise<ALInboundStoredPlanningRead> {
        const owner = await this.readMessageOwner(input.msg);
        return {
            msg: input.msg,
            source: owner.source,
            nowMs: input.nowMs,
            supersedenceKey: owner.supersedenceKey,
            supersedence: await this.readSupersedenceState(
                this.backend,
                owner.supersedenceKey ?? undefined,
                input.msg.id.msgId
            ),
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs
        };
    }

    async commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict' | 'expired'> {
        return await this.commitBundle({
            admissionExpiresAtMs: null,
            senderId: request.senderId,
            observations: request.observations,
            mutations: request.mutations,
            durableEffects: []
        });
    }

    async commitBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict' | 'expired'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }
        const validated = validateALInboundCommitBundle(bundle, this.namespace);
        if (validated.left) {
            throw new TypeError(validated.left.message);
        }

        try {
            return await this.backend.write(
                (transaction) => this.writeCommitBundle(transaction, validated.right!),
                bundle.admissionExpiresAtMs
            );
        }
        catch (error) {
            if (error instanceof PersistenceWriteExpiredError) {
                return 'expired';
            }
            if (error instanceof ALAdmissionBackendConflictError) {
                return 'conflict';
            }
            throw error;
        }
    }

    private async writeCommitBundle(
        transaction: ALAdmissionWorkWriteContext,
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict'> {
        await this.requireOriginalObservations(transaction, bundle.observations);
        requireLivePersistenceWrite(bundle.admissionExpiresAtMs, this.nowMs());
        for (const mutation of bundle.mutations) {
            await this.applyMutation(transaction, mutation);
        }
        for (const effect of bundle.durableEffects) {
            await this.effects.persistEffect(transaction, effect);
        }
        requireLivePersistenceWrite(bundle.admissionExpiresAtMs, this.nowMs());
        return 'committed';
    }

    private async requireOriginalObservations(
        transaction: ALAdmissionWriteContext,
        observed: ALInboundAdmissionObservations
    ): Promise<void> {
        const messageOwner = await this.readMessageOwnerRecord(transaction, observed.msgId, observed.senderId);
        const { pendingAck, acks } = await this.readAcknowledgementState(
            transaction,
            observed.msgId,
            observed.senderId
        );
        const controlOwners = await transaction.read(
            this.toControlOwnerIndexKey(observed.msgId),
            decodeALInboundControlOwnerIndex
        );
        const supersedence = await this.readSupersedenceState(transaction, observed.supersedence.key, observed.msgId);
        const dedup = observed.dedup === undefined ? undefined : {
            key: observed.dedup.key,
            expiresAtTimestamp: await transaction.read(this.toDedupKey(observed.dedup.key), decodeALAdmissionNumber)
        };
        const ordering = observed.ordering === undefined
            ? undefined
            : await this.readOrderingState(transaction, observed.ordering.trackKey);
        const deliveryProgress = observed.deliveryProgress === undefined ? undefined : {
            trackKey: observed.deliveryProgress.trackKey,
            value: await transaction.read(
                `${this.namespace}:delivered:${observed.deliveryProgress.trackKey}`,
                decodeALInboundDeliveryProgress
            )
        };
        const observedBuffered = observed.buffered;
        const storedBuffered = observedBuffered === undefined ? undefined : await transaction.read(
            this.toBufferedKey(observedBuffered.trackKey, observedBuffered.seq),
            (value, key) =>
                decodeALInboundBufferedSnapshot(value, {
                    trackKey: observedBuffered.trackKey,
                    prefix: this.toBufferedTrackPrefix(observedBuffered.trackKey),
                    key
                })
        );
        const buffered = storedBuffered === undefined
            ? undefined
            : await this.readBufferedMessage(transaction, storedBuffered);
        if (
            !jsonEquals(observed, {
                ...observed,
                messageOwner,
                pendingAck,
                acks,
                controlOwners,
                supersedence,
                dedup,
                ordering,
                buffered,
                deliveryProgress
            })
        ) {
            throw new ALAdmissionBackendConflictError('Inbound admission observations changed');
        }
    }

    async claimReadyEffects(input: ClaimALInboundEffectsInput): Promise<readonly ALPersistedInboundEffect[]> {
        return await this.effects.claimReadyEffects(input);
    }

    async finalizeExhaustedEffects(input: FinalizeALInboundEffectsInput): Promise<void> {
        await this.effects.finalizeExhaustedEffects(input);
    }

    async completeEffect(reservation: ResourceEntry): Promise<void> {
        await this.effects.completeEffect(reservation);
    }

    async rejectEffect(reservation: ResourceEntry): Promise<void> {
        await this.effects.rejectEffect(reservation);
    }

    async rescheduleEffect(input: RescheduleALInboundEffectInput): Promise<void> {
        await this.effects.rescheduleEffect(input);
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALControlAcceptance> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left) {
            return { handled: false, completedPendingAcks: [] };
        }
        const parsed = decoded.right!;
        if (parsed.type !== 'ack') {
            return { handled: false, completedPendingAcks: [] };
        }
        const nowMs = this.nowMs();
        const read = await this.readControlAdmission(parsed.payload, nowMs, this.newControlId());
        if (!read) {
            return { handled: false, completedPendingAcks: [] };
        }
        const validated = validateALInboundControlAdmission(
            computeALInboundControlAdmission(read, this.retention)
        );
        if (validated.left) {
            return { handled: false, completedPendingAcks: [] };
        }
        await this.backend.write((transaction) => this.writeControlAdmission(transaction, validated.right!));
        return validated.right!.acceptance;
    }

    private async readControlAdmission(
        ack: ALAckPayload,
        nowMs: number,
        controlMsgId: string
    ): Promise<ALInboundControlAdmissionRead | undefined> {
        const controlOwners = await this.readControlOwnerIndex(ack.ackedMsgId);
        const senderId = controlOwners?.values.find((value) => value.peerId === ack.fromPeerId)?.senderId;
        if (controlOwners?.ambiguous || senderId === null) {
            return undefined;
        }
        if (senderId === undefined || controlOwners === undefined) {
            return undefined;
        }
        return await this.readCorrelatedControlAdmission({
            ack,
            senderId,
            controlOwners,
            nowMs,
            controlMsgId
        });
    }

    private async readCorrelatedControlAdmission(
        input: ProviderBackedALInboundAdmissionStore.CorrelatedControlRead
    ): Promise<ALInboundControlAdmissionRead> {
        const { ack, senderId, controlOwners, nowMs, controlMsgId } = input;
        const ownerKey = toALInboundMessageOwnerKey(this.namespace, ack.ackedMsgId, senderId);
        const owner = await this.backend.read(
            ownerKey,
            (value, key) =>
                decodeALInboundMessageOwner(value, {
                    key,
                    namespace: this.namespace,
                    expectedMsgId: ack.ackedMsgId,
                    expectedSenderId: senderId
                })
        );
        const pending = (await this.backend.read(
            this.toControlPendingKey(ack.ackedMsgId, senderId),
            (value) => decodeALAdmissionControlValue(value, ack.ackedMsgId, 'pending')
        ))?.value;
        const acks = (await this.backend.read(
            this.toControlAcksKey(ack.ackedMsgId, senderId),
            (value) => decodeALAdmissionControlValue(value, ack.ackedMsgId, 'acks')
        ))?.values ?? [];
        if (!owner) {
            throw new ALAdmissionCorruptionError(
                ownerKey,
                new TypeError('Retained inbound acknowledgement state has no message provenance')
            );
        }
        return { namespace: this.namespace, ack, controlOwners, owner, pending, acks, nowMs, controlMsgId };
    }

    private async writeControlAdmission(
        tx: ALAdmissionWorkWriteContext,
        candidate: ALInboundControlAdmissionCandidate
    ): Promise<void> {
        const currentControlOwners = await tx.read(
            this.toControlOwnerIndexKey(candidate.read.ack.ackedMsgId),
            decodeALInboundControlOwnerIndex
        );
        if (!equalInboundControlOwnerIndex(currentControlOwners, candidate.read.controlOwners)) {
            throw new ALAdmissionBackendConflictError('Inbound acknowledgement ownership changed during admission');
        }
        const currentOwner = await tx.read(
            toALInboundMessageOwnerKey(this.namespace, candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            (value, key) =>
                decodeALInboundMessageOwner(value, {
                    key,
                    namespace: this.namespace,
                    expectedMsgId: candidate.read.ack.ackedMsgId,
                    expectedSenderId: candidate.read.owner.senderId
                })
        );
        const pending = (await tx.read(
            this.toControlPendingKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            (value) => decodeALAdmissionControlValue(value, candidate.read.ack.ackedMsgId, 'pending')
        ))?.value;
        const acks = (await tx.read(
            this.toControlAcksKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            (value) => decodeALAdmissionControlValue(value, candidate.read.ack.ackedMsgId, 'acks')
        ))?.values ?? [];
        if (
            !equalInboundMessageOwner(currentOwner, candidate.read.owner) ||
            !jsonEquals(pending, candidate.read.pending) || !jsonEquals(acks, candidate.read.acks)
        ) {
            throw new ALAdmissionBackendConflictError('Inbound acknowledgement state changed during admission');
        }
        await tx.set(
            this.toControlAcksKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            candidate.acks,
            candidate.controlExpireAtTimestamp
        );
        if (candidate.pending) {
            await tx.set(
                this.toControlPendingKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
                candidate.pending,
                candidate.pendingExpireAtTimestamp
            );
        }
        else {
            await tx.remove(
                this.toControlPendingKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId)
            );
        }
        if (candidate.completedEffect) {
            await this.effects.persistEffect(tx, candidate.completedEffect);
        }
    }

    private async readSupersedenceState(
        database: Pick<ALAdmissionBackend, 'read'>,
        key: string | undefined,
        msgId: string
    ): Promise<ALInboundSupersedenceReadState> {
        if (!key) {
            return {};
        }

        const latest = await database.read(
            this.toSupersedenceLatestKey(key),
            (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
        );
        const replacement = await database.read(
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
                    toALInboundMessageOwnerKey(this.namespace, mutation.value.msgId, mutation.value.senderId),
                    mutation.value,
                    mutation.expireAtTimestamp
                );
            case 'set-inbound-message':
                return await tx.set(
                    toALInboundMessageKey(this.namespace, mutation.value),
                    mutation.value,
                    mutation.expireAtTimestamp
                );
            case 'set-dedup': {
                const dedupKey = this.toDedupKey(mutation.dedupKey);
                return await tx.set(dedupKey, mutation.expireAtTimestamp, mutation.expireAtTimestamp);
            }
            case 'set-ordering':
                return await tx.set(
                    this.toOrderingKey(mutation.trackKey),
                    mutation.snapshot,
                    mutation.snapshot.updatedAtMs + this.orderingTrackTtlMs
                );
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
                return await tx.set(
                    this.toControlPendingKey(mutation.msgId, mutation.senderId),
                    mutation.value,
                    mutation.expireAtTimestamp
                );
            case 'delete-control-pending':
                return await tx.remove(this.toControlPendingKey(mutation.msgId, mutation.senderId));
            case 'set-control-owners': {
                const controlOwnerKey = this.toControlOwnerIndexKey(mutation.msgId);
                return await tx.set(controlOwnerKey, mutation.value, mutation.expireAtTimestamp);
            }
            case 'set-buffered':
                return await tx.set(
                    this.toBufferedKey(mutation.snapshot.trackKey, mutation.snapshot.seq),
                    toALStoredInboundBufferedSnapshot(mutation.snapshot),
                    mutation.expireAtTimestamp
                );
            case 'set-delivery-progress': {
                const progressKey = `${this.namespace}:delivered:${mutation.trackKey}`;
                return await tx.set(progressKey, mutation.value, mutation.value.expireAtTimestamp);
            }
            case 'delete-buffered':
                return await tx.remove(this.toBufferedKey(mutation.trackKey, mutation.seq));
        }
    }

    async readInboundMessage(reference: ALInboundMessageReference): Promise<ALMessage | undefined> {
        return (await this.readStoredMessage(this.backend, reference))?.msg;
    }

    private async readStoredMessage(
        database: Pick<ALAdmissionBackend, 'read'>,
        reference: ALInboundMessageReference
    ): Promise<ALStoredInboundMessage | undefined> {
        return await database.read(
            toALInboundMessageKey(this.namespace, reference),
            (value, key) => decodeALStoredInboundMessage(value, { key, namespace: this.namespace, reference })
        );
    }

    private async readMessageOwner(msg: ALMessage): Promise<ALInboundMessageOwner> {
        const ownerKey = toALInboundMessageOwnerKey(this.namespace, msg.id.msgId, msg.id.senderId);
        const owner = await this.readMessageOwnerRecord(this.backend, msg.id.msgId, msg.id.senderId);
        if (owner === undefined) {
            throw new ALAdmissionCorruptionError(
                ownerKey,
                new TypeError('Admitted AL message has no retained ingress source')
            );
        }
        return owner;
    }

    private async readMessageOwnerRecord(
        database: Pick<ALAdmissionBackend, 'read'>,
        msgId: string,
        senderId: string
    ): Promise<ALInboundMessageOwner | undefined> {
        return await database.read(
            toALInboundMessageOwnerKey(this.namespace, msgId, senderId),
            (value, key) =>
                decodeALInboundMessageOwner(value, {
                    key,
                    namespace: this.namespace,
                    expectedMsgId: msgId,
                    expectedSenderId: senderId
                })
        );
    }

    private async readAcknowledgementState(
        database: Pick<ALAdmissionBackend, 'read'>,
        msgId: string,
        senderId: string
    ): Promise<Pick<ALInboundAdmissionObservations, 'pendingAck' | 'acks'>> {
        const pendingAck = (await database.read(
            this.toControlPendingKey(msgId, senderId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'pending')
        ))?.value;
        const acks = (await database.read(
            this.toControlAcksKey(msgId, senderId),
            (value) => decodeALAdmissionControlValue(value, msgId, 'acks')
        ))?.values ?? [];
        return { pendingAck, acks };
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

    private async readControlOwnerIndex(msgId: string): Promise<ALInboundControlOwnerIndex | undefined> {
        return await this.backend.read(
            this.toControlOwnerIndexKey(msgId),
            decodeALInboundControlOwnerIndex
        );
    }

    private toControlOwnerIndexKey(msgId: string): string {
        return `${this.namespace}:control:owners:${encodeURIComponent(msgId)}`;
    }

    private toControlAcksKey(msgId: string, senderId: string): string {
        return `${this.namespace}:control:acks:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
    }

    private toControlPendingKey(msgId: string, senderId: string): string {
        return `${this.namespace}:control:pending:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
    }

    private toBufferedKey(trackKey: string, seq: number): string {
        return `${this.namespace}:buffered:${trackKey}:${seq}`;
    }

    private toBufferedTrackPrefix(trackKey: string): string {
        return `${this.namespace}:buffered:${trackKey}:`;
    }
}

interface ALInboundControlAdmissionRead {
    readonly namespace: string;
    readonly ack: ALAckPayload;
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly owner: ALInboundMessageOwner;
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly nowMs: number;
    readonly controlMsgId: string;
}

interface ALInboundControlAdmissionCandidate {
    readonly read: ALInboundControlAdmissionRead;
    readonly acks: AcksControlValue;
    readonly pending: PendingControlValue | undefined;
    readonly completedEffect: ALInboundDurableEffectWrite | undefined;
    readonly acceptance: ALControlAcceptance;
    readonly controlExpireAtTimestamp: number;
    readonly pendingExpireAtTimestamp: number;
}

function computeALInboundControlAdmission(
    read: ALInboundControlAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundControlAdmissionCandidate {
    const retainedAcks = read.acks.slice(-(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1));
    const acks = [...retainedAcks, read.ack];
    const transition = acceptALPendingAckPayload({
        current: read.pending,
        nextAcks: acks,
        ack: read.ack
    });
    const completed = transition.completed;
    return {
        read,
        acks: { kind: 'acks', values: acks },
        pending: transition.pending === undefined ? undefined : { kind: 'pending', value: transition.pending },
        completedEffect: completed ? computeCompletedAcknowledgementWork(read, completed, retention) : undefined,
        acceptance: {
            handled: true,
            completedPendingAcks: completed ? [completed] : []
        },
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, read.nowMs),
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(
            transition.pending?.expireAtTimestamp,
            retention.controlPendingTtlMs,
            read.nowMs
        )
    };
}

function computeCompletedAcknowledgementWork(
    read: ALInboundControlAdmissionRead,
    completed: ALCompletedPendingAck,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALInboundDurableEffectWrite {
    return computeALInboundWorkEntry({
        namespace: read.namespace,
        observedAtMs: read.nowMs,
        effectId: toInboundEffectId('ack', completed.msgId, completed.toPeerId, completed.status, read.controlMsgId),
        expireAtTimestamp: resolveExpireAtTimestampWithFallback(
            completed.expireAtTimestamp,
            retention.durableEffectTtlMs,
            read.nowMs
        ),
        payload: {
            kind: 'send-control',
            msg: newALAckControlMessage(
                { v: 2, msgId: read.controlMsgId, senderId: read.ack.toPeerId, ts: read.nowMs },
                {
                    fromPeerId: read.ack.toPeerId,
                    toPeerId: completed.toPeerId,
                    ackedMsgId: completed.msgId,
                    status: completed.status,
                    observedAtEpochMs: read.nowMs
                }
            )
        }
    });
}

function validateALInboundControlAdmission(
    candidate: ALInboundControlAdmissionCandidate
): Either<ALMessageRejection, ALInboundControlAdmissionCandidate> {
    const { ack, pending, acks } = candidate.read;
    if (!pending || !pending.expectedFromPeerIds.includes(ack.fromPeerId)) {
        return rejectInboundControl('Inbound acknowledgement sender has no pending obligation');
    }
    if (
        pending.ackedFromPeerIds.includes(ack.fromPeerId) ||
        acks.some((prior) => prior.fromPeerId === ack.fromPeerId)
    ) {
        return rejectInboundControl('Inbound acknowledgement was already admitted');
    }
    if (
        candidate.acks.values.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
        !Number.isSafeInteger(candidate.pendingExpireAtTimestamp)
    ) {
        return rejectInboundControl('Inbound acknowledgement candidate exceeds persistence limits');
    }
    return Either.ofRight(candidate);
}

function rejectInboundControl(
    message: string
): Either<ALMessageRejection, ALInboundControlAdmissionCandidate> {
    return Either.ofLeft({ code: 'unauthorized', message });
}

function equalInboundMessageOwner(
    left: ALInboundMessageOwner | undefined,
    right: ALInboundMessageOwner
): boolean {
    return left?.msgId === right.msgId && left.senderId === right.senderId &&
        left.supersedenceKey === right.supersedenceKey &&
        JSON.stringify(left.source) === JSON.stringify(right.source);
}

function equalInboundControlOwnerIndex(
    left: ALInboundControlOwnerIndex | undefined,
    right: ALInboundControlOwnerIndex | undefined
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function toInboundEffectId(...parts: readonly (number | string)[]): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}
