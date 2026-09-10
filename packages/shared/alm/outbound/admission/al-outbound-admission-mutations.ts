import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { jsonEquals } from '../../../repository/state-utils.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import {
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '../../al-admission-value-validation.ts';
import type { ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot,
    ALOutboundSentMessageSnapshot
} from '../../al-runtime-state-stores.ts';
import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type {
    ALLatestSupersedenceValue,
    ALReplacementSupersedenceValue
} from '../../compute-al-supersedence-observation.ts';
import type { ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import { toALOutboundPendingAckExpireAtTimestamp } from '../transition-al-outbound-pending-ack.ts';
import {
    toALOutboundMessageOwnerKey,
    toALOutboundOrderingMessageKey,
    toALOutboundPendingAckKey,
    toALOutboundRepairAttemptKey,
    toALOutboundSentMessageKey,
    toALOutboundSupersedenceLatestKey,
    toALOutboundSupersedenceReplacementKey
} from './al-outbound-admission-keys.ts';
import {
    decodeALOutboundSentMessage,
    type ALOutboundCapturedPolicy,
    type ALStoredOutboundMessage
} from './al-outbound-admission-validation.ts';

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

export interface ALOutboundStateWrite {
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

export interface CreateALOutboundAdmissionMutationsInput {
    readonly namespace: string;
    readonly canonicalScope: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly supersedenceTrackTtlMs: number;
}

/** Owns the outbound mutation vocabulary: the state write each mutation names, its guards, and its apply. */
export class ALOutboundAdmissionMutations {
    private readonly namespace: string;
    private readonly canonicalScope: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly supersedenceTrackTtlMs: number;

    constructor(input: CreateALOutboundAdmissionMutationsInput) {
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.retention = input.retention;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
    }

    computeStateWrites(
        mutations: readonly ALOutboundAdmissionMutation[],
        nowMs: number
    ): readonly ALOutboundStateWrite[] {
        return mutations.map((mutation) => this.computeStateWrite(mutation, nowMs));
    }

    async assertCurrentObservations(
        transaction: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<void> {
        for (const write of writes) {
            if (write.supersedenceGuard === undefined) {
                continue;
            }
            const current = await transaction.read(
                write.key,
                (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
            );
            if (!jsonEquals(current, write.supersedenceGuard.expected)) {
                throw new ALAdmissionBackendConflictError('Outbound shared supersedence observation changed');
            }
        }
    }

    async assertMessageIdentities(
        transaction: ALAdmissionWorkWriteContext,
        mutations: readonly ALOutboundAdmissionMutation[]
    ): Promise<void> {
        for (const mutation of mutations) {
            if (mutation.kind === 'set-msg-owner') {
                const key = toALOutboundMessageOwnerKey(this.namespace, mutation.msgId);
                const owner = await transaction.read(key, decodeALAdmissionString);
                if (owner !== undefined && owner !== mutation.senderId) {
                    throw new ALAdmissionCorruptionError(key, new TypeError('Message id belongs to another sender'));
                }
            }
            if (mutation.kind === 'set-sent-message') {
                const key = toALOutboundSentMessageKey(this.namespace, mutation.snapshot.msgId);
                const sent = await transaction.read(
                    key,
                    (value) => decodeALOutboundSentMessage(value, mutation.snapshot.msgId)
                );
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

    async writeStateWrites(
        transaction: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<void> {
        for (const write of writes) {
            if (write.value === undefined) {
                await transaction.remove(write.key);
            }
            else {
                await transaction.set(write.key, write.value, write.expireAtTimestamp);
            }
        }
    }

    private computeStateWrite(mutation: ALOutboundAdmissionMutation, nowMs: number): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-ordering-message':
                return {
                    key: toALOutboundOrderingMessageKey(this.namespace, mutation.trackKey, mutation.seq),
                    value: mutation.msgId,
                    expireAtTimestamp: mutation.expireAtTimestamp,
                    supersedenceGuard: undefined
                };
            case 'set-msg-owner':
                return this.computeMessageOwnerWrite(mutation, nowMs);
            case 'set-sent-message':
                return this.computeSentMessageWrite(mutation, nowMs);
            case 'set-repair-attempt':
            case 'set-pending-ack':
                return this.computeReceiptWrite(mutation, nowMs);
            case 'delete-sent-message':
            case 'delete-pending-ack':
            case 'delete-repair-attempt':
                return {
                    key: this.toDeletedMutationKey(mutation),
                    value: undefined,
                    expireAtTimestamp: undefined,
                    supersedenceGuard: undefined
                };
            case 'set-supersedence-latest':
            case 'set-supersedence-replacement':
                return this.computeSupersedenceWrite(mutation);
        }
    }

    /** The owner row answers control that arrives after the message itself is gone, so it outlives both. */
    private computeMessageOwnerWrite(
        mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-msg-owner'; }>,
        nowMs: number
    ): ALOutboundStateWrite {
        return {
            key: toALOutboundMessageOwnerKey(this.namespace, mutation.msgId),
            value: mutation.senderId,
            expireAtTimestamp: Math.max(
                mutation.expireAtTimestamp ?? 0,
                nowMs + this.retention.msgOwnerTtlMs,
                nowMs + this.retention.controlHistoryTtlMs
            ),
            supersedenceGuard: undefined
        };
    }

    private computeReceiptWrite(
        mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-repair-attempt' | 'set-pending-ack'; }>,
        nowMs: number
    ): ALOutboundStateWrite {
        return mutation.kind === 'set-repair-attempt'
            ? {
                key: toALOutboundRepairAttemptKey(this.namespace, mutation.snapshot.msgId),
                value: mutation.snapshot,
                expireAtTimestamp: mutation.expireAtTimestamp ?? nowMs + this.retention.repairAttemptTtlMs,
                supersedenceGuard: undefined
            }
            : {
                key: toALOutboundPendingAckKey(this.namespace, mutation.snapshot.msgId),
                value: mutation.snapshot,
                expireAtTimestamp: mutation.expireAtTimestamp ??
                    toALOutboundPendingAckExpireAtTimestamp(mutation.snapshot),
                supersedenceGuard: undefined
            };
    }

    private toDeletedMutationKey(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'delete-sent-message' | 'delete-pending-ack' | 'delete-repair-attempt'; }
        >
    ): string {
        switch (mutation.kind) {
            case 'delete-sent-message':
                return toALOutboundSentMessageKey(this.namespace, mutation.msgId);
            case 'delete-pending-ack':
                return toALOutboundPendingAckKey(this.namespace, mutation.msgId);
            case 'delete-repair-attempt':
                return toALOutboundRepairAttemptKey(this.namespace, mutation.msgId);
        }
    }

    private computeSentMessageWrite(
        mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-sent-message'; }>,
        nowMs: number
    ): ALOutboundStateWrite {
        return {
            key: toALOutboundSentMessageKey(this.namespace, mutation.snapshot.msgId),
            value: {
                msgId: mutation.snapshot.msgId,
                reference: mutation.reference,
                supersedenceKey: mutation.snapshot.supersedenceKey ?? undefined,
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

    private computeSupersedenceWrite(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'set-supersedence-latest' | 'set-supersedence-replacement'; }
        >
    ): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-supersedence-latest':
                return {
                    key: toALOutboundSupersedenceLatestKey(this.namespace, mutation.supersedenceKey),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: { expected: mutation.expected }
                };
            case 'set-supersedence-replacement':
                return {
                    key: toALOutboundSupersedenceReplacementKey(this.namespace, mutation.msgId),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    supersedenceGuard: undefined
                };
        }
    }
}
