import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { jsonEquals } from '../../../repository/state-utils.ts';
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
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type {
    ALLatestSupersedenceValue,
    ALReplacementSupersedenceValue
} from '../../compute-al-supersedence-observation.ts';
import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';
import type { ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
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
        originPeerId: string;
        snapshot: ALOutboundPendingAckSnapshot;
        /** The message deadline: the receipt is the obligation an acknowledgement completes against until then. */
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'delete-pending-ack';
        originPeerId: string;
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
        /** The predecessor's row this admission read before writing; undefined when it read none. */
        observed: ALReplacementSupersedenceValue | undefined;
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
    /** The pair the rows are written to: the volatile pair keeps a message's rows only through its receipt grace. */
    readonly durability: ALStoreDurability;
}

/** What a re-read inside the write found: a losable conflict, or a persisted identity that is corrupt. */
export type ALOutboundCommitFenceIssue =
    | Readonly<{ kind: 'conflict'; message: string; }>
    | Readonly<{ kind: 'corruption'; key: string; message: string; }>;

/** Owns the outbound mutation vocabulary: the state write each mutation names, its guards, and its apply. */
export class ALOutboundAdmissionMutations {
    private readonly namespace: string;
    private readonly canonicalScope: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly supersedenceTrackTtlMs: number;
    private readonly durability: ALStoreDurability;

    constructor(input: CreateALOutboundAdmissionMutationsInput) {
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.retention = input.retention;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.durability = input.durability;
    }

    computeStateWrites(
        mutations: readonly ALOutboundAdmissionMutation[],
        nowMs: number
    ): readonly ALOutboundStateWrite[] {
        return mutations.map((mutation) => this.computeStateWrite(mutation, nowMs));
    }

    /** The first moved supersedence observation, or undefined: the commit fence owns the throw. */
    async readCurrentObservationConflict(
        transaction: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<ALOutboundCommitFenceIssue | undefined> {
        for (const write of writes) {
            if (write.supersedenceGuard === undefined) {
                continue;
            }
            const current = await transaction.read(
                write.key,
                (value) => decodeALAdmissionSupersedenceValue(value, 'latest')
            );
            if (!jsonEquals(current, write.supersedenceGuard.expected)) {
                return { kind: 'conflict', message: 'Outbound shared supersedence observation changed' };
            }
        }
        return undefined;
    }

    /** The first message id another sender or scope already owns, or undefined. */
    async readMessageIdentityConflict(
        transaction: ALAdmissionWorkWriteContext,
        mutations: readonly ALOutboundAdmissionMutation[]
    ): Promise<ALOutboundCommitFenceIssue | undefined> {
        for (const mutation of mutations) {
            if (mutation.kind === 'set-msg-owner') {
                const key = toALOutboundMessageOwnerKey(this.namespace, mutation.msgId);
                const owner = await transaction.read(key, decodeALAdmissionString);
                if (owner !== undefined && owner !== mutation.senderId) {
                    return { kind: 'corruption', key, message: 'Message id belongs to another sender' };
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
                    return { kind: 'corruption', key, message: 'Message id has conflicting canonical identity' };
                }
            }
        }
        return undefined;
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
            expireAtTimestamp: this.computeMessageRowExpiryMs(
                mutation.expireAtTimestamp,
                nowMs,
                this.retention.msgOwnerTtlMs
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
                key: toALOutboundPendingAckKey({
                    namespace: this.namespace,
                    originPeerId: mutation.originPeerId,
                    msgId: mutation.snapshot.msgId
                }),
                value: mutation.snapshot,
                expireAtTimestamp: mutation.expireAtTimestamp,
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
                return toALOutboundPendingAckKey({
                    namespace: this.namespace,
                    originPeerId: mutation.originPeerId,
                    msgId: mutation.msgId
                });
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
            expireAtTimestamp: this.computeMessageRowExpiryMs(
                mutation.expireAtTimestamp,
                nowMs,
                this.retention.sentMessageTtlMs
            ),
            supersedenceGuard: undefined
        };
    }

    /**
     * A durable pair answers a late control for the row's TTL past the send; the volatile pair only until the message
     * deadline plus the receipt grace (D74). An admission always names the deadline, so only a bare store write
     * reaches the volatile branch without one, and keeps just the grace.
     */
    private computeMessageRowExpiryMs(deadlineAtMs: number | undefined, nowMs: number, rowTtlMs: number): number {
        if (this.durability === 'volatile') {
            return resolveALReceiptRetentionExpiryMs(deadlineAtMs ?? nowMs);
        }
        return Math.max(deadlineAtMs ?? 0, nowMs + rowTtlMs, nowMs + this.retention.controlHistoryTtlMs);
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
