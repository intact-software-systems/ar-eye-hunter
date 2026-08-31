import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import type {
    ALReadyable,
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedencePersistenceValue
} from '../../al-contracts/al-runtime.ts';
import type { Key, ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { type ALAdmissionBackend, type ALAdmissionWriteContext } from '../al-admission-backend.ts';
import { decodeALAdmissionClientRecord, decodeALAdmissionSupersedenceValue } from '../al-admission-value-validation.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { resolveExpireAtTimestampWithFallback, toExpireAtTimestampFromNow } from '../ALStoreRetention.ts';
import { acceptALSupersedenceObservation } from '../compute-al-supersedence-observation.ts';
import { ALOutboundAdmissionControlStore } from './al-outbound-admission-control-store.ts';
import {
    ALOutboundAdmissionEffectStore,
    type ClaimALOutboundEffectsInput,
    type RescheduleALOutboundEffectInput
} from './al-outbound-admission-effect-store.ts';
import {
    decodeALOutboundPendingAck,
    decodeALOutboundRepairAttempt,
    decodeALOutboundSentMessage
} from './al-outbound-admission-validation.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundRepairTrigger
} from './al-outbound-message-runtime.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from './transition-al-outbound-pending-ack.ts';

export interface CreateALOutboundAdmissionStoreInput {
    readonly namespace: string;
    readonly backend: ALAdmissionBackend;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}
export type {
    ClaimALOutboundEffectsInput,
    RescheduleALOutboundEffectInput
} from './al-outbound-admission-effect-store.ts';

type LatestSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'latest'; }>>;
type ReplacementSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'replacement'; }>>;

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
    readonly latest?: LatestSupersedenceValue;
    readonly replacement?: ReplacementSupersedenceValue;
}

export interface ALOutboundSupersedenceReplacementWrite {
    readonly msgId: string;
    readonly value: ReplacementSupersedenceValue;
}

export interface ALOutboundSupersedenceAcceptance {
    readonly observation: ALSupersedenceObservation;
    readonly latestWrite?: LatestSupersedenceValue;
    readonly replacementWrites: readonly ALOutboundSupersedenceReplacementWrite[];
}

export interface ALOutboundMessageReadDto<TPrepared> {
    readonly kind: 'outgoing';
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
    readonly supersedenceAcceptance?: ALOutboundSupersedenceAcceptance;
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
        value: LatestSupersedenceValue;
    }>
    | Readonly<{
        kind: 'set-supersedence-replacement';
        msgId: string;
        value: ReplacementSupersedenceValue;
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

export interface ALOutboundDurableEffectWrite<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly retryAtMs?: number;
    readonly expireAtTimestamp?: number;
}

export interface ALPersistedOutboundEffect<TPrepared> {
    readonly effectId: string;
    readonly payload: ALOutboundDurableEffect<TPrepared>;
    readonly status: 'pending' | 'running';
    readonly attempts: number;
    readonly retryAtMs: number;
    readonly leaseOwner?: string;
    readonly leaseUntilMs?: number;
    readonly lastError?: string;
    readonly updatedAtMs: number;
    readonly expireAtTimestamp: number;
}

export interface ALOutboundCommitBundle<TPrepared> {
    readonly senderId: string;
    readonly expectedVersion?: number;
    readonly mutations: readonly ALOutboundAdmissionMutation[];
    readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
}

export interface ALOutboundControlAcceptance {
    readonly handled: boolean;
}

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

    getPendingAck(msgId: string): Promise<ALOutboundPendingAckSnapshot | undefined>;

    commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<'committed' | 'conflict'>;

    acceptControlMessage<TPrepared>(
        msg: ALMessage,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance>;

    claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALPersistedOutboundEffect<TPrepared>[]>;

    completeEffect<TPrepared>(
        effectId: string,
        workerId: string,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void>;

    rescheduleEffect<TPrepared>(
        input: RescheduleALOutboundEffectInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void>;

    peekNextEffectReadyAt<TPrepared>(
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<number | undefined>;
}

export function createALOutboundAdmissionStore(
    input: CreateALOutboundAdmissionStoreInput
): ALOutboundAdmissionStore {
    return new ProviderBackedALOutboundAdmissionStore(input);
}

interface CreateProviderBackedALOutboundAdmissionStoreInput {
    readonly namespace: string;
    readonly supersedenceTrackTtlMs: number;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly backend: ALAdmissionBackend;
}

class ProviderBackedALOutboundAdmissionStore implements ALOutboundAdmissionStore {
    private readonly namespace: string;
    private readonly supersedenceTrackTtlMs: number;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly backend: ALAdmissionBackend;
    private readonly effectStore: ALOutboundAdmissionEffectStore;
    private readonly controlStore: ALOutboundAdmissionControlStore;

    constructor(
        input: CreateProviderBackedALOutboundAdmissionStoreInput
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
            clientRecord: await this.backend.read(
                this.toVersionKey(msg.id.senderId),
                (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
            ),
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
        const sentSnapshot = await this.getSentMessage(msgId);
        const msg = sentSnapshot?.msg;
        return {
            kind: 'repair',
            msgId,
            nowMs: Date.now(),
            clientRecord: msg
                ? await this.backend.read(
                    this.toVersionKey(msg.id.senderId),
                    (value) => decodeALAdmissionClientRecord(value, msg.id.senderId)
                )
                : undefined,
            sentSnapshot,
            pendingAck: await this.getPendingAck(msgId),
            repairAttempt: await this.backend.read(
                this.toRepairAttemptKey(msgId),
                (value) => decodeALOutboundRepairAttempt(value, msgId)
            ),
            acks: await this.controlStore.readAcks(msgId),
            nacks: await this.controlStore.readNacks(msgId),
            plan: msg ? planner(msg) : undefined
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
        return await this.backend.read(
            this.toPendingAckKey(msgId),
            (value) => decodeALOutboundPendingAck(value, msgId)
        );
    }

    async commitBundle<TPrepared>(
        bundle: ALOutboundCommitBundle<TPrepared>,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<'committed' | 'conflict'> {
        if (bundle.mutations.length === 0 && bundle.durableEffects.length === 0) {
            return 'committed';
        }

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

                for (const mutation of bundle.mutations) {
                    await this.applyMutation(tx, mutation);
                }

                for (const effect of bundle.durableEffects) {
                    await this.effectStore.persistEffect(tx, effect, decodePrepared);
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

    async acceptControlMessage<TPrepared>(
        msg: ALMessage,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<ALOutboundControlAcceptance> {
        return await this.controlStore.acceptControlMessage(msg, decodePrepared);
    }

    async claimReadyEffects<TPrepared>(
        input: ClaimALOutboundEffectsInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<readonly ALPersistedOutboundEffect<TPrepared>[]> {
        return await this.effectStore.claimReadyEffects(input, decodePrepared);
    }

    async completeEffect<TPrepared>(
        effectId: string,
        workerId: string,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        await this.effectStore.completeEffect(effectId, workerId, decodePrepared);
    }

    async rescheduleEffect<TPrepared>(
        input: RescheduleALOutboundEffectInput,
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<void> {
        await this.effectStore.rescheduleEffect(input, decodePrepared);
    }

    async peekNextEffectReadyAt<TPrepared>(
        decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>
    ): Promise<number | undefined> {
        return await this.effectStore.peekNextReadyAt(decodePrepared);
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

    private async applyMutation(
        tx: ALAdmissionWriteContext,
        mutation: ALOutboundAdmissionMutation
    ): Promise<void> {
        switch (mutation.kind) {
            case 'set-msg-owner':
                return await tx.set(
                    this.toMsgOwnerKey(mutation.msgId),
                    mutation.senderId,
                    resolveExpireAtTimestampWithFallback(
                        mutation.expireAtTimestamp,
                        this.retention.msgOwnerTtlMs
                    )
                );
            case 'set-sent-message':
                return await tx.set(
                    this.toSentMessageKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    resolveExpireAtTimestampWithFallback(
                        mutation.expireAtTimestamp,
                        this.retention.sentMessageTtlMs
                    )
                );
            case 'delete-sent-message':
                return await tx.remove(this.toSentMessageKey(mutation.msgId));
            case 'set-pending-ack':
                return await tx.set(
                    this.toPendingAckKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    mutation.expireAtTimestamp ?? toALOutboundPendingAckExpireAtTimestamp(mutation.snapshot)
                );
            case 'delete-pending-ack':
                return await tx.remove(this.toPendingAckKey(mutation.msgId));
            case 'set-repair-attempt':
                return await tx.set(
                    this.toRepairAttemptKey(mutation.snapshot.msgId),
                    mutation.snapshot,
                    resolveExpireAtTimestampWithFallback(
                        mutation.expireAtTimestamp,
                        this.retention.repairAttemptTtlMs
                    )
                );
            case 'delete-repair-attempt':
                return await tx.remove(this.toRepairAttemptKey(mutation.msgId));
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
        }
    }

    private async bumpVersion(
        tx: ALAdmissionWriteContext,
        senderId: string,
        currentVersion: number | undefined
    ): Promise<void> {
        const version = currentVersion ??
            (await tx.read(this.toVersionKey(senderId), (value) => decodeALAdmissionClientRecord(value, senderId)))
                ?.version;
        await tx.set(
            this.toVersionKey(senderId),
            { senderId, version: (version ?? 0) + 1 } satisfies ALOutboundVersionedClientRecord,
            toExpireAtTimestampFromNow(this.retention.versionTtlMs)
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
