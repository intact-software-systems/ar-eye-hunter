import type { ALStoreDurability } from '../../../al-contracts/al-policy.ts';
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
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import type {
    ALLatestSupersedenceValue,
    ALReplacementSupersedenceValue
} from '../../compute-al-supersedence-observation.ts';
import { computeALReceiptRetentionExpiryMs } from '../../delivery/compute-al-receipt-retention-expiry-ms.ts';
import type { ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import {
    toALOutboundMessageOwnerKey,
    toALOutboundPendingAckKey,
    toALOutboundRepairAttemptKey,
    toALOutboundSentMessageKey,
    toALOutboundSupersedenceLatestKey,
    toALOutboundSupersedenceReplacementKey
} from './al-outbound-admission-keys.ts';
import type {
    ALOutboundMessageReadDto,
    ALOutboundOrderingHead,
    ALOutboundSentPositions
} from './al-outbound-admission-store.ts';
import {
    decodeALOutboundSentMessage,
    type ALOutboundCapturedPolicy,
    type ALStoredOutboundMessageRow
} from './al-outbound-admission-validation.ts';
import {
    toALOutboundOrderingHeadKey,
    toALOutboundOrderingMessageKey,
    toALOutboundRoomSentPositionKey,
    toALOutboundSentPositionKey
} from './al-outbound-ordering-track-keys.ts';
import {
    decodeALOutboundTrackPositionRow,
    type ALOutboundTrackPositionRow
} from './decode-al-outbound-track-position-row.ts';
import {
    decodeALOutboundRoomSentPositionRow,
    type ALOutboundRoomSentPositionRow
} from './sequencing/al-outbound-room-sent-position.ts';

export type ALOutboundAdmissionMutation =
    | Readonly<
        { kind: 'set-ordering-message'; trackKey: string; seq: number; msgId: string; expireAtTimestamp: number; }
    >
    | Readonly<{
        kind: 'set-ordering-head';
        trackKey: string;
        seq: number;
        /** The head the admission read; the commit writes only while the row still holds it. */
        observedSeq: number | undefined;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-sent-position';
        namespace: ALOutboundSentPositionNamespace;
        trackKey: string;
        recipientPeerId: string;
        seq: number;
        expireAtTimestamp: number;
    }>
    | Readonly<{
        kind: 'set-room-sent-position';
        trackKey: string;
        /** The floor the admission read; the commit writes only while the row still holds it. */
        observed: ALOutboundRoomSentPositionRow | undefined;
        value: ALOutboundRoomSentPositionRow;
        expireAtTimestamp: number;
    }>
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
        sentPositions: Readonly<Record<string, number>> | null;
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

/**
 * Where a recipient's sent position lives: the pair's own namespace, which its recording admissions write, or the one
 * its session's pairs share with their heads, which the WS leg's admitted receipts write.
 */
export type ALOutboundSentPositionNamespace = 'pair' | 'ordering-head';

export interface ALOutboundStateWrite {
    readonly key: string;
    readonly value:
        | string
        | ALStoredOutboundMessageRow
        | ALOutboundPendingAckSnapshot
        | ALOutboundRepairAttemptSnapshot
        | ALOutboundTrackPositionRow
        | ALOutboundRoomSentPositionRow
        | ALLatestSupersedenceValue
        | ALReplacementSupersedenceValue
        | undefined;
    readonly expireAtTimestamp: number | undefined;
    /** Present for a row other writers share: the commit writes it only while it still holds `expected`. */
    readonly guard: ALOutboundStateWriteGuard | undefined;
}

/** What a shared row must still hold for a commit to write it: compare-and-set inside the fenced commit. */
export type ALOutboundStateWriteGuard =
    | Readonly<{ kind: 'supersedence-latest'; expected: ALLatestSupersedenceValue | undefined; }>
    | Readonly<{ kind: 'ordering-head'; expected: ALOutboundTrackPositionRow | undefined; }>
    | Readonly<{ kind: 'room-sent-position'; expected: ALOutboundRoomSentPositionRow | undefined; }>;

export interface CreateALOutboundAdmissionMutationsInput {
    readonly namespace: string;
    /** Where the sender's ordering-track heads live: this pair's namespace, or the one its session's pairs share. */
    readonly orderingHeadNamespace: string;
    readonly canonicalScope: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly supersedenceTrackTtlMs: number;
    readonly durability: ALStoreDurability;
}

/** What a re-read inside the write found: a losable conflict, or a persisted identity that is corrupt. */
export type ALOutboundCommitFenceIssue =
    | Readonly<{ kind: 'conflict'; message: string; }>
    | Readonly<{ kind: 'corruption'; key: string; message: string; }>;

/**
 * The track rows a sequenced message's admission writes: the row naming its sequence's message, and the head and the
 * sent positions this read minted or recorded. A message with no track or no deadline writes none.
 */
export function toALOutboundOrderingTrackMutations<TPrepared>(
    read: Pick<ALOutboundMessageReadDto<TPrepared>, 'msg' | 'orderingHead' | 'sentPositions'>,
    expiresAtMs: number | undefined
): readonly ALOutboundAdmissionMutation[] {
    const trackKey = toALOrderingTrackKey(read.msg);
    const seq = read.msg.ordering?.seq;
    if (!trackKey || seq === undefined || expiresAtMs === undefined) {
        return [];
    }
    return [
        { kind: 'set-ordering-message', trackKey, seq, msgId: read.msg.id.msgId, expireAtTimestamp: expiresAtMs },
        ...toALOutboundOrderingHeadMutations(read.orderingHead, expiresAtMs),
        ...toALOutboundSentPositionMutations(read.sentPositions, expiresAtMs, 'pair')
    ];
}

function toALOutboundOrderingHeadMutations(
    head: ALOutboundOrderingHead | undefined,
    expireAtTimestamp: number
): readonly ALOutboundAdmissionMutation[] {
    if (head === undefined) {
        return [];
    }
    const { trackKey, seq } = head;
    return [
        { kind: 'set-ordering-head', trackKey, seq, observedSeq: head.observedSeq, expireAtTimestamp },
        ...(head.roomSentPosition === undefined
            ? []
            : [{ kind: 'set-room-sent-position', trackKey, expireAtTimestamp, ...head.roomSentPosition } as const])
    ];
}

/** Moves each recorded recipient to the sequence it was sent; one already at or past it keeps its position. */
export function toALOutboundSentPositionMutations(
    positions: ALOutboundSentPositions | undefined,
    expireAtTimestamp: number,
    namespace: ALOutboundSentPositionNamespace
): readonly ALOutboundAdmissionMutation[] {
    if (positions === undefined) {
        return [];
    }
    return Object.entries(positions.priorSeqByRecipient)
        .filter(([, priorSeq]) => priorSeq < positions.seq)
        .map(([recipientPeerId]) => ({
            kind: 'set-sent-position',
            namespace,
            trackKey: positions.trackKey,
            recipientPeerId,
            seq: positions.seq,
            expireAtTimestamp
        }));
}

/** Owns the outbound mutation vocabulary: the state write each mutation names, its guards, and its apply. */
export class ALOutboundAdmissionMutations {
    private static readonly GUARD_CONFLICT_MESSAGES: Readonly<Record<ALOutboundStateWriteGuard['kind'], string>> = {
        'ordering-head': 'Outbound ordering head moved',
        'room-sent-position': 'Outbound room sent position moved',
        'supersedence-latest': 'Outbound shared supersedence observation changed'
    };
    private readonly namespace: string;
    private readonly orderingHeadNamespace: string;
    private readonly canonicalScope: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly supersedenceTrackTtlMs: number;
    private readonly durability: ALStoreDurability;

    constructor(input: CreateALOutboundAdmissionMutationsInput) {
        this.namespace = input.namespace;
        this.orderingHeadNamespace = input.orderingHeadNamespace;
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

    /**
     * The first guarded row another commit moved since the admission read it, or undefined: the commit fence owns the
     * throw, and the conflict retries the admission from a fresh read. Every guard is read at once, so the fence costs
     * one round trip; the first in order still decides.
     */
    async readGuardConflict(
        transaction: ALAdmissionWorkWriteContext,
        writes: readonly ALOutboundStateWrite[]
    ): Promise<ALOutboundCommitFenceIssue | undefined> {
        const moved = await Promise.all(
            writes.map(async ({ key, guard }) =>
                guard !== undefined &&
                !jsonEquals(await readALOutboundGuardedValue(transaction, key, guard), guard.expected)
            )
        );
        const guard = writes[moved.indexOf(true)]?.guard;
        if (guard === undefined) {
            return undefined;
        }
        return { kind: 'conflict', message: ALOutboundAdmissionMutations.GUARD_CONFLICT_MESSAGES[guard.kind] };
    }

    /** The first message id another sender or scope already owns, or undefined; every owner row is read at once. */
    async readMessageIdentityConflict(
        transaction: ALAdmissionWorkWriteContext,
        mutations: readonly ALOutboundAdmissionMutation[]
    ): Promise<ALOutboundCommitFenceIssue | undefined> {
        const issues = await Promise.all(
            mutations.map((mutation) => this.readMessageIdentityIssue(transaction, mutation))
        );
        return issues.find((issue) => issue !== undefined);
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

    private async readMessageIdentityIssue(
        transaction: ALAdmissionWorkWriteContext,
        mutation: ALOutboundAdmissionMutation
    ): Promise<ALOutboundCommitFenceIssue | undefined> {
        if (mutation.kind === 'set-msg-owner') {
            const key = toALOutboundMessageOwnerKey(this.namespace, mutation.msgId);
            const owner = await transaction.read(key, decodeALAdmissionString);
            return owner !== undefined && owner !== mutation.senderId
                ? { kind: 'corruption', key, message: 'Message id belongs to another sender' }
                : undefined;
        }
        if (mutation.kind !== 'set-sent-message') {
            return undefined;
        }
        const key = toALOutboundSentMessageKey(this.namespace, mutation.snapshot.msgId);
        const sent = await transaction.read(
            key,
            (value) => decodeALOutboundSentMessage(value, mutation.snapshot.msgId)
        );
        return mutation.reference.scope !== this.canonicalScope ||
                (sent !== undefined && !jsonEquals(sent.reference, mutation.reference))
            ? { kind: 'corruption', key, message: 'Message id has conflicting canonical identity' }
            : undefined;
    }

    private computeStateWrite(mutation: ALOutboundAdmissionMutation, nowMs: number): ALOutboundStateWrite {
        switch (mutation.kind) {
            case 'set-ordering-message':
                return {
                    key: toALOutboundOrderingMessageKey(this.namespace, mutation.trackKey, mutation.seq),
                    value: mutation.msgId,
                    expireAtTimestamp: mutation.expireAtTimestamp,
                    guard: undefined
                };
            case 'set-ordering-head':
            case 'set-sent-position':
            case 'set-room-sent-position':
                return this.computeTrackPositionWrite(mutation, nowMs);
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
                    guard: undefined
                };
            case 'set-supersedence-latest':
            case 'set-supersedence-replacement':
                return this.computeSupersedenceWrite(mutation);
        }
    }

    /**
     * The track's head and each recipient's sent position share the receivers' track retention, the repository TTL,
     * so a durable pair continues a track across a reload or a quiet hour for as long as a receiver keeps its position.
     * The sender-version fence serializes this pair's writers, so a position is a plain set, in the shared namespace
     * too: only the WS leg's receipts write there. The head and the room-wide sent position are shared with the other
     * carrier pair of the session, so each is written only over the row the admission read.
     */
    private computeTrackPositionWrite(
        mutation: Extract<
            ALOutboundAdmissionMutation,
            { kind: 'set-ordering-head' | 'set-sent-position' | 'set-room-sent-position'; }
        >,
        nowMs: number
    ): ALOutboundStateWrite {
        const expireAtTimestamp = this.computeMessageRowExpiryMs(
            mutation.expireAtTimestamp,
            nowMs,
            this.retention.repositoryTtlMs
        );
        switch (mutation.kind) {
            case 'set-sent-position': {
                const namespace = mutation.namespace === 'pair' ? this.namespace : this.orderingHeadNamespace;
                const key = toALOutboundSentPositionKey(namespace, mutation.trackKey, mutation.recipientPeerId);
                return { key, value: { seq: mutation.seq }, expireAtTimestamp, guard: undefined };
            }
            case 'set-room-sent-position':
                return {
                    key: toALOutboundRoomSentPositionKey(this.orderingHeadNamespace, mutation.trackKey),
                    value: mutation.value,
                    expireAtTimestamp,
                    guard: { kind: 'room-sent-position', expected: mutation.observed }
                };
            case 'set-ordering-head': {
                const expected = mutation.observedSeq === undefined ? undefined : { seq: mutation.observedSeq };
                const key = toALOutboundOrderingHeadKey(this.orderingHeadNamespace, mutation.trackKey);
                return {
                    key,
                    value: { seq: mutation.seq },
                    expireAtTimestamp,
                    guard: { kind: 'ordering-head', expected }
                };
            }
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
            guard: undefined
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
                guard: undefined
            }
            : {
                key: toALOutboundPendingAckKey({
                    namespace: this.namespace,
                    originPeerId: mutation.originPeerId,
                    msgId: mutation.snapshot.msgId
                }),
                value: mutation.snapshot,
                expireAtTimestamp: mutation.expireAtTimestamp,
                guard: undefined
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
                ...(mutation.sentPositions === null ? {} : { sentPositions: mutation.sentPositions }),
                policy: mutation.policy,
                creationExpiry: mutation.creationExpiry
            },
            expireAtTimestamp: this.computeMessageRowExpiryMs(
                mutation.expireAtTimestamp,
                nowMs,
                this.retention.sentMessageTtlMs
            ),
            guard: undefined
        };
    }

    /**
     * A durable pair keeps the row, and so answers a late control, until the latest of the message deadline,
     * the row's TTL past the send and the control-history TTL past the send: a message whose deadline lies a day
     * out keeps its rows a day. A memory pair, volatile or checkpointed, keeps it only until the message deadline
     * plus the receipt grace. An admission always names the deadline, so only a bare store write reaches
     * either branch without one: the memory branch then keeps just the grace, the durable branch the longer TTL.
     */
    private computeMessageRowExpiryMs(deadlineAtMs: number | undefined, nowMs: number, rowTtlMs: number): number {
        switch (this.durability) {
            case 'volatile':
            case 'checkpoint':
                return computeALReceiptRetentionExpiryMs(deadlineAtMs ?? nowMs);
            case 'durable':
                return Math.max(deadlineAtMs ?? 0, nowMs + rowTtlMs, nowMs + this.retention.controlHistoryTtlMs);
        }
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
                    guard: { kind: 'supersedence-latest', expected: mutation.expected }
                };
            case 'set-supersedence-replacement':
                return {
                    key: toALOutboundSupersedenceReplacementKey(this.namespace, mutation.msgId),
                    value: mutation.value,
                    expireAtTimestamp: mutation.value.updatedAtMs + this.supersedenceTrackTtlMs,
                    guard: undefined
                };
        }
    }
}

/** The guarded row as the commit's transaction holds it now, read as the admission read it. */
async function readALOutboundGuardedValue(
    transaction: ALAdmissionWorkWriteContext,
    key: string,
    guard: ALOutboundStateWriteGuard
): Promise<ALOutboundTrackPositionRow | ALOutboundRoomSentPositionRow | ALLatestSupersedenceValue | undefined> {
    switch (guard.kind) {
        case 'ordering-head':
            return await transaction.read(key, decodeALOutboundTrackPositionRow);
        case 'room-sent-position':
            return await transaction.read(key, decodeALOutboundRoomSentPositionRow);
        case 'supersedence-latest':
            return await transaction.read(key, (value) => decodeALAdmissionSupersedenceValue(value, 'latest'));
    }
}
