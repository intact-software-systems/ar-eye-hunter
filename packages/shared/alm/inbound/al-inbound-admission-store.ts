import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALControlPersistenceValue,
    ALPendingAckSnapshot
} from '../../al-contracts/al-control.ts';
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
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
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
    readALInboundBufferedMessage,
    toALStoredInboundBufferedSnapshot,
    type ALInboundOrderedDeliverySnapshot,
    type ALInboundResolvedDeliverySnapshot
} from './al-inbound-ordering-validation.ts';
import type { ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import type { ALInboundPlannerSnapshot } from './al-inbound-planner-snapshot.ts';
import {
    decodeALInboundControlOwnerIndex,
    decodeALInboundMessageOwner,
    readALInboundStoredMessage,
    toALInboundMessageKey,
    toALInboundMessageOwnerKey,
    type ALInboundMessageReference,
    type ALStoredInboundMessage
} from './al-inbound-source-validation.ts';
import type { ALInboundPendingControl } from './control/al-inbound-control-admission.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

export type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending'; }>>;
export type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks'; }>>;

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
            buffered: readonly ALInboundResolvedDeliverySnapshot[];
        }>
        | undefined;
    readonly buffered: ALInboundResolvedDeliverySnapshot | undefined;
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
    readonly bufferedSnapshots: readonly ALInboundResolvedDeliverySnapshot[];
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
    readonly bufferedSnapshots: readonly ALInboundResolvedDeliverySnapshot[];
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
    readonly snapshot: ALInboundResolvedDeliverySnapshot;
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
        kind: 'set-control-acks';
        msgId: string;
        senderId: string;
        value: AcksControlValue;
        expireAtTimestamp: number;
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
    | ALInboundPendingControl
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
    readonly nowMs?: () => number;
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ALInboundAdmissionStore extends ALReadyable {
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead>;

    readBufferedRelease(input: ReadALInboundBufferedReleaseInput): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead>;

    readStoredPlanningState(input: ReadALInboundStoredPlanningInput): Promise<ALInboundStoredPlanningRead>;

    readInboundMessage(reference: ALInboundMessageReference): Promise<ALMessage | undefined>;

    readControlOwnerIndex(msgId: string): Promise<ALInboundControlOwnerIndex | undefined>;

    readMessageOwnerRecord(msgId: string, senderId: string): Promise<ALInboundMessageOwner | undefined>;

    readAcknowledgementState(
        msgId: string,
        senderId: string
    ): Promise<Pick<ALInboundAdmissionObservations, 'pendingAck' | 'acks'>>;

    commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict' | 'expired'>;

    commitBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict' | 'expired'>;
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
        nowMs: input.nowMs ?? Date.now
    });
}

namespace ProviderBackedALInboundAdmissionStore {
    export interface OrderingRead {
        readonly trackKey: string | undefined;
        readonly snapshot: ALOrderingTrackSnapshot | undefined;
        readonly buffered: readonly ALInboundResolvedDeliverySnapshot[];
    }

    export interface Dependencies {
        readonly namespace: string;
        readonly orderingTrackTtlMs: number;
        readonly supersedenceTrackTtlMs: number;
        readonly retention: NormalizedALRuntimeStoreRetentionConfig;
        readonly backend: ALAdmissionWorkBackend;
        readonly nowMs: () => number;
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly orderingTrackTtlMs: number;
    private readonly supersedenceTrackTtlMs: number;
    private readonly backend: ALAdmissionWorkBackend;
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
            namespace: input.namespace
        });
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead> {
        const { msg, source, nowMs, prePlan } = input;
        const messageOwner = await this.readStoredMessageOwner(this.backend, msg.id.msgId, msg.id.senderId);
        const dedupExpiresAt = await this.backend.read(this.toDedupKey(prePlan.dedupKey), decodeALAdmissionNumber);
        const ordering = await this.readOrderingState(this.backend, toALOrderingTrackKey(msg));
        const supersedence = await this.readSupersedenceState(this.backend, prePlan.supersedence.key, msg.id.msgId);
        const deliveryProgress = await this.readDeliveryProgress(ordering.trackKey);
        const { pendingAck, acks } = await this.readStoredAcknowledgements(this.backend, msg.id.msgId, msg.id.senderId);
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
        const buffered = await Promise.all(
            stored.map(async (entry) =>
                await readALInboundBufferedMessage({ database, namespace: this.namespace, stored: entry.value })
            )
        );
        return { trackKey, snapshot, buffered: buffered.sort((left, right) => left.seq - right.seq) };
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
        const snapshot = await readALInboundBufferedMessage({
            database: this.backend,
            namespace: this.namespace,
            stored
        });

        const messageOwner = await this.readMessageOwner(snapshot.msg);
        const deliveryProgress = await this.readDeliveryProgress(trackKey);
        const source = messageOwner.source;
        const supersedence = await this.readSupersedenceState(
            this.backend,
            snapshot.plan.supersedence.key,
            snapshot.msg.id.msgId
        );
        const { pendingAck, acks } = await this.readStoredAcknowledgements(
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
        const messageOwner = await this.readStoredMessageOwner(transaction, observed.msgId, observed.senderId);
        const { pendingAck, acks } = await this.readStoredAcknowledgements(
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
            : await readALInboundBufferedMessage({
                database: transaction,
                namespace: this.namespace,
                stored: storedBuffered
            });
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
            case 'set-control-acks':
                return await tx.set(
                    this.toControlAcksKey(mutation.msgId, mutation.senderId),
                    mutation.value,
                    mutation.expireAtTimestamp
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
        const stored = await readALInboundStoredMessage({
            database: this.backend,
            namespace: this.namespace,
            reference
        });
        return stored?.msg;
    }

    private async readMessageOwner(msg: ALMessage): Promise<ALInboundMessageOwner> {
        const ownerKey = toALInboundMessageOwnerKey(this.namespace, msg.id.msgId, msg.id.senderId);
        const owner = await this.readStoredMessageOwner(this.backend, msg.id.msgId, msg.id.senderId);
        if (owner === undefined) {
            throw new ALAdmissionCorruptionError(
                ownerKey,
                new TypeError('Admitted AL message has no retained ingress source')
            );
        }
        return owner;
    }

    async readMessageOwnerRecord(msgId: string, senderId: string): Promise<ALInboundMessageOwner | undefined> {
        return await this.readStoredMessageOwner(this.backend, msgId, senderId);
    }

    async readAcknowledgementState(
        msgId: string,
        senderId: string
    ): Promise<Pick<ALInboundAdmissionObservations, 'pendingAck' | 'acks'>> {
        return await this.readStoredAcknowledgements(this.backend, msgId, senderId);
    }

    async readControlOwnerIndex(msgId: string): Promise<ALInboundControlOwnerIndex | undefined> {
        return await this.backend.read(
            this.toControlOwnerIndexKey(msgId),
            decodeALInboundControlOwnerIndex
        );
    }

    private async readStoredMessageOwner(
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

    private async readStoredAcknowledgements(
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
