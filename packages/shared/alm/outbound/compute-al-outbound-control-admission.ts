import type {
    ALAckPayload,
    ALNackPayload,
    ALParsedControlMessage,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import type {
    ALOutboundPendingAckSnapshot
} from '../al-runtime-state-stores.ts';
import { toExpireAtTimestampFromNow, type NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import type {
    ALOutboundRepairHint,
    ALOutboundVersionedClientRecord
} from './admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from './al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
import {
    acceptALOutboundPendingAckSnapshot,
    isALOutboundReceiptComplete,
    toALOutboundPendingAckExpireAtTimestamp
} from './transition-al-outbound-pending-ack.ts';

export type ALControlHistory =
    | Readonly<{ kind: 'acks'; values: readonly ALAckPayload[]; }>
    | Readonly<{ kind: 'nacks'; values: readonly ALNackPayload[]; }>
    | Readonly<{ kind: 'repairs'; values: readonly ALRepairPayload[]; }>;

export interface ALControlAdmissionRead {
    readonly parsed: ALParsedControlMessage;
    readonly targetMsgId: string;
    readonly nowMs: number;
    readonly owner?: string;
    readonly ownerVersion?: ALOutboundVersionedClientRecord;
    readonly sent?: ALStoredOutboundMessage;
    readonly pending?: ALOutboundPendingAckSnapshot;
    readonly history: ALControlHistory;
}

export type ALPendingAckWrite =
    | Readonly<{ kind: 'unchanged'; }>
    | Readonly<{ kind: 'remove'; }>
    | Readonly<{ kind: 'set'; value: ALOutboundPendingAckSnapshot; }>;

export interface ALRepairHintEffectWrite {
    readonly effectId: string;
    readonly payload: Readonly<{
        kind: 'repair-hint';
        msgId: string;
        request: ALOutboundRepairHint;
    }>;
    readonly retryAtMs: number;
    readonly expireAtTimestamp: number;
}

export interface ALControlAdmissionCandidate {
    readonly read: ALControlAdmissionRead;
    readonly history: ALControlHistory;
    readonly pending: ALPendingAckWrite;
    readonly removeRepairAttempt: boolean;
    readonly receiptExpireAtTimestamp: number;
    readonly repairEffect?: ALRepairHintEffectWrite;
    readonly controlExpireAtTimestamp: number;
    readonly versionExpireAtTimestamp: number;
    readonly nextVersion: ALOutboundVersionedClientRecord | undefined;
}

export function computeALOutboundControlAdmission(
    read: ALControlAdmissionRead,
    retention: NormalizedALRuntimeStoreRetentionConfig
): ALControlAdmissionCandidate {
    const history = appendControlHistory(read);
    const pending = computePendingAckWrite(read, history);
    const terminal = read.parsed.type === 'nack' && isTerminalNack(read.parsed.payload);
    return {
        read,
        history,
        pending,
        removeRepairAttempt: terminal || pending.kind === 'remove' ||
            (pending.kind === 'set' && isALOutboundReceiptComplete(pending.value)),
        receiptExpireAtTimestamp: pending.kind === 'set' && !isALOutboundReceiptComplete(pending.value)
            ? toALOutboundPendingAckExpireAtTimestamp(pending.value)
            : Math.max(
                read.sent?.reference.expiresAtMs ?? 0,
                toExpireAtTimestampFromNow(retention.durableEffectTtlMs, read.nowMs)
            ),
        repairEffect: toRepairHintEffect(read),
        controlExpireAtTimestamp: toExpireAtTimestampFromNow(retention.controlHistoryTtlMs, read.nowMs),
        versionExpireAtTimestamp: toExpireAtTimestampFromNow(retention.versionTtlMs, read.nowMs),
        nextVersion: read.owner ? { senderId: read.owner, version: (read.ownerVersion?.version ?? 0) + 1 } : undefined
    };
}

/**
 * The receipt a committed control moved, as the delivery fact its owner states. A control that
 * changed no receipt states nothing: the acknowledgement it carried was already counted.
 */
export function toALOutboundAcknowledgementSettlement(
    candidate: ALControlAdmissionCandidate
): ALOutboundSettlementFact | undefined {
    const snapshot = resolveAcceptedReceipt(candidate);
    return snapshot === undefined ? undefined : {
        kind: 'acknowledgement',
        msgId: candidate.read.targetMsgId,
        confirmedHopPeerIds: snapshot.ackedPeerIds,
        unconfirmedHopPeerIds: snapshot.expectedPeerIds.filter(
            (peerId) => !snapshot.ackedPeerIds.includes(peerId)
        ),
        complete: isALOutboundReceiptComplete(snapshot)
    };
}

export function controlTargetMsgId(parsed: ALParsedControlMessage): string {
    return parsed.type === 'ack' ? parsed.payload.ackedMsgId : parsed.payload.msgId;
}

/** A `set` carries the receipt the commit wrote; a `remove` the one it tore down. */
function resolveAcceptedReceipt(
    candidate: ALControlAdmissionCandidate
): ALOutboundPendingAckSnapshot | undefined {
    switch (candidate.pending.kind) {
        case 'set':
            return candidate.pending.value;
        case 'remove':
            return candidate.read.pending;
        case 'unchanged':
            return undefined;
    }
}

function appendControlHistory(read: ALControlAdmissionRead): ALControlHistory {
    switch (read.parsed.type) {
        case 'ack':
            return {
                kind: 'acks',
                values: appendBounded(read.history.kind === 'acks' ? read.history.values : [], read.parsed.payload)
            };
        case 'nack':
            return {
                kind: 'nacks',
                values: appendBounded(read.history.kind === 'nacks' ? read.history.values : [], read.parsed.payload)
            };
        case 'repair':
            return {
                kind: 'repairs',
                values: appendBounded(read.history.kind === 'repairs' ? read.history.values : [], read.parsed.payload)
            };
    }
}

function appendBounded<T>(current: readonly T[], next: T): readonly T[] {
    const retained = current.slice(-(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries - 1));
    return [...retained, next];
}

function computePendingAckWrite(
    read: ALControlAdmissionRead,
    history: ALControlHistory
): ALPendingAckWrite {
    if (read.parsed.type === 'ack' && history.kind === 'acks') {
        const next = acceptALOutboundPendingAckSnapshot({
            current: read.pending,
            acks: [],
            ack: read.parsed.payload
        });
        return next ? { kind: 'set', value: next } : { kind: 'remove' };
    }
    return read.parsed.type === 'nack' && isTerminalNack(read.parsed.payload) && read.pending
        ? { kind: 'remove' }
        : { kind: 'unchanged' };
}

function toRepairHintEffect(
    read: ALControlAdmissionRead
): ALRepairHintEffectWrite | undefined {
    if (
        !read.sent || read.sent.reference.expiresAtMs <= read.nowMs ||
        read.parsed.type === 'ack' || (read.parsed.type === 'nack' && read.parsed.payload.reason !== 'gap')
    ) {
        return undefined;
    }
    const payload = read.parsed.payload;
    const request: ALOutboundRepairHint = {
        trigger: read.parsed.type === 'nack' ? 'nack' : 'repair',
        requestedByPeerId: payload.fromPeerId,
        orderingTrackKey: payload.orderingKey,
        missingSeqs: payload.missingSeqs ?? [],
        failedPeerIds: []
    };
    return {
        effectId: toALOutboundEffectId([
            'repair-hint',
            read.targetMsgId,
            request.trigger,
            request.requestedByPeerId ?? '-',
            request.orderingTrackKey ?? '-',
            request.missingSeqs.join(',')
        ]),
        payload: { kind: 'repair-hint', msgId: read.targetMsgId, request },
        retryAtMs: read.nowMs,
        expireAtTimestamp: read.sent.reference.expiresAtMs
    };
}

function isTerminalNack(nack: ALNackPayload): boolean {
    return nack.reason === 'expired' || nack.reason === 'unauthorized' || nack.reason === 'stale';
}
