import { readALTargetGroupRef, type ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALAckPayload, ALPendingAckSnapshot } from '../../al-contracts/al-control.ts';
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
import { jsonEquals } from '../../repository/state-utils.ts';
import {
    type ALAdmissionBackend,
    type ALAdmissionBackendEntry,
    type ALAdmissionWriteContext
} from '../al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type { ALStoreDurability } from '../al-runtime-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import type { ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { validateALInboundCommitBundle } from './admission/validate-al-inbound-commit-bundle.ts';
import {
    readALInboundStoredMessage,
    toALInboundMessageKey,
    type ALInboundMessageReference,
    type ALStoredInboundMessage
} from './al-inbound-canonical-message.ts';
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
import { readALInboundMessageOwner, toALInboundMessageOwnerKey } from './al-inbound-source-validation.ts';
import type { ALInboundDurableEffectWrite } from './al-inbound-work-entry.ts';
import type { ALInboundPendingControl } from './control/al-inbound-control-admission.ts';
import {
    applyALInboundControlMutation,
    readControlDecisionSurface,
    readStoredAcknowledgements,
    readStoredControlOwnerIndex,
    type AcksControlValue,
    type PendingControlValue
} from './control/al-inbound-control-rows.ts';

/**
 * The most ordering snapshots one store keeps (D191). The next new track evicts the least recently updated
 * one, so a departed sender's tracks leave under churn instead of an hour after their last message.
 */
export const AL_INBOUND_MAX_ORDERING_TRACKS = 256;

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

/** The rows one acknowledgement decides on, all read for the sender its owner index resolves. */
export interface ALInboundControlDecisionSurface {
    readonly senderId: string;
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly messageOwner: ALInboundMessageOwner | undefined;
    readonly pendingAck: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
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
    /** Read only for an exclusive room message from a WS client: the session holding its resource key, if any. */
    readonly claim: Readonly<{ key: string; holderPeerId: string | undefined; }> | undefined;
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
    readonly durability: ALStoreDurability;
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
    readonly durability: ALStoreDurability;
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
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly durability: ALStoreDurability;
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
        kind: 'set-claim';
        claimKey: string;
        holderPeerId: string;
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
        retryPeerIds?: readonly string[];
    }>
    | Readonly<{
        kind: 'release-buffered';
        trackKey: string;
        seq: number;
    }>;

export interface ALInboundCommitBundle {
    /** Original data-admission eligibility; null identifies later control/finalization bookkeeping. */
    readonly admissionExpiresAtMs: number | null;
    readonly senderId: string;
    readonly observations: ALInboundAdmissionObservations;
    readonly mutations: readonly ALInboundAdmissionMutation[];
    readonly durableEffects: readonly ALInboundDurableEffectWrite[];
}

export interface CreateALInboundAdmissionStoreInput {
    readonly nowMs: () => number;
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export interface ALInboundAdmissionStore extends ALReadyable {
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly durability: ALStoreDurability;
    readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead>;

    readBufferedRelease(input: ReadALInboundBufferedReleaseInput): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead>;

    /**
     * The retained message and the planning state it is planned against, from one read session.
     * Absent when the canonical message row is gone, which is the delivery's own corruption signal.
     */
    readDeliverySurface(
        reference: ALInboundMessageReference,
        nowMs: number
    ): Promise<ALInboundStoredPlanningRead | undefined>;

    /** Absent when the owner index names no single original sender for the acknowledging peer. */
    readControlDecisionSurface(ack: ALAckPayload): Promise<ALInboundControlDecisionSurface | undefined>;

    /** The audience a WS client's message was frozen to at ingress; absent for any other message or a missing row. */
    readIngressAudience(msgId: string, originPeerId: string): Promise<readonly string[] | undefined>;

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
    return new ProviderBackedALInboundAdmissionStore({ ...input, durability: 'durable' });
}

export function createVolatileALInboundAdmissionStore(
    input: CreateALInboundAdmissionStoreInput
): ALInboundAdmissionStore {
    return new ProviderBackedALInboundAdmissionStore({ ...input, durability: 'volatile' });
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
        readonly durability: ALStoreDurability;
    }
}

class ProviderBackedALInboundAdmissionStore implements ALInboundAdmissionStore {
    readonly namespace: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly durability: ALStoreDurability;
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
        this.durability = input.durability;
        this.effects = new ALInboundDurableEffectStore({
            backend: input.backend,
            namespace: input.namespace
        });
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead> {
        const { msg, prePlan } = input;
        return await this.backend.readWithin(async (session): Promise<ALInboundAdmissionRead> => {
            const messageOwner = await readALInboundMessageOwner({
                database: session,
                namespace: this.namespace,
                msgId: msg.id.msgId,
                senderId: msg.id.senderId
            });
            const dedupExpiresAt = await session.read(this.toDedupKey(prePlan.dedupKey), decodeALAdmissionNumber);
            const claim = await this.readClaim(session, toALInboundClaimKey(input));
            const ordering = await this.readOrderingState(session, toALOrderingTrackKey(msg));
            const supersedence = await this.readSupersedenceState(session, prePlan.supersedence.key, msg.id.msgId);
            const deliveryProgress = await this.readDeliveryProgress(session, ordering.trackKey);
            const { pendingAck, acks } = await readStoredAcknowledgements({
                database: session,
                namespace: this.namespace,
                msgId: msg.id.msgId,
                senderId: msg.id.senderId
            });
            const controlOwners = await readStoredControlOwnerIndex(session, this.namespace, msg.id.msgId);
            return toALInboundAdmissionRead({
                namespace: this.namespace,
                request: input,
                messageOwner,
                dedupExpiresAt,
                claim,
                ordering,
                supersedence,
                deliveryProgress,
                pendingAck,
                acks,
                controlOwners,
                orderingTrackTtlMs: this.orderingTrackTtlMs,
                supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
                retention: this.retention,
                durability: this.durability
            });
        });
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

    /** The session holding the exclusive claim on `claimKey`, read beside the dedup key and guarded at the commit. */
    private async readClaim(
        database: Pick<ALAdmissionBackend, 'read'>,
        claimKey: string | undefined
    ): Promise<ALInboundAdmissionObservations['claim']> {
        return claimKey === undefined ? undefined : {
            key: claimKey,
            holderPeerId: await database.read(this.toClaimStoreKey(claimKey), decodeALAdmissionString)
        };
    }

    private async readBufferedMessage(
        database: Pick<ALAdmissionBackend, 'read'>,
        trackKey: string,
        seq: number
    ): Promise<ALInboundResolvedDeliverySnapshot | undefined> {
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const stored = await database.read(
            this.toBufferedKey(trackKey, seq),
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        return stored === undefined
            ? undefined
            : await readALInboundBufferedMessage({ database, namespace: this.namespace, stored });
    }

    async readBufferedRelease(
        input: ReadALInboundBufferedReleaseInput
    ): Promise<ALInboundBufferedReleaseReadDto | undefined> {
        const { trackKey, seq, nowMs } = input;
        return await this.backend.readWithin(async (session): Promise<ALInboundBufferedReleaseReadDto | undefined> => {
            const snapshot = await this.readBufferedMessage(session, trackKey, seq);
            if (snapshot === undefined) {
                return undefined;
            }
            const { msgId, senderId } = snapshot.msg.id;
            const messageOwner = await this.readMessageOwner(session, snapshot.msg);
            const deliveryProgress = await this.readDeliveryProgress(session, trackKey);
            const supersedence = await this.readSupersedenceState(session, snapshot.plan.supersedence.key, msgId);
            const { pendingAck, acks } = await readStoredAcknowledgements({
                database: session,
                namespace: this.namespace,
                msgId,
                senderId
            });
            const controlOwners = await readStoredControlOwnerIndex(session, this.namespace, msgId);
            return toALInboundBufferedReleaseReadDto({
                namespace: this.namespace,
                nowMs,
                snapshot,
                messageOwner,
                deliveryProgress,
                supersedence,
                pendingAck,
                acks,
                controlOwners,
                orderingTrackTtlMs: this.orderingTrackTtlMs,
                supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
                retention: this.retention,
                durability: this.durability
            });
        });
    }

    async readOrderedDelivery(trackKey: string, beforeSeq: number): Promise<ALInboundOrderedDeliveryRead> {
        return await this.effects.readOrderedDelivery(trackKey, beforeSeq);
    }

    private async readDeliveryProgress(
        database: Pick<ALAdmissionBackend, 'read'>,
        trackKey: string | undefined
    ) {
        if (trackKey === undefined) {
            return undefined;
        }
        return {
            trackKey,
            value: await database.read(
                `${this.namespace}:delivered:${trackKey}`,
                decodeALInboundDeliveryProgress
            )
        };
    }

    async readDeliverySurface(
        reference: ALInboundMessageReference,
        nowMs: number
    ): Promise<ALInboundStoredPlanningRead | undefined> {
        return await this.backend.readWithin(async (session): Promise<ALInboundStoredPlanningRead | undefined> => {
            const stored = await readALInboundStoredMessage({
                database: session,
                namespace: this.namespace,
                reference
            });
            if (stored === undefined) {
                return undefined;
            }
            const owner = await this.readMessageOwner(session, stored.msg);
            return {
                msg: stored.msg,
                source: owner.source,
                nowMs,
                supersedenceKey: owner.supersedenceKey,
                supersedence: await this.readSupersedenceState(
                    session,
                    owner.supersedenceKey ?? undefined,
                    stored.msg.id.msgId
                ),
                supersedenceTrackTtlMs: this.supersedenceTrackTtlMs
            };
        });
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

        const status = await this.writeValidatedBundle(validated.right!);
        if (status === 'committed' && opensALInboundOrderingTrack(bundle)) {
            await this.evictOrderingTracksPastCap();
        }
        return status;
    }

    private async writeValidatedBundle(
        bundle: ALInboundCommitBundle
    ): Promise<'committed' | 'conflict' | 'expired'> {
        try {
            return await this.backend.write(
                (transaction) => this.writeCommitBundle(transaction, bundle),
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

    /**
     * Removes the least recently updated snapshots past the cap, each only if it is still the one read: a snapshot
     * updated in between is no longer the least recent, and its conflict leaves the eviction to the next new track.
     * Only the snapshot leaves; the track's delivered marker keeps the completion evidence its live work reads.
     */
    private async evictOrderingTracksPastCap(): Promise<void> {
        const held = await this.backend.readWithin((session) =>
            session.list(this.toOrderingPrefix(), decodeALInboundOrderingSnapshot)
        );
        const evicted = resolveLeastRecentlyUpdatedTracks(held, held.length - AL_INBOUND_MAX_ORDERING_TRACKS);
        if (evicted.length === 0) {
            return;
        }
        try {
            await this.backend.write(async (transaction) => {
                for (const track of evicted) {
                    const current = await transaction.read(track.key, decodeALInboundOrderingSnapshot);
                    if (current !== undefined && jsonEquals(current, track.value)) {
                        await transaction.remove(track.key);
                    }
                }
            });
        }
        catch (error) {
            if (!(error instanceof ALAdmissionBackendConflictError)) {
                throw error;
            }
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
        const messageOwner = await readALInboundMessageOwner({
            database: transaction,
            namespace: this.namespace,
            msgId: observed.msgId,
            senderId: observed.senderId
        });
        const { pendingAck, acks } = await readStoredAcknowledgements({
            database: transaction,
            namespace: this.namespace,
            msgId: observed.msgId,
            senderId: observed.senderId
        });
        const controlOwners = await readStoredControlOwnerIndex(transaction, this.namespace, observed.msgId);
        const supersedence = await this.readSupersedenceState(transaction, observed.supersedence.key, observed.msgId);
        const dedup = observed.dedup === undefined ? undefined : {
            key: observed.dedup.key,
            expiresAtTimestamp: await transaction.read(this.toDedupKey(observed.dedup.key), decodeALAdmissionNumber)
        };
        const claim = await this.readClaim(transaction, observed.claim?.key);
        const ordering = observed.ordering === undefined
            ? undefined
            : await this.readOrderingState(transaction, observed.ordering.trackKey);
        const deliveryProgress = await this.readDeliveryProgress(transaction, observed.deliveryProgress?.trackKey);
        const buffered = observed.buffered === undefined
            ? undefined
            : await this.readBufferedMessage(transaction, observed.buffered.trackKey, observed.buffered.seq);
        if (
            !jsonEquals(observed, {
                ...observed,
                messageOwner,
                pendingAck,
                acks,
                controlOwners,
                supersedence,
                dedup,
                claim,
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
            case 'set-claim':
                return await tx.set(
                    this.toClaimStoreKey(mutation.claimKey),
                    mutation.holderPeerId,
                    mutation.expireAtTimestamp
                );
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
            case 'set-control-pending':
            case 'set-control-owners':
                return await applyALInboundControlMutation(tx, this.namespace, mutation);
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

    private async readMessageOwner(
        database: Pick<ALAdmissionBackend, 'read'>,
        msg: ALMessage
    ): Promise<ALInboundMessageOwner> {
        const ownerKey = toALInboundMessageOwnerKey(this.namespace, msg.id.msgId, msg.id.senderId);
        const owner = await readALInboundMessageOwner({
            database,
            namespace: this.namespace,
            msgId: msg.id.msgId,
            senderId: msg.id.senderId
        });
        if (owner === undefined) {
            throw new ALAdmissionCorruptionError(
                ownerKey,
                new TypeError('Admitted AL message has no retained ingress source')
            );
        }
        return owner;
    }

    async readControlDecisionSurface(ack: ALAckPayload): Promise<ALInboundControlDecisionSurface | undefined> {
        return await this.backend.readWithin((session) => readControlDecisionSurface(session, this.namespace, ack));
    }

    async readIngressAudience(msgId: string, originPeerId: string): Promise<readonly string[] | undefined> {
        const owner = await this.backend.readWithin((session) =>
            readALInboundMessageOwner({ database: session, namespace: this.namespace, msgId, senderId: originPeerId })
        );
        return owner?.source.kind === 'ws-client' && owner.source.peerId === originPeerId
            ? owner.source.groupRecipientPeerIds
            : undefined;
    }

    private toDedupKey(dedupKey: string): string {
        return `${this.namespace}:dedup:${dedupKey}`;
    }

    private toClaimStoreKey(claimKey: string): string {
        return `${this.namespace}:claim:${claimKey}`;
    }

    private toOrderingKey(trackKey: string): string {
        return `${this.toOrderingPrefix()}${trackKey}`;
    }

    private toOrderingPrefix(): string {
        return `${this.namespace}:ordering:`;
    }

    private toSupersedenceLatestKey(key: string): string {
        return `${this.namespace}:supersedence:latest:${key}`;
    }

    private toSupersedenceReplacementKey(msgId: string): string {
        return `${this.namespace}:supersedence:replacement:${msgId}`;
    }

    private toBufferedKey(trackKey: string, seq: number): string {
        return `${this.namespace}:buffered:${trackKey}:${seq}`;
    }

    private toBufferedTrackPrefix(trackKey: string): string {
        return `${this.namespace}:buffered:${trackKey}:`;
    }
}

/** A bundle that writes the first snapshot of its track: the only commit that can take the store past its cap. */
function opensALInboundOrderingTrack(bundle: ALInboundCommitBundle): boolean {
    return bundle.observations.ordering?.snapshot === undefined &&
        bundle.mutations.some((mutation) => mutation.kind === 'set-ordering');
}

/** Every snapshot expires one TTL after its update, so the least recently updated is also the next to expire. */
function resolveLeastRecentlyUpdatedTracks(
    held: readonly ALAdmissionBackendEntry<ALOrderingTrackSnapshot>[],
    count: number
): readonly ALAdmissionBackendEntry<ALOrderingTrackSnapshot>[] {
    return [...held]
        .sort((left, right) => left.value.updatedAtMs - right.value.updatedAtMs || left.key.localeCompare(right.key))
        .slice(0, Math.max(0, count));
}

/**
 * The key an exclusive room message from a WS client claims: the room's scope and the route, each part encoded. Only
 * the server arbitrates a claim, so no other source, no shared message and no roomless one claims anything. The same
 * group id exists in other scopes, so the scope is part of the key.
 */
function toALInboundClaimKey(input: ReadALInboundMessageInput): string | undefined {
    const { msg, source, prePlan } = input;
    const groupRef = readALTargetGroupRef(msg);
    if (source.kind !== 'ws-client' || prePlan.effective.ownership.algo !== 'exclusive' || groupRef === undefined) {
        return undefined;
    }
    return [
        groupRef.applicationId,
        groupRef.workspaceId,
        groupRef.groupId,
        msg.route.topicId,
        msg.route.contextId,
        msg.route.resourceId
    ].map(encodeURIComponent).join('/');
}

interface ToALInboundAdmissionReadInput {
    readonly namespace: string;
    readonly request: ReadALInboundMessageInput;
    readonly messageOwner: ALInboundMessageOwner | undefined;
    readonly dedupExpiresAt: number | undefined;
    readonly claim: ALInboundAdmissionObservations['claim'];
    readonly ordering: ProviderBackedALInboundAdmissionStore.OrderingRead;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly deliveryProgress: ALInboundAdmissionObservations['deliveryProgress'];
    readonly pendingAck: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly durability: ALStoreDurability;
}

function toALInboundAdmissionRead(observed: ToALInboundAdmissionReadInput): ALInboundAdmissionRead {
    const { msg, source, nowMs, prePlan } = observed.request;
    const { ordering, supersedence, dedupExpiresAt, claim, pendingAck, acks, controlOwners } = observed;
    return {
        namespace: observed.namespace,
        msg,
        fromPeerId: source.kind === 'trusted-server' ? msg.id.senderId : source.peerId,
        source,
        prePlan,
        nowMs,
        observations: {
            msgId: msg.id.msgId,
            senderId: msg.id.senderId,
            messageOwner: observed.messageOwner,
            dedup: { key: prePlan.dedupKey, expiresAtTimestamp: dedupExpiresAt },
            claim,
            ordering: ordering.trackKey === undefined
                ? undefined
                : { trackKey: ordering.trackKey, snapshot: ordering.snapshot, buffered: ordering.buffered },
            buffered: undefined,
            deliveryProgress: observed.deliveryProgress,
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
        claimHolderPeerId: claim?.holderPeerId,
        orderingTrackKey: ordering.trackKey,
        orderingSnapshot: ordering.snapshot,
        orderingTrackTtlMs: observed.orderingTrackTtlMs,
        supersedenceTrackTtlMs: observed.supersedenceTrackTtlMs,
        retention: observed.retention,
        durability: observed.durability,
        admitted: false,
        bufferedSnapshots: ordering.buffered
    };
}

interface ToALInboundBufferedReleaseReadDtoInput {
    readonly namespace: string;
    readonly nowMs: number;
    readonly snapshot: ALInboundResolvedDeliverySnapshot;
    readonly messageOwner: ALInboundMessageOwner;
    readonly deliveryProgress: ALInboundAdmissionObservations['deliveryProgress'];
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly pendingAck: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly orderingTrackTtlMs: number;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly durability: ALStoreDurability;
}

function toALInboundBufferedReleaseReadDto(
    observed: ToALInboundBufferedReleaseReadDtoInput
): ALInboundBufferedReleaseReadDto {
    const { snapshot, messageOwner, supersedence, pendingAck, acks, controlOwners } = observed;
    return {
        kind: 'buffered-release',
        orderingTrackTtlMs: observed.orderingTrackTtlMs,
        namespace: observed.namespace,
        nowMs: observed.nowMs,
        source: messageOwner.source,
        observations: {
            msgId: snapshot.msg.id.msgId,
            senderId: snapshot.msg.id.senderId,
            messageOwner,
            dedup: undefined,
            claim: undefined,
            ordering: undefined,
            buffered: snapshot,
            deliveryProgress: observed.deliveryProgress,
            supersedence,
            pendingAck,
            acks,
            controlOwners
        },
        snapshot,
        supersedence,
        supersedenceTrackTtlMs: observed.supersedenceTrackTtlMs,
        pendingAck,
        controlOwners,
        retention: observed.retention,
        durability: observed.durability
    };
}
