import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import type {
    ALReadyable,
    ALSupersedenceInput
} from '../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { Key, ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import { decodeALAdmissionClientRecord, decodeALAdmissionSupersedenceValue } from '../al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from '../al-admission-work-backend.ts';
import type {
    ALOutboundNotYetInSyncRetrySnapshot,
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import {
    acceptALSupersedenceObservation,
    type ALLatestSupersedenceValue,
    type ALReplacementSupersedenceValue,
    type ALSupersedenceAcceptance
} from '../compute-al-supersedence-observation.ts';
import { ALOutboundAdmissionControlStore } from './al-outbound-admission-control-store.ts';
import {
    ALOutboundAdmissionEffectStore,
    type ClaimALOutboundEffectsInput,
    type RescheduleALOutboundEffectInput
} from './al-outbound-admission-effect-store.ts';
import {
    decodeALOutboundNotYetInSyncRetry,
    decodeALOutboundPendingAck,
    decodeALOutboundRepairAttempt,
    decodeALOutboundSentMessage
} from './al-outbound-admission-validation.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundRepairTrigger
} from './al-outbound-message-runtime.ts';
import { decodeALOutboundWorkEntry, isPendingALOutboundWork, toALOutboundWorkKey } from './al-outbound-work-entry.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from './transition-al-outbound-pending-ack.ts';
import { validateALOutboundPlannedMessage } from './validate-al-outbound-dispatch.ts';

export interface CreateALOutboundAdmissionStoreInput {
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

export interface ALOutboundSupersedenceReadState {
    readonly key?: string;
    readonly latest?: ALLatestSupersedenceValue;
    readonly replacement?: ALReplacementSupersedenceValue;
}

export interface ALOutboundMessageReadDto<TPrepared> {
    readonly kind: 'outgoing';
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
    readonly priorOutboxKey?: Key;
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
    | Readonly<{
        kind: 'set-msg-owner';
        msgId: string;
        senderId: string;
        expireAtTimestamp?: number;
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
    | Readonly<{
        kind: 'send-prepared';
        msg: ALMessage;
        prepared: TPrepared;
        preparedFingerprint: string;
        phase: ALOutboundDispatchPhase;
    }>
    | Readonly<{
        kind: 'enqueue-outbox';
        msg: ALMessage;
        entry: ResourceEntry;
        replaceExisting: boolean;
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
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

interface ALOutboundStateWrite {
    readonly key: string;
    readonly value:
        | string
        | ALOutboundSentMessageSnapshot
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
    readOutgoingMessage<TPrepared>(
        msg: ALMessage,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>>;

    readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>>;

    getSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined>;

    getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]>;

    readReceiptState(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    getPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<'committed' | 'conflict' | 'expired'>;

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
    private readonly namespace: string;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionWorkBackend;
    private readonly effectStore: ALOutboundAdmissionEffectStore;
    private readonly controlStore: ALOutboundAdmissionControlStore;

    constructor(
        input: CreateALOutboundAdmissionStoreInput
    ) {
        this.namespace = input.namespace;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.retention = input.retention;
        this.backend = input.backend;
        this.effectStore = new ALOutboundAdmissionEffectStore({
            backend: input.backend,
            namespace: input.namespace,
            retention: input.retention
        });
        this.controlStore = new ALOutboundAdmissionControlStore({
            backend: input.backend,
            effectStore: this.effectStore,
            namespace: input.namespace,
            retention: input.retention
        });
    }

    async ready(): Promise<void> {
        await this.backend.ready();
    }

    async readOutgoingMessage<TPrepared>(
        msg: ALMessage,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const nowMs = Date.now();
        const plan = planner(msg);
        const messageValidation = validateALOutboundPlannedMessage(msg, plan.msg);
        if (messageValidation.left) {
            throw new NonRetryableException(messageValidation.left.message);
        }
        const clientRecord = await this.backend.read(
            this.toVersionKey(msg.id.senderId),
            (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
        );
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
            originalMsg: msg,
            msg: plan.msg,
            nowMs,
            clientRecord,
            plan,
            sentSnapshot,
            pendingAck: await this.getPendingAck(msg.id.msgId),
            repairAttempt: await this.backend.read(
                this.toRepairAttemptKey(msg.id.msgId),
                (value) => decodeALOutboundRepairAttempt(value, msg.id.msgId)
            ),
            acks: await this.controlStore.readAcks(msg.id.msgId),
            nacks: await this.controlStore.readNacks(msg.id.msgId),
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
                : undefined,
            priorOutboxKey: sentSnapshot?.outboxKey ?? replacedSnapshot?.outboxKey ?? latestSnapshot?.outboxKey
        };
    }

    async readRepairMessage<TPrepared>(
        msgId: string,
        planner: ALOutboundPlanner<TPrepared>
    ): Promise<ALOutboundRepairReadDto<TPrepared>> {
        const discovered = await this.getSentMessage(msgId);
        const senderId = discovered?.msg.id.senderId;
        const clientRecord = senderId
            ? await this.backend.read(
                this.toVersionKey(senderId),
                (value) => decodeALAdmissionClientRecord(value, senderId)
            )
            : undefined;
        const sentSnapshot = senderId ? await this.getSentMessage(msgId) : undefined;
        const msg = sentSnapshot?.msg;
        const plan = msg ? planner(msg) : undefined;
        if (msg && plan) {
            const messageValidation = validateALOutboundPlannedMessage(msg, plan.msg);
            if (messageValidation.left) {
                throw new NonRetryableException(messageValidation.left.message);
            }
        }
        return {
            kind: 'repair',
            msgId,
            nowMs: Date.now(),
            clientRecord,
            sentSnapshot,
            pendingAck: await this.getPendingAck(msgId),
            repairAttempt: await this.backend.read(
                this.toRepairAttemptKey(msgId),
                (value) => decodeALOutboundRepairAttempt(value, msgId)
            ),
            acks: await this.controlStore.readAcks(msgId),
            nacks: await this.controlStore.readNacks(msgId),
            plan
        };
    }

    async getSentMessage(msgId: string): Promise<ALOutboundSentMessageSnapshot | undefined> {
        return await this.backend.read(
            this.toSentMessageKey(msgId),
            (value) => decodeALOutboundSentMessage(value, msgId)
        );
    }

    async getAllSentMessages(): Promise<readonly ALOutboundSentMessageSnapshot[]> {
        return [
            ...await this.backend.list(
                this.toSentMessagePrefix(),
                (value, key) => decodeALOutboundSentMessage(value, key.slice(this.toSentMessagePrefix().length))
            )
        ]
            .map((entry) => entry.value)
            .sort(
                (left, right) =>
                    (left.msg.audit?.createdTs ?? left.msg.id.ts) -
                    (right.msg.audit?.createdTs ?? right.msg.id.ts)
            );
    }

    async getPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined> {
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

        const nowMs = Date.now();
        const observations = await this.effectStore.readEffects(bundle.durableEffects);
        const effects = this.effectStore.computeEffects(observations, nowMs);
        const validated = this.effectStore.validateEffects(effects, decodePrepared);
        if (validated.left) {
            throw validated.left;
        }
        const writeAtMs = Date.now();
        if (effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= writeAtMs)) {
            return 'expired';
        }
        const mutations = bundle.mutations.map((mutation) => this.computeMutation(mutation, nowMs));
        const version = { senderId: bundle.senderId, version: (bundle.expectedVersion ?? 0) + 1 };
        const versionExpireAt = nowMs + this.retention.versionTtlMs;
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

                await this.effectStore.assertObservations(tx, effects);
                await this.assertMutationObservations(tx, mutations);
                const eligibilityAtMs = Date.now();
                if (effects.some((effect) => effect.entry.audit.expiryTs.epochMilliseconds <= eligibilityAtMs)) {
                    return 'expired';
                }
                this.effectStore.writeEffects(tx, effects);
                for (const mutation of mutations) {
                    await this.applyMutation(tx, mutation);
                }

                await tx.set(this.toVersionKey(bundle.senderId), version, versionExpireAt);
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
        const nowMs = Date.now();
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
            const pending = decodeALOutboundWorkEntry(existing, this.namespace, decodePrepared);
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
        const observations = await this.effectStore.readEffects([effect]);
        const candidates = this.effectStore.computeEffects(observations, nowMs);
        const validated = this.effectStore.validateEffects(candidates, decodePrepared);
        if (validated.left) {
            throw validated.left;
        }
        const retry = { msgId: schedule.msgId, attempts, pendingEffectId: effect.effectId };
        const expireAt = schedule.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs;
        const version = { senderId: schedule.senderId, version: (schedule.expectedVersion ?? 0) + 1 };
        const versionExpireAt = nowMs + this.retention.versionTtlMs;
        if (expireAt <= Date.now()) {
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
                if (expireAt <= Date.now()) {
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
            case 'set-msg-owner':
                return {
                    key: this.toMsgOwnerKey(mutation.msgId),
                    value: mutation.senderId,
                    expireAtTimestamp: mutation.expireAtTimestamp ?? nowMs + this.retention.msgOwnerTtlMs,
                    supersedenceGuard: undefined
                };
            case 'set-sent-message':
                return {
                    key: this.toSentMessageKey(mutation.snapshot.msgId),
                    value: mutation.snapshot,
                    expireAtTimestamp: mutation.expireAtTimestamp ?? nowMs + this.retention.sentMessageTtlMs,
                    supersedenceGuard: undefined
                };
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
                return {
                    key: this.toSentMessageKey(mutation.msgId),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'delete-pending-ack':
                return {
                    key: this.toPendingAckKey(mutation.msgId),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'delete-repair-attempt':
                return {
                    key: this.toRepairAttemptKey(mutation.msgId),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'set-supersedence-latest':
            case 'set-supersedence-replacement':
                return this.computeSupersedenceMutation(mutation);
        }
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
