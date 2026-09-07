import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
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
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { type ALAdmissionBackend, type ALAdmissionWriteContext } from '../al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionArray,
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
import type { ALOrderingAcceptance } from '../compute-al-ordering-observation.ts';
import {
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { ALInboundDurableEffectStore } from './al-inbound-durable-effect-store.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { decodeALInboundBufferedSnapshot, decodeALInboundOrderingSnapshot } from './al-inbound-ordering-validation.ts';
import type { ALInboundPlannerSnapshot } from './al-inbound-planner-snapshot.ts';
import { decodeALInboundSource } from './al-inbound-source-validation.ts';
import { acceptALPendingAckPayload } from './transition-al-pending-ack.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

type PendingControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'pending'; }>>;
type AcksControlValue = Extract<ALControlPersistenceValue, Readonly<{ kind: 'acks'; }>>;

export interface ALVersionedClientRecord {
    readonly senderId: string;
    readonly version: number;
}

interface ALInboundMessageOwner {
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

export interface ALInboundMessageReadDto {
    readonly kind: 'incoming';
    readonly msg: ALMessage;
    readonly fromPeerId: string;
    readonly source: ALInboundMessageRuntime.Source;
    readonly nowMs: number;
    readonly clientRecord?: ALVersionedClientRecord;
    readonly orderingSnapshot?: ALOrderingTrackSnapshot;
    readonly orderingAcceptance: ALOrderingAcceptance;
    readonly bufferedSnapshots: readonly ALBufferedOrderedMessageSnapshot[];
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
    readonly fromPeerId: string;
    readonly source: ALInboundMessageRuntime.Source;
    readonly clientRecord?: ALVersionedClientRecord;
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
    readonly kind: 'buffered-release';
    readonly nowMs: number;
    readonly source: ALInboundMessageRuntime.Source;
    readonly clientRecord?: ALVersionedClientRecord;
    readonly snapshot: ALBufferedOrderedMessageSnapshot;
    readonly supersedence: ALInboundSupersedenceReadState;
    readonly supersedenceTrackTtlMs: number;
    readonly pendingAck?: ALPendingAckSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly controlOwners: ALInboundControlOwnerIndex | undefined;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
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
        source: ALInboundMessageRuntime.Source;
        supersedenceKey: string | null;
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
        kind: 'delete-ordering';
        trackKey: string;
    }>
    | Readonly<{
        kind: 'set-supersedence-latest';
        supersedenceKey: string;
        expected: ALLatestSupersedenceValue | undefined;
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
        expected: ALInboundControlOwnerIndex | undefined;
        value: ALInboundControlOwnerIndex;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-buffered';
        snapshot: ALBufferedOrderedMessageSnapshot;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'delete-buffered';
        trackKey: string;
        seq: number;
    }>;

export interface ALInboundWriteRequest {
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly versionExpireAtTimestamp: number;
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
    readonly expireAtTimestamp: number;
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
    readonly versionExpireAtTimestamp: number;
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
    readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead>;

    readBufferedRelease(input: ReadALInboundBufferedReleaseInput): Promise<ALInboundBufferedReleaseReadDto | undefined>;

    readDeliveryPredecessors(trackKey: string, beforeSeq: number): Promise<readonly ALInboundDeliveryPredecessor[]>;

    readStoredPlanningState(input: ReadALInboundStoredPlanningInput): Promise<ALInboundStoredPlanningRead>;

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

    export interface VersionWrite {
        readonly senderId: string;
        readonly expireAtTimestamp: number;
        readonly currentVersion?: number;
    }

    export interface MessageOwnerDecode {
        readonly value: unknown;
        readonly key: string;
        readonly expectedMsgId: string;
        readonly expectedSenderId: string;
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

    async readIncomingMessage(input: ReadALInboundMessageInput): Promise<ALInboundAdmissionRead> {
        const { msg, source, nowMs, prePlan } = input;
        const clientRecord = await this.backend.read(
            this.toVersionKey(msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
        );
        const dedupExpiresAt = await this.backend.read(this.toDedupKey(prePlan.dedupKey), decodeALAdmissionNumber);
        const ordering = await this.readOrderingState(msg);
        const supersedence = await this.readSupersedenceState(prePlan.supersedence.key, msg.id.msgId);
        const pendingAck = (await this.backend.read(
            this.toControlPendingKey(msg.id.msgId, msg.id.senderId),
            (value) => decodeALAdmissionControlValue(value, msg.id.msgId, 'pending')
        ))?.value;
        const acks = (await this.backend.read(
            this.toControlAcksKey(msg.id.msgId, msg.id.senderId),
            (value) => decodeALAdmissionControlValue(value, msg.id.msgId, 'acks')
        ))?.values ?? [];
        return {
            msg,
            fromPeerId: source.kind === 'trusted-server' ? msg.id.senderId : source.peerId,
            source,
            prePlan,
            nowMs,
            clientRecord,
            pendingAck,
            acks,
            controlOwners: await this.readControlOwnerIndex(msg.id.msgId),
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
        input: ReadALInboundBufferedReleaseInput
    ): Promise<ALInboundBufferedReleaseReadDto | undefined> {
        const { trackKey, seq, nowMs } = input;
        const prefix = this.toBufferedTrackPrefix(trackKey);
        const snapshot = await this.backend.read(
            this.toBufferedKey(trackKey, seq),
            (value, key) => decodeALInboundBufferedSnapshot(value, { trackKey, prefix, key })
        );
        if (!snapshot) {
            return undefined;
        }

        const source = (await this.readMessageOwner(snapshot.msg)).source;
        const clientRecord = await this.backend.read(
            this.toVersionKey(snapshot.msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, snapshot.msg.id.senderId)
        );
        const supersedence = await this.readSupersedenceState(
            snapshot.plan.supersedence.key,
            snapshot.msg.id.msgId
        );
        const pendingAck = (await this.backend.read(
            this.toControlPendingKey(snapshot.msg.id.msgId, snapshot.msg.id.senderId),
            (value) => decodeALAdmissionControlValue(value, snapshot.msg.id.msgId, 'pending')
        ))?.value;
        const acks = (await this.backend.read(
            this.toControlAcksKey(snapshot.msg.id.msgId, snapshot.msg.id.senderId),
            (value) => decodeALAdmissionControlValue(value, snapshot.msg.id.msgId, 'acks')
        ))?.values ?? [];

        return {
            kind: 'buffered-release',
            nowMs,
            source,
            clientRecord,
            snapshot,
            supersedence,
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs,
            pendingAck,
            acks,
            controlOwners: await this.readControlOwnerIndex(snapshot.msg.id.msgId),
            retention: this.retention
        };
    }

    async readDeliveryPredecessors(
        trackKey: string,
        beforeSeq: number
    ): Promise<readonly ALInboundDeliveryPredecessor[]> {
        return await this.effects.readDeliveryPredecessors(trackKey, beforeSeq);
    }

    async readStoredPlanningState(input: ReadALInboundStoredPlanningInput): Promise<ALInboundStoredPlanningRead> {
        const owner = await this.readMessageOwner(input.msg);
        return {
            msg: input.msg,
            source: owner.source,
            nowMs: input.nowMs,
            supersedenceKey: owner.supersedenceKey,
            supersedence: await this.readSupersedenceState(owner.supersedenceKey ?? undefined, input.msg.id.msgId),
            supersedenceTrackTtlMs: this.supersedenceTrackTtlMs
        };
    }

    async commitMutations(
        request: ALInboundWriteRequest
    ): Promise<'committed' | 'conflict'> {
        return await this.commitBundle({
            senderId: request.senderId,
            expectedVersion: request.expectedVersion,
            versionExpireAtTimestamp: request.versionExpireAtTimestamp,
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
        const validated = validateALInboundCommitBundle(bundle);
        if (validated.left) {
            throw new TypeError(validated.left.message);
        }

        try {
            return await this.backend.write((transaction) => this.writeCommitBundle(transaction, validated.right!));
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
        await this.bumpVersion(transaction, {
            senderId: bundle.senderId,
            expireAtTimestamp: bundle.versionExpireAtTimestamp,
            currentVersion
        });
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
        const decoded = decodeALControlMessage(msg);
        if (decoded.left || decoded.right!.type !== 'ack') {
            return { handled: false, completedPendingAcks: [] };
        }
        const parsed = decoded.right!;
        if (parsed.type !== 'ack') {
            return { handled: false, completedPendingAcks: [] };
        }
        const nowMs = this.nowMs();
        const read = await this.readControlAdmission(parsed.payload, nowMs, crypto.randomUUID());
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
        const ownerKey = this.toMsgOwnerKey(ack.ackedMsgId, senderId);
        const owner = await this.backend.read(
            ownerKey,
            (value, key) =>
                this.decodeMessageOwner({
                    value,
                    key,
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
        const ownerVersion = await this.backend.read(
            this.toVersionKey(owner.senderId),
            (value) => decodeALAdmissionClientRecord(value, owner.senderId)
        );
        if (!ownerVersion) {
            throw new ALAdmissionCorruptionError(
                this.toVersionKey(owner.senderId),
                new TypeError('Retained inbound message provenance has no sender version')
            );
        }
        return { ack, controlOwners, owner, ownerVersion, pending, acks, nowMs, controlMsgId };
    }

    private async writeControlAdmission(
        tx: ALAdmissionWriteContext,
        candidate: ALInboundControlAdmissionCandidate
    ): Promise<void> {
        const currentControlOwners = await tx.read(
            this.toControlOwnerIndexKey(candidate.read.ack.ackedMsgId),
            decodeInboundControlOwnerIndex
        );
        if (!equalInboundControlOwnerIndex(currentControlOwners, candidate.read.controlOwners)) {
            throw new ALAdmissionBackendConflictError('Inbound acknowledgement ownership changed during admission');
        }
        const currentOwner = await tx.read(
            this.toMsgOwnerKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            (value, key) =>
                this.decodeMessageOwner({
                    value,
                    key,
                    expectedMsgId: candidate.read.ack.ackedMsgId,
                    expectedSenderId: candidate.read.owner.senderId
                })
        );
        const currentVersion = await tx.read(
            this.toVersionKey(candidate.read.owner.senderId),
            (value) => decodeALAdmissionClientRecord(value, candidate.read.owner.senderId)
        );
        if (
            !equalInboundMessageOwner(currentOwner, candidate.read.owner) ||
            currentVersion?.version !== candidate.read.ownerVersion.version
        ) {
            throw new ALAdmissionBackendConflictError('Inbound acknowledgement state changed during admission');
        }
        await tx.set(
            this.toControlAcksKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
            { kind: 'acks', values: candidate.acks } satisfies AcksControlValue,
            candidate.controlExpireAtTimestamp
        );
        if (candidate.pending) {
            await tx.set(
                this.toControlPendingKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId),
                { kind: 'pending', value: candidate.pending } satisfies PendingControlValue,
                candidate.pendingExpireAtTimestamp
            );
        }
        else {
            await tx.remove(
                this.toControlPendingKey(candidate.read.ack.ackedMsgId, candidate.read.owner.senderId)
            );
        }
        if (candidate.completedEffect) {
            await this.effects.writePreparedEffect(tx, candidate.completedEffect, candidate.read.nowMs);
        }
        await this.bumpVersion(tx, {
            senderId: candidate.read.owner.senderId,
            expireAtTimestamp: candidate.versionExpireAtTimestamp,
            currentVersion: candidate.read.ownerVersion.version
        });
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
                return await this.writeMessageOwner(tx, mutation);
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
            case 'set-supersedence-latest': {
                const current = await tx.read(
                    this.toSupersedenceLatestKey(mutation.supersedenceKey),
                    (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
                );
                if (!jsonEquals(current, mutation.expected)) {
                    throw new ALAdmissionBackendConflictError('Inbound shared supersedence observation changed');
                }
                return await tx.set(
                    this.toSupersedenceLatestKey(mutation.supersedenceKey),
                    mutation.value,
                    mutation.value.updatedAtMs + this.supersedenceTrackTtlMs
                );
            }
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
                return await this.writeControlOwnerIndex(tx, mutation);
            }
            case 'set-buffered':
                return await tx.set(
                    this.toBufferedKey(mutation.snapshot.trackKey, mutation.snapshot.seq),
                    mutation.snapshot,
                    mutation.expireAtTimestamp
                );
            case 'delete-buffered':
                return await tx.remove(this.toBufferedKey(mutation.trackKey, mutation.seq));
        }
    }

    private async writeMessageOwner(
        tx: ALAdmissionWriteContext,
        mutation: Extract<ALInboundAdmissionMutation, Readonly<{ kind: 'set-msg-owner'; }>>
    ): Promise<void> {
        await tx.set(
            this.toMsgOwnerKey(mutation.msgId, mutation.senderId),
            {
                msgId: mutation.msgId,
                senderId: mutation.senderId,
                source: mutation.source,
                supersedenceKey: mutation.supersedenceKey
            } satisfies ALInboundMessageOwner,
            mutation.expireAtTimestamp
        );
    }

    private async writeControlOwnerIndex(
        tx: ALAdmissionWriteContext,
        mutation: Extract<ALInboundAdmissionMutation, Readonly<{ kind: 'set-control-owners'; }>>
    ): Promise<void> {
        const key = this.toControlOwnerIndexKey(mutation.msgId);
        const current = await tx.read(key, decodeInboundControlOwnerIndex);
        if (!equalInboundControlOwnerIndex(current, mutation.expected)) {
            throw new ALAdmissionBackendConflictError('Inbound control owner index changed during admission');
        }
        await tx.set(key, mutation.value, mutation.expireAtTimestamp);
    }

    private async bumpVersion(
        tx: ALAdmissionWriteContext,
        input: ProviderBackedALInboundAdmissionStore.VersionWrite
    ): Promise<void> {
        const version = input.currentVersion ??
            (await tx.read(
                this.toVersionKey(input.senderId),
                (value) => decodeALAdmissionClientRecord(value, input.senderId)
            ))
                ?.version;
        await tx.set(
            this.toVersionKey(input.senderId),
            {
                senderId: input.senderId,
                version: (version ?? 0) + 1
            } satisfies ALVersionedClientRecord,
            input.expireAtTimestamp
        );
    }

    private toVersionKey(senderId: string): string {
        return `${this.namespace}:version:${senderId}`;
    }

    private toMsgOwnerKey(msgId: string, senderId: string): string {
        return `${this.namespace}:msg-owner:${encodeURIComponent(msgId)}:${encodeURIComponent(senderId)}`;
    }

    private async readMessageOwner(msg: ALMessage): Promise<ALInboundMessageOwner> {
        const owner = await this.backend.read(
            this.toMsgOwnerKey(msg.id.msgId, msg.id.senderId),
            (value, key) =>
                this.decodeMessageOwner({
                    value,
                    key,
                    expectedMsgId: msg.id.msgId,
                    expectedSenderId: msg.id.senderId
                })
        );
        if (!owner) {
            throw new TypeError('Admitted AL message has no retained ingress source');
        }
        return owner;
    }

    private decodeMessageOwner(input: ProviderBackedALInboundAdmissionStore.MessageOwnerDecode): ALInboundMessageOwner {
        const owner = decodeALAdmissionRecord(input.value, ['msgId', 'senderId', 'source', 'supersedenceKey']);
        const msgId = decodeALAdmissionString(owner.msgId);
        const senderId = decodeALAdmissionString(owner.senderId);
        if (
            msgId !== input.expectedMsgId || senderId !== input.expectedSenderId ||
            input.key !== this.toMsgOwnerKey(msgId, senderId)
        ) {
            throw new TypeError('Stored inbound message owner identity does not match its slot');
        }
        if (owner.supersedenceKey !== null && typeof owner.supersedenceKey !== 'string') {
            throw new TypeError('Stored inbound message owner supersedence key is invalid');
        }
        return {
            msgId,
            senderId,
            source: decodeALInboundSource(owner.source),
            supersedenceKey: owner.supersedenceKey
        };
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
            decodeInboundControlOwnerIndex
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

function decodeInboundControlOwnerIndex(value: unknown): ALInboundControlOwnerIndex {
    const record = decodeALAdmissionRecord(value, ['ambiguous', 'values']);
    if (typeof record.ambiguous !== 'boolean') {
        throw new TypeError('Stored inbound control owner ambiguity is invalid');
    }
    const peerIds = new Set<string>();
    const values = decodeALAdmissionArray(record.values, (entry) => {
        const owner = decodeALAdmissionRecord(entry, ['peerId', 'senderId']);
        const peerId = decodeALAdmissionString(owner.peerId);
        if (
            peerId.length === 0 || peerIds.has(peerId) ||
            (owner.senderId !== null && (typeof owner.senderId !== 'string' || owner.senderId.length === 0))
        ) {
            throw new TypeError('Stored inbound control owner entry is invalid');
        }
        peerIds.add(peerId);
        return {
            peerId,
            senderId: owner.senderId
        };
    });
    if (record.ambiguous && values.length !== 0) {
        throw new TypeError('Ambiguous inbound control owner index must not retain entries');
    }
    return { ambiguous: record.ambiguous, values };
}

interface ALInboundControlAdmissionRead {
    readonly ack: ALAckPayload;
    readonly controlOwners: ALInboundControlOwnerIndex;
    readonly owner: ALInboundMessageOwner;
    readonly ownerVersion: ALVersionedClientRecord;
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly acks: readonly ALAckPayload[];
    readonly nowMs: number;
    readonly controlMsgId: string;
}

interface ALInboundControlAdmissionCandidate {
    readonly read: ALInboundControlAdmissionRead;
    readonly acks: readonly ALAckPayload[];
    readonly pending: ALPendingAckSnapshot | undefined;
    readonly completedEffect: ALInboundDurableEffectWrite | undefined;
    readonly acceptance: ALControlAcceptance;
    readonly controlExpireAtTimestamp: number;
    readonly pendingExpireAtTimestamp: number;
    readonly versionExpireAtTimestamp: number;
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
        acks,
        pending: transition.pending,
        completedEffect: completed
            ? {
                effectId: toInboundEffectId('ack', completed.msgId, completed.toPeerId, completed.status),
                expireAtTimestamp: resolveExpireAtTimestampWithFallback(
                    completed.expireAtTimestamp,
                    retention.durableEffectTtlMs,
                    read.nowMs
                ),
                payload: {
                    kind: 'send-control',
                    msg: newALAckControlMessage(
                        {
                            v: 2,
                            msgId: read.controlMsgId,
                            senderId: read.ack.toPeerId,
                            ts: read.nowMs
                        },
                        {
                            fromPeerId: read.ack.toPeerId,
                            toPeerId: completed.toPeerId,
                            ackedMsgId: completed.msgId,
                            status: completed.status,
                            observedAtEpochMs: read.nowMs
                        }
                    )
                }
            }
            : undefined,
        acceptance: {
            handled: true,
            completedPendingAcks: completed ? [completed] : []
        },
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, read.nowMs),
        pendingExpireAtTimestamp: resolveExpireAtTimestampWithFallback(
            transition.pending?.expireAtTimestamp,
            retention.controlPendingTtlMs,
            read.nowMs
        ),
        versionExpireAtTimestamp: toExpireAtTimestampFromNow(retention.versionTtlMs, read.nowMs)
    };
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
        candidate.acks.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries ||
        !Number.isSafeInteger(candidate.controlExpireAtTimestamp) ||
        !Number.isSafeInteger(candidate.pendingExpireAtTimestamp) ||
        !Number.isSafeInteger(candidate.versionExpireAtTimestamp)
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
