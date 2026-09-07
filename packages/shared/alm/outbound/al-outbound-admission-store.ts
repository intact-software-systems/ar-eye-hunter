import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { decodePersistedALMessage } from '../../al-contracts/al-message-persistence-validation.ts';
import type {
    ALReadyable,
    ALSupersedenceInput
} from '../../al-contracts/al-runtime.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { PersistenceWriteExpiredError } from '../../persistence/persistence-write-deadline.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { hasSameResourceEntryValue } from '../../queuebox/resource-entry-observations.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import {
    acceptALSupersedenceObservation,
    computeALSupersedenceObservation,
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { ALOutboundAdmissionControlStore } from './al-outbound-admission-control-store.ts';
import {
    ALOutboundAdmissionEffectStore,
    type ALOutboundEffectCandidate,
    type ClaimALOutboundEffectsInput,
    type RescheduleALOutboundEffectInput
} from './al-outbound-admission-effect-store.ts';
import {
    applyALOutboundCapturedPolicy,
    decodeALOutboundNotYetInSyncRetry,
    decodeALOutboundPendingAck,
    decodeALOutboundRepairAttempt,
    decodeALOutboundSentMessage,
    type ALOutboundCapturedPolicy,
    type ALStoredOutboundMessage
} from './al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    decodeALOutboundCanonicalMessage,
    decodeALOutboundMessageReference,
    toALOutboundCanonicalKey,
    toALOutboundIdentityEntry,
    toALOutboundIdentityKey,
    toALOutboundMessageReference,
    type ALOutboundMessageReference
} from './al-outbound-canonical-message.ts';
import {
    readALOutboundCanonicalMessage,
    readALOutboundCanonicalWrites,
    writeALOutboundCanonicalFacts,
    type ALOutboundCanonicalFactWrite
} from './al-outbound-canonical-storage.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundRepairTrigger
} from './al-outbound-message-runtime.ts';
import {
    retainALOutboundPendingAdmission,
    type ALOutboundPendingAdmission,
    type RetainALOutboundPendingAdmissionInput
} from './al-outbound-pending-admission.ts';
import {
    decodeALOutboundWorkEntry,
    isPendingALOutboundWork,
    toALOutboundWorkKey
} from './al-outbound-work-entry.ts';
import type { ALOutboundComputeIntent } from './compute-al-outbound-dispatch.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundPendingAckExpireAtTimestamp
} from './transition-al-outbound-pending-ack.ts';
import { validateALOutboundPlannedMessage } from './validate-al-outbound-dispatch.ts';

export interface CreateALOutboundAdmissionStoreInput {
    readonly nowMs?: () => number;
    readonly canonicalScope?: string;
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}
export type {
    ClaimALOutboundEffectsInput,
    RescheduleALOutboundEffectInput
} from './al-outbound-admission-effect-store.ts';

export interface ALOutboundVersionedClientRecord {
    readonly senderId: string;
    readonly version: number;
}

export type ALOutboundPreparedMessageDecoder<TPrepared> = (value: unknown, msg: ALMessage) => TPrepared;

export type ALOutboundPlanner<TPrepared> = (
    msg: ALMessage
) => ALOutboundDispatchPlan<TPrepared>;

export interface ALOutboundOutgoingReadInput<TPrepared> {
    readonly msg: ALMessage;
    readonly planner: ALOutboundPlanner<TPrepared>;
    readonly observedCanonicalEntry: ResourceEntry | undefined;
    readonly intent: ALOutboundComputeIntent;
}

interface ALOutboundCommitCandidate<TPrepared> {
    readonly executionExpiresAtMs: number | null;
    readonly bundle: ALOutboundCommitBundle<TPrepared>;
    readonly effects: readonly ALOutboundEffectCandidate<TPrepared>[];
    readonly canonicalWrites: readonly ALOutboundCanonicalFactWrite[];
    readonly mutations: readonly ALOutboundStateWrite[];
    readonly versionExpireAt: number;
}

export interface ALOutboundSupersedenceReadState {
    readonly key?: string;
    readonly latest?: ALLatestSupersedenceValue;
    readonly replacement?: ALReplacementSupersedenceValue;
}

export interface ALOutboundMessageReadDto<TPrepared> {
    readonly kind: 'outgoing';
    readonly storedMessage: ALStoredOutboundMessage | undefined;
    readonly canonicalScope: string;
    readonly canonicalEntry: ResourceEntry | undefined;
    readonly creationExpiry: string;
    readonly originalMsg: ALMessage;
    readonly msg: ALMessage;
    readonly nowMs: number;
    readonly clientRecord?: ALOutboundVersionedClientRecord;
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly sentSnapshot?: ALOutboundSentMessageSnapshot;
    readonly pendingAck?: ALOutboundPendingAckSnapshot;
    readonly repairAttempt?: ALOutboundRepairAttemptSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
    readonly repairs: readonly ALRepairPayload[];
    readonly supersedence: ALOutboundSupersedenceReadState;
    readonly supersedenceAcceptance?: ALSupersedenceAcceptance;
}

export interface ALOutboundRepairReadDto<TPrepared> {
    readonly kind: 'repair';
    readonly msgId: string;
    readonly nowMs: number;
    readonly clientRecord?: ALOutboundVersionedClientRecord;
    readonly sentSnapshot?: ALOutboundSentMessageSnapshot;
    readonly pendingAck?: ALOutboundPendingAckSnapshot;
    readonly repairAttempt?: ALOutboundRepairAttemptSnapshot;
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
    readonly plan?: ALOutboundDispatchPlan<TPrepared>;
}

export type ALOutboundAdmissionMutation =
    | Readonly<
        { kind: 'set-ordering-message'; trackKey: string; seq: number; msgId: string; expireAtTimestamp: number; }
    >
    | Readonly<{
        kind: 'set-msg-owner';
        msgId: string;
        senderId: string;
        expireAtTimestamp?: number;
    }>
    | Readonly<{
        kind: 'set-sent-message';
        reference: ALOutboundMessageReference;
        policy: ALOutboundCapturedPolicy;
        creationExpiry: string;
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
        expected: ALLatestSupersedenceValue | undefined;
        value: ALLatestSupersedenceValue;
    }>
    | Readonly<{
        kind: 'set-supersedence-replacement';
        msgId: string;
        value: ALReplacementSupersedenceValue;
    }>;

export interface ALOutboundRepairHint {
    readonly trigger: ALOutboundRepairTrigger;
    readonly requestedByPeerId?: string;
    readonly failedPeerIds: readonly string[];
    readonly orderingTrackKey?: string;
    readonly missingSeqs: readonly number[];
}

export type ALOutboundDurableEffect<TPrepared> =
    | ALOutboundPendingAdmission<TPrepared>
    | Readonly<{
        kind: 'send-prepared';
        message: ALOutboundMessageReference;
        prepared: TPrepared;
        preparedFingerprint: string;
        attemptIdentity: string;
        phase: ALOutboundDispatchPhase;
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

export interface ALOutboundDurableEffectWrite<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly retryAtMs?: number;
    readonly expireAtTimestamp?: number;
}

export interface ALOutboundEffectSnapshot<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly canonicalMessage: ALMessage | undefined;
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly retryAtMs: number;
    readonly leaseUntilMs: number | undefined;
    readonly expireAtTimestamp: number;
}

export interface ALClaimedOutboundEffect<TPrepared> extends ALOutboundEffectSnapshot<TPrepared> {
    readonly leaseUntilMs: number;
}

export interface ALOutboundCommitBundle<TPrepared> {
    readonly pendingAdmission?: ResourceEntry;
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly canonicalEntry?: ResourceEntry;
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

interface ALOutboundStateWrite {
    readonly key: string;
    readonly value:
        | string
        | ALStoredOutboundMessage
        | ALOutboundPendingAckSnapshot
        | ALOutboundRepairAttemptSnapshot
        | ALLatestSupersedenceValue
        | ALReplacementSupersedenceValue
        | undefined;
    readonly expireAtTimestamp: number | undefined;
    readonly supersedenceGuard: { readonly expected: ALLatestSupersedenceValue | undefined; } | undefined;
}

export interface ALOutboundControlAcceptance {
    readonly handled: boolean;
}

export interface ALOutboundNotYetInSyncRetrySchedule {
    readonly senderId: string;
    readonly expectedVersion: number | undefined;
    readonly msgId: string;
    readonly maxAttempts: number;
    readonly expireAtTimestamp: number | undefined;
    readonly retryAtMs: number;
}

interface ALOutboundRetryScheduleAttempt<TPrepared> {
    readonly schedule: ALOutboundNotYetInSyncRetrySchedule;
    readonly effect: ALOutboundDurableEffectWrite<TPrepared>;
    readonly attempts: number;
    readonly nowMs: number;
}

export type ALOutboundNotYetInSyncRetryScheduleResult =
    | Readonly<{ status: 'scheduled'; retryAtMs: number; }>
    | Readonly<{ status: 'pending'; retryAtMs: number; }>
    | Readonly<{ status: 'exhausted'; }>
    | Readonly<{ status: 'conflict'; }>;

export interface ALOutboundAdmissionStore extends ALReadyable {
    readonly workQueue: QueueBoxResourceEntryRepository;
    readonly namespace: string;
    readonly canonicalScope: string;
    readOutgoingMessage<TPrepared>(
        input: ALOutboundOutgoingReadInput<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>>;

    readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>>;

    isMessageSuperseded(msg: ALMessage): Promise<boolean>;

    readSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined>;

    readSentMessageByOrdering(trackKey: string, seq: number): Promise<ALOutboundSentMessageSnapshot | undefined>;

    readReceiptState(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    readPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<'committed' | 'conflict' | 'expired'>;

    retainPendingAdmission<TPrepared>(
        input: RetainALOutboundPendingAdmissionInput<TPrepared>
    ): Promise<'pending' | 'conflict' | 'expired'>;

    acceptControlMessage<TPrepared>(
        msg: ALMessage,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance>;

    scheduleNotYetInSyncRetry<TPrepared>(
        schedule: ALOutboundNotYetInSyncRetrySchedule,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundNotYetInSyncRetryScheduleResult>;

    claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALClaimedOutboundEffect<TPrepared>[]>;

    completeEffect(reservation: ResourceEntry): Promise<void>;

    rejectEffect(reservation: ResourceEntry): Promise<void>;

    rescheduleEffect(input: RescheduleALOutboundEffectInput): Promise<void>;

    peekNextEffectReadyAt(): Promise<number | undefined>;
}

export function createALOutboundAdmissionStore(
    input: CreateALOutboundAdmissionStoreInput
): ALOutboundAdmissionStore {
    return new ProviderBackedALOutboundAdmissionStore(input);
}

class ProviderBackedALOutboundAdmissionStore implements ALOutboundAdmissionStore {
    readonly namespace: string;
    readonly canonicalScope: string;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly nowMs: () => number;
    private readonly effectStore: ALOutboundAdmissionEffectStore;
    private readonly controlStore: ALOutboundAdmissionControlStore;

    constructor(
        input: CreateALOutboundAdmissionStoreInput
    ) {
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope ?? input.namespace;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
        this.nowMs = input.nowMs ?? Date.now;
        this.effectStore = new ALOutboundAdmissionEffectStore({
            nowMs: this.nowMs,
            canonicalScope: this.canonicalScope,
            backend: input.backend,
            namespace: input.namespace,
            retention: input.retention
        });
        this.controlStore = new ALOutboundAdmissionControlStore({
            nowMs: this.nowMs,
            backend: input.backend,
            effectStore: this.effectStore,
            namespace: input.namespace,
            retention: input.retention
        });
    }

    get workQueue(): QueueBoxResourceEntryRepository {
        return this.backend.workQueue;
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readOutgoingMessage<TPrepared>(
        input: ALOutboundOutgoingReadInput<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const { msg, observedCanonicalEntry } = input;
        const nowMs = this.nowMs();
        const clientRecord = await this.backend.read(
            this.toVersionKey(msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
        );
        const stored = await this.backend.read(
            this.toSentMessageKey(msg.id.msgId),
            (value) => decodeALOutboundSentMessage(value, msg.id.msgId)
        );
        const { entry: canonicalEntry, message: canonical, creationExpiry } = await readALOutboundCanonicalMessage({
            nowMs: this.nowMs,
            queue: this.workQueue,
            scope: this.canonicalScope,
            message: msg,
            stored,
            observedEntry: observedCanonicalEntry
        });
        const plan = this.readDispatchPlan(input, canonical, stored);
        const supersedenceInput = toSupersedenceInput(msg, plan);
        const supersedence = await this.readSupersedenceState(supersedenceInput?.key, msg.id.msgId);
        const sentSnapshot = stored && canonical && stored.reference.expiresAtMs > this.nowMs()
            ? {
                msgId: stored.msgId,
                msg: canonical,
                outboxKey: stored.reference.key,
                supersedenceKey: stored.supersedenceKey
            }
            : undefined;

        return {
            kind: 'outgoing',
            storedMessage: stored,
            canonicalScope: this.canonicalScope,
            canonicalEntry,
            creationExpiry: creationExpiry ?? stored?.creationExpiry ??
                captureALOutboundCreationExpiry(msg),
            originalMsg: msg,
            msg: plan.msg,
            nowMs,
            clientRecord,
            plan,
            sentSnapshot,
            ...await this.readControlTracking(msg.id.msgId),
            repairs: await this.controlStore.readRepairs(msg.id.msgId),
            supersedence,
            supersedenceAcceptance: supersedenceInput
                ? acceptALSupersedenceObservation({
                    supersedence: supersedenceInput,
                    latest: supersedence.latest,
                    replacement: supersedence.replacement,
                    nowMs,
                    trackTtlMs: this.supersedenceTrackTtlMs
                })
                : undefined
        };
    }

    private readDispatchPlan<TPrepared>(
        input: ALOutboundOutgoingReadInput<TPrepared>,
        canonical: ALMessage | undefined,
        stored: ALStoredOutboundMessage | undefined
    ): ALOutboundDispatchPlan<TPrepared> {
        const { msg, planner, intent } = input;
        const selected = planner(canonical ?? msg);
        const selectedValidation = validateALOutboundPlannedMessage(canonical ?? msg, selected.msg);
        if (selectedValidation.length > 0) {
            throw new NonRetryableException(selectedValidation.map((issue) => issue.message).join('; '));
        }
        const planned = canonical ? { ...selected, msg: canonical } : selected;
        const plan = stored && intent !== 'repair' ? applyALOutboundCapturedPolicy(planned, stored.policy) : planned;
        const messageValidation = validateALOutboundPlannedMessage(msg, plan.msg);
        if (messageValidation.length > 0) {
            throw new NonRetryableException(messageValidation.map((issue) => issue.message).join('; '));
        }
        return plan;
    }

    async readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        const senderObservation = await this.backend.read(
            this.toSentMessageKey(msgId),
            (value) => decodeALOutboundSentMessage(value, msgId)
        );
        const senderId = senderObservation?.reference.senderId;
        const clientRecord = senderId
            ? await this.backend.read(
                this.toVersionKey(senderId),
                (value) => decodeALAdmissionClientRecord(value, senderId)
            )
            : undefined;
        const stored = senderId
            ? await this.backend.read(
                this.toSentMessageKey(msgId),
                (value) => decodeALOutboundSentMessage(value, msgId)
            )
            : undefined;
        const sentSnapshot = await this.readCanonicalSentMessage(msgId, stored);
        const msg = sentSnapshot?.msg;
        const plan = msg && stored ? applyALOutboundCapturedPolicy(planner(msg), stored.policy) : undefined;
        if (msg && plan) {
            const messageValidation = validateALOutboundPlannedMessage(msg, plan.msg);
            if (messageValidation.length > 0) {
                throw new NonRetryableException(messageValidation.map((issue) => issue.message).join('; '));
            }
        }
        return {
            kind: 'repair',
            msgId,
            nowMs: this.nowMs(),
            clientRecord,
            sentSnapshot,
            ...await this.readControlTracking(msgId),
            plan
        };
    }

    private async readControlTracking(
        msgId: string
    ): Promise<Pick<ALOutboundRepairReadDto<never>, 'pendingAck' | 'repairAttempt' | 'acks' | 'nacks'>> {
        return {
            pendingAck: await this.readPendingAck(msgId),
            repairAttempt: await this.backend.read(
                this.toRepairAttemptKey(msgId),
                (value) => decodeALOutboundRepairAttempt(value, msgId)
            ),
            acks: await this.controlStore.readAcks(msgId),
            nacks: await this.controlStore.readNacks(msgId)
        };
    }

    async isMessageSuperseded(msg: ALMessage): Promise<boolean> {
        const stored = await this.backend.read(
            this.toSentMessageKey(msg.id.msgId),
            (value) => decodeALOutboundSentMessage(value, msg.id.msgId)
        );
        const tracking = stored?.policy.supersedenceTracking;
        if (!tracking?.enabled || !tracking.key) {
            return false;
        }
        const read = await this.readSupersedenceState(tracking.key, msg.id.msgId);
        return computeALSupersedenceObservation({
            supersedence: {
                key: tracking.key,
                msgId: msg.id.msgId,
                replacesMsgId: tracking.replacesMsgId,
                seq: msg.ordering?.seq,
                ts: msg.audit?.createdTs ?? msg.id.ts
            },
            latest: read.latest,
            replacement: read.replacement,
            nowMs: this.nowMs(),
            trackTtlMs: this.supersedenceTrackTtlMs
        }).status === 'superseded';
    }

    async readSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined> {
        const stored = await this.backend.read(
            this.toSentMessageKey(msgId),
            (value) => decodeALOutboundSentMessage(value, msgId)
        );
        return await this.readCanonicalSentMessage(msgId, stored);
    }

    private async readCanonicalSentMessage(
        msgId: string,
        stored: ALStoredOutboundMessage | undefined
    ): Promise<ALOutboundSentMessageSnapshot | undefined> {
        if (!stored || stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        if (stored.reference.scope !== this.canonicalScope) {
            throw new ALAdmissionCorruptionError(
                this.toSentMessageKey(msgId),
                new TypeError('Sent message belongs to another local scope')
            );
        }
        const canonical = await this.backend.workQueue.getItem(stored.reference.key);
        const identity = await this.backend.workQueue.getItem(toALOutboundIdentityKey(stored.reference.key));
        if (stored.reference.expiresAtMs <= this.nowMs()) {
            return undefined;
        }
        const msg = decodeALOutboundCanonicalMessage(stored.reference, canonical, identity);
        return { msgId, msg, outboxKey: stored.reference.key, supersedenceKey: stored.supersedenceKey };
    }

    async readSentMessageByOrdering(trackKey: string, seq: number): Promise<ALOutboundSentMessageSnapshot | undefined> {
        const msgId = await this.backend.read(this.toOrderingMessageKey(trackKey, seq), decodeALAdmissionString);
        const sent = msgId ? await this.readSentMessage(msgId) : undefined;
        if (sent && (toALOrderingTrackKey(sent.msg) !== trackKey || sent.msg.ordering?.seq !== seq)) {
            throw new ALAdmissionCorruptionError(
                this.toOrderingMessageKey(trackKey, seq),
                new TypeError('Ordering index differs from canonical message')
            );
        }
        return sent;
    }

    async readPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        const receipts = await this.readReceiptState(msgId);
        return receipts && !isALOutboundReceiptComplete(receipts) ? receipts : undefined;
    }

    async readReceiptState(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
        return await this.backend.read(
            this.toPendingAckKey(msgId),
            (value) => decodeALOutboundPendingAck(value, msgId)
        );
    }

    async commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<'committed' | 'conflict' | 'expired'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

        const nowMs = this.nowMs();
        const observations = await this.effectStore.readEffects(
            bundle.durableEffects,
            decodePrepared,
            bundle.canonicalEntry
        );
        const effects = this.effectStore.computeEffects(observations, nowMs);
        const validated = this.effectStore.validateEffects(effects);
        if (validated.length > 0) {
            throw validated[0];
        }
        const canonicalWrites = bundle.canonicalEntry
            ? await readALOutboundCanonicalWrites({
                queue: this.workQueue,
                scope: this.canonicalScope,
                entry: bundle.canonicalEntry,
                creationExpiry: bundle.mutations.find((mutation) =>
                    mutation.kind === 'set-sent-message'
                )?.creationExpiry ??
                    captureALOutboundCreationExpiry(decodePersistedALMessage(bundle.canonicalEntry.resource)),
                activatePendingCanonical: bundle.pendingAdmission !== undefined,
                nowMs: this.nowMs
            })
            : [];
        const writeAtMs = this.nowMs();
        if (
            (bundle.canonicalEntry && bundle.canonicalEntry.audit.expiryTs.epochMilliseconds <= writeAtMs) ||
            effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= writeAtMs)
        ) {
            return 'expired';
        }
        return await this.writeCommit({
            bundle,
            effects,
            executionExpiresAtMs: bundle.canonicalEntry?.audit.expiryTs.epochMilliseconds ??
                (effects.length > 0
                    ? Math.min(...effects.map((effect) => effect.entry.audit.expiryTs.epochMilliseconds))
                    : null),
            canonicalWrites,
            mutations: bundle.mutations.map((mutation) => this.computeMutation(mutation, nowMs)),
            versionExpireAt: nowMs + this.retention.versionTtlMs
        });
    }

    private async writeCommit<TPrepared>(
        candidate: ALOutboundCommitCandidate<TPrepared>
    ): Promise<'committed' | 'conflict' | 'expired'> {
        const { bundle, effects, mutations, canonicalWrites, versionExpireAt } = candidate;
        const version = { senderId: bundle.senderId, version: (bundle.expectedVersion ?? 0) + 1 };
        try {
            return await this.backend.write(async (tx) => {
                const current = await tx.read(
                    this.toVersionKey(bundle.senderId),
                    (value) => decodeALAdmissionClientRecord(value, bundle.senderId)
                );
                const currentVersion = current?.version;
                if (currentVersion !== bundle.expectedVersion) {
                    return 'conflict';
                }

                if (bundle.pendingAdmission) {
                    const pending = await tx.readWork(bundle.pendingAdmission.key);
                    if (!pending || !hasSameResourceEntryValue(pending, bundle.pendingAdmission)) {
                        return 'conflict';
                    }
                }

                await this.effectStore.assertObservations(tx, effects);
                await this.assertMutationObservations(tx, mutations);
                await this.assertMessageIdentities(tx, bundle.mutations);
                const eligibilityAtMs = this.nowMs();
                if (
                    (bundle.canonicalEntry &&
                        bundle.canonicalEntry.audit.expiryTs.epochMilliseconds <= eligibilityAtMs) ||
                    effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= eligibilityAtMs)
                ) {
                    return 'expired';
                }
                if (await writeALOutboundCanonicalFacts(tx, canonicalWrites, this.nowMs) === 'expired') {
                    return 'expired';
                }
                this.effectStore.writeEffects(tx, effects);
                for (const mutation of mutations) {
                    await this.applyMutation(tx, mutation);
                }

                await tx.set(this.toVersionKey(bundle.senderId), version, versionExpireAt);
                return 'committed';
            }, candidate.executionExpiresAtMs);
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

    async retainPendingAdmission<TPrepared>(
        input: RetainALOutboundPendingAdmissionInput<TPrepared>
    ): Promise<'pending' | 'conflict' | 'expired'> {
        return await retainALOutboundPendingAdmission({
            backend: this.backend,
            namespace: this.namespace,
            nowMs: this.nowMs
        }, input);
    }

    async acceptControlMessage<TPrepared>(
        msg: ALMessage,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance> {
        return await this.controlStore.acceptControlMessage(msg, decodePrepared);
    }

    async scheduleNotYetInSyncRetry<TPrepared>(
        schedule: ALOutboundNotYetInSyncRetrySchedule,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundNotYetInSyncRetryScheduleResult> {
        const nowMs = this.nowMs();
        const retry = await this.backend.read(
            this.toNotYetInSyncRetryKey(schedule.msgId),
            (value) => decodeALOutboundNotYetInSyncRetry(value, schedule.msgId)
        );
        const existing = retry
            ? await this.backend.workQueue.getItem(
                toALOutboundWorkKey(this.namespace, retry.pendingEffectId)
            )
            : undefined;
        if (existing !== undefined && isPendingALOutboundWork(existing)) {
            const pending = decodeALOutboundWorkEntry(existing, this.namespace, { decodePrepared, message: undefined });
            if (pending.payload.kind !== 'nack-retry' || pending.payload.msgId !== schedule.msgId) {
                throw new ALAdmissionCorruptionError(
                    this.toNotYetInSyncRetryKey(schedule.msgId),
                    new TypeError('Persisted retry points to another effect')
                );
            }
            return { status: 'pending', retryAtMs: pending.retryAtMs };
        }
        const attempts = retry?.attempts ?? 0;
        if (attempts >= schedule.maxAttempts) {
            return { status: 'exhausted' };
        }
        const effect: ALOutboundDurableEffectWrite<TPrepared> = {
            effectId: toALOutboundEffectId(['nack-retry', schedule.msgId, 'not-yet-in-sync', attempts + 1]),
            retryAtMs: schedule.retryAtMs,
            expireAtTimestamp: schedule.expireAtTimestamp,
            payload: { kind: 'nack-retry', msgId: schedule.msgId, reason: 'not-yet-in-sync' }
        };
        const result = await this.commitRetrySchedule(
            { schedule, effect, attempts: attempts + 1, nowMs },
            decodePrepared
        );
        return result;
    }

    private async commitRetrySchedule<TPrepared>(
        { schedule, effect, attempts, nowMs }: ALOutboundRetryScheduleAttempt<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundNotYetInSyncRetryScheduleResult> {
        const observations = await this.effectStore.readEffects([effect], decodePrepared);
        const candidates = this.effectStore.computeEffects(observations, nowMs);
        const validated = this.effectStore.validateEffects(candidates);
        if (validated.length > 0) {
            throw validated[0];
        }
        const retry = { msgId: schedule.msgId, attempts, pendingEffectId: effect.effectId };
        const expireAt = schedule.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs;
        const version = { senderId: schedule.senderId, version: (schedule.expectedVersion ?? 0) + 1 };
        const versionExpireAt = nowMs + this.retention.versionTtlMs;
        if (expireAt <= this.nowMs()) {
            return { status: 'exhausted' };
        }
        try {
            return await this.backend.write(async (tx) => {
                const current = await tx.read(
                    this.toVersionKey(schedule.senderId),
                    (value) => decodeALAdmissionClientRecord(value, schedule.senderId)
                );
                if (current?.version !== schedule.expectedVersion) {
                    return { status: 'conflict' };
                }
                await this.effectStore.assertObservations(tx, candidates);
                if (expireAt <= this.nowMs()) {
                    return { status: 'exhausted' };
                }
                this.effectStore.writeEffects(tx, candidates);
                await tx.set(this.toNotYetInSyncRetryKey(schedule.msgId), retry, expireAt);
                await tx.set(this.toVersionKey(schedule.senderId), version, versionExpireAt);
                return { status: 'scheduled', retryAtMs: schedule.retryAtMs };
            });
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return { status: 'conflict' };
            }
            throw error;
        }
    }

    async claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALClaimedOutboundEffect<TPrepared>[]> {
        return await this.effectStore.claimReadyEffects(input, decodePrepared);
    }

    async rejectEffect(reservation: ResourceEntry): Promise<void> {
        await this.effectStore.rejectEffect(reservation);
    }

    async completeEffect(reservation: ResourceEntry): Promise<void> {
        await this.effectStore.completeEffect(reservation);
    }

    async rescheduleEffect(input: RescheduleALOutboundEffectInput): Promise<void> {
        await this.effectStore.rescheduleEffect(input);
    }

    async peekNextEffectReadyAt(): Promise<number | undefined> {
        return await this.effectStore.peekNextReadyAt();
    }

    private async readSupersedenceState(
        key: string | undefined,
        msgId: string
    ): Promise<ALOutboundSupersedenceReadState> {
        if (!key) {
            return {};
        }

        return {
            key,
            latest: await this.backend.read(
                this.toSupersedenceLatestKey(key),
                (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
            ),
            replacement: await this.backend.read(
                this.toSupersedenceReplacementKey(msgId),
                (value) => decodeALAdmissionSupersedenceValue(value, 'replacement')
            )
        };
    }

    private computeMutation(mutation: ALOutboundAdmissionMutation, nowMs: number): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-ordering-message':
                return {
                    key: this.toOrderingMessageKey(mutation.trackKey, mutation.seq),
                    value: mutation.msgId,
                    expireAtTimestamp: mutation.expireAtTimestamp,
                    supersedenceGuard: undefined
                };
            case 'set-msg-owner':
                return {
                    key: this.toMsgOwnerKey(mutation.msgId),
                    value: mutation.senderId,
                    expireAtTimestamp: Math.max(
                        mutation.expireAtTimestamp ?? 0,
                        nowMs + this.retention.msgOwnerTtlMs,
                        nowMs + this.retention.controlHistoryTtlMs
                    ),
                    supersedenceGuard: undefined
                };
            case 'set-sent-message':
                return this.computeSentMessageMutation(mutation, nowMs);
            case 'set-repair-attempt':
                return {
                    key: this.toRepairAttemptKey(mutation.snapshot.msgId),
                    value: mutation.snapshot,
                    expireAtTimestamp: mutation.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs,
                    supersedenceGuard: undefined
                };
            case 'set-pending-ack':
                return {
                    key: this.toPendingAckKey(mutation.snapshot.msgId),
                    value: mutation.snapshot,
                    expireAtTimestamp: mutation.expireAtTimestamp ??
                        toALOutboundPendingAckExpireAtTimestamp(mutation.snapshot),
                    supersedenceGuard: undefined
                };
            case 'delete-sent-message':
            case 'delete-pending-ack':
            case 'delete-repair-attempt':
                return {
                    key: mutation.kind === 'delete-sent-message'
                        ? this.toSentMessageKey(mutation.msgId)
                        : mutation.kind === 'delete-pending-ack'
                        ? this.toPendingAckKey(mutation.msgId)
                        : this.toRepairAttemptKey(mutation.msgId),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'set-supersedence-latest':
            case 'set-supersedence-replacement':
                return this.computeSupersedenceMutation(mutation);
        }
    }

    private computeSentMessageMutation(
        mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-sent-message'; }>,
        nowMs: number
    ): ALOutboundStateWrite {
        return {
            key: this.toSentMessageKey(mutation.snapshot.msgId),
            value: {
                msgId: mutation.snapshot.msgId,
                reference: mutation.reference,
                supersedenceKey: mutation.snapshot.supersedenceKey,
                unicastPeerId: mutation.snapshot.msg.targets?.mode === 'unicast'
                    ? mutation.snapshot.msg.targets.toPeerId
                    : null,
                orderingTrackKey: toALOrderingTrackKey(mutation.snapshot.msg) ?? null,
                orderingSeq: mutation.snapshot.msg.ordering?.seq ?? null,
                policy: mutation.policy,
                creationExpiry: mutation.creationExpiry
            },
            expireAtTimestamp: Math.max(
                mutation.expireAtTimestamp ?? 0,
                nowMs + this.retention.sentMessageTtlMs,
                nowMs + this.retention.controlHistoryTtlMs
            ),
            supersedenceGuard: undefined
        };
    }

    private computeSupersedenceMutation(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'set-supersedence-latest' | 'set-supersedence-replacement'; }
        >
    ): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-supersedence-latest':
                return {
                    key: this.toSupersedenceLatestKey(mutation.supersedenceKey),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: { expected: mutation.expected }
                };
            case 'set-supersedence-replacement':
                return {
                    key: this.toSupersedenceReplacementKey(mutation.msgId),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: undefined
                };
        }
    }

    private async assertMessageIdentities(
        tx: ALAdmissionWorkWriteContext,
        mutations: readonly ALOutboundAdmissionMutation[]
    ): Promise<void> {
        for (const mutation of mutations) {
            if (mutation.kind === 'set-msg-owner') {
                const key = this.toMsgOwnerKey(mutation.msgId);
                const owner = await tx.read(key, decodeALAdmissionString);
                if (owner !== undefined && owner !== mutation.senderId) {
                    throw new ALAdmissionCorruptionError(key, new TypeError('Message id belongs to another sender'));
                }
            }
            if (mutation.kind === 'set-sent-message') {
                const key = this.toSentMessageKey(mutation.snapshot.msgId);
                const sent = await tx.read(key, (value) => decodeALOutboundSentMessage(value, mutation.snapshot.msgId));
                if (
                    mutation.reference.scope !== this.canonicalScope ||
                    (sent !== undefined && !jsonEquals(sent.reference, mutation.reference))
                ) {
                    throw new ALAdmissionCorruptionError(
                        key,
                        new TypeError('Message id has conflicting canonical identity')
                    );
                }
            }
        }
    }

    private async assertMutationObservations(
        tx: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<void> {
        for (const write of writes) {
            if (write.supersedenceGuard === undefined) {
                continue;
            }
            const current = await tx.read(write.key, (value) => decodeALAdmissionSupersedenceValue(value, 'latest'));
            if (!jsonEquals(current, write.supersedenceGuard.expected)) {
                throw new ALAdmissionBackendConflictError('Outbound shared supersedence observation changed');
            }
        }
    }

    private async applyMutation(tx: ALAdmissionWorkWriteContext, write: ALOutboundStateWrite): Promise<void> {
        if (write.value === undefined) {
            await tx.remove(write.key);
        }
        else {
            await tx.set(write.key, write.value, write.expireAtTimestamp);
        }
    }

    private toOrderingMessageKey(trackKey: string, seq: number): string {
        return `${this.namespace}:ordering-message:${JSON.stringify([trackKey, seq])}`;
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

    private toNotYetInSyncRetryKey(msgId: string): string {
        return `${this.namespace}:not-yet-in-sync-retry:${msgId}`;
    }

    private toSupersedenceLatestKey(key: string): string {
        return `${this.namespace}:supersedence:latest:${key}`;
    }

    private toSupersedenceReplacementKey(msgId: string): string {
        return `${this.namespace}:supersedence:replacement:${msgId}`;
    }
}

function toSupersedenceInput<TPrepared>(
    msg: ALMessage,
    plan: ALOutboundDispatchPlan<TPrepared>
): ALSupersedenceInput | undefined {
    const tracking = plan.supersedenceTracking;
    return tracking?.enabled && tracking.key
        ? {
            key: tracking.key,
            msgId: msg.id.msgId,
            replacesMsgId: tracking.replacesMsgId,
            seq: msg.ordering?.seq,
            ts: msg.audit?.createdTs ?? msg.id.ts
        }
        : undefined;
}
