import type { ALDeliveryCarrier } from '../../al-contracts/al-control-value-codec.ts';
import type {
    ALAckPayload,
    ALNackPayload,
    ALParsedControlMessage,
    ALPeerControlMessage,
    ALRepairPayload
} from '../../al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { toALSeqRangesText } from '../../al-contracts/al-seq-range.ts';
import type { ALReceiptProofRefusal } from '../../al-contracts/receipt-proof/al-receipt-proof.ts';
import type {
    ALOutboundPendingAckSnapshot
} from '../al-runtime-state-stores.ts';
import { toExpireAtTimestampFromNow, type NormalizedALRuntimeStoreRetentionConfig } from '../ALStoreRetention.ts';
import { isALOutsideAudienceNackReason } from '../delivery/is-al-outside-audience-nack-reason.ts';
import type { ALOutboundAdmissionMutation } from './admission/al-outbound-admission-mutations.ts';
import type {
    ALOutboundRepairHint,
    ALOutboundVersionedClientRecord
} from './admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
import type { ALOutboundSettlementFact } from './al-outbound-message-runtime.ts';
import { isALOutboundImpliedNotSubscribedAck } from './control/is-al-outbound-implied-not-subscribed-ack.ts';
import {
    isALOutboundRelayRejectionReason,
    resolveALOutboundRelayRejection,
    toALOutboundRelayRejectedFact
} from './control/resolve-al-outbound-relay-rejection.ts';
import { toALOutboundControlRepairHint } from './control/to-al-outbound-control-repair-hint.ts';
import { toALOutboundReceiptClasses } from './control/to-al-outbound-receipt-classes.ts';
import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';
import type { ALOutboundFirstHopWaitSnapshot } from './first-hop/compute-al-outbound-first-hop-wait.ts';
import { toALOutboundSettledMessageEnd } from './message-end/to-al-outbound-settled-message-end.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundFirstHopTimeoutEffectId,
    toALOutboundRepairHintEffectId
} from './to-al-outbound-effect-id.ts';
import {
    acceptALOutboundOutsideAudienceNack,
    acceptALOutboundPendingAckSnapshot,
    isALOutboundReceiptComplete,
    toALOutboundAcknowledgementFact,
    toALOutboundCompletedHopPeerIds
} from './transition-al-outbound-pending-ack.ts';

export type ALControlHistory =
    | Readonly<{ kind: 'acks'; values: readonly ALAckPayload[]; }>
    | Readonly<{ kind: 'nacks'; values: readonly ALNackPayload[]; }>
    | Readonly<{ kind: 'repairs'; values: readonly ALRepairPayload[]; }>;

/**
 * Who handed this control to its outbound owner: the trusted server of a WS client, which speaks for the
 * relay it is and never relays a peer NACK, or a peer. Trust follows the source, never the carrier.
 */
export type ALOutboundControlSource = 'trusted-server' | 'peer';

export interface ALControlAdmissionRead {
    readonly parsed: ALPeerControlMessage;
    readonly source: ALOutboundControlSource;
    /** The carrier the control reached this owner on: an acknowledgement is recorded under it, whatever its sender named. */
    readonly carrier: ALDeliveryCarrier;
    /** The composition's fixed hops (a WS client's server), expected repair peers of every send; undefined for none. */
    readonly hopPeerIds: readonly string[] | undefined;
    readonly targetMsgId: string;
    readonly nowMs: number;
    readonly owner?: string;
    readonly ownerVersion?: ALOutboundVersionedClientRecord;
    readonly sent?: ALStoredOutboundMessage;
    readonly pending?: ALOutboundPendingAckSnapshot;
    /** The sender's wait for its own hop to first answer for the message; absent when it waits on none. */
    readonly firstHopWait?: ALOutboundFirstHopWaitSnapshot;
    readonly history: ALControlHistory;
    /** The ACKs admitted before this control, which the hop view reads whatever kind of control it is. */
    readonly acknowledgements: readonly ALAckPayload[];
    /** Who spoke the control: its carrier authenticated its peer, its recipient's frozen key verified it, or why not. */
    readonly recipientProof: 'carrier-authenticated' | 'verified' | ALReceiptProofRefusal;
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
    /** The first-hop wait a refusal of the whole send ended, which the same commit removes. */
    readonly removeFirstHopWait: boolean;
    /** The timers of the receipt and the first-hop wait this control ended, which the same commit completes. */
    readonly endedTimeoutEffectIds: readonly string[];
    /** The end of the message whose terminal settlement this control states; empty for every other control. */
    readonly messageEnd: readonly ALOutboundAdmissionMutation[];
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
    const receiptEnded = terminal || pending.kind === 'remove' ||
        (pending.kind === 'set' && isALOutboundReceiptComplete(pending.value));
    const messageEnd = toALOutboundSettledMessageEnd(
        read.sent,
        toALOutboundControlSettlements({ read, history, pending }, read.targetMsgId)
    );
    return {
        read,
        history,
        pending,
        messageEnd,
        removeRepairAttempt: receiptEnded || messageEnd.length > 0,
        ...toEndedTimers(read, receiptEnded, terminal || resolveALOutboundRelayRejection(read) !== undefined),
        receiptExpireAtTimestamp: pending.kind === 'set' && !isALOutboundReceiptComplete(pending.value)
            ? read.sent?.reference.expiresAtMs ?? read.nowMs
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

/** The receipt's timer when the control ended the receipt; the first-hop wait and its timer when it ended the send. */
function toEndedTimers(
    read: ALControlAdmissionRead,
    receiptEnded: boolean,
    sendEnded: boolean
): Pick<ALControlAdmissionCandidate, 'removeFirstHopWait' | 'endedTimeoutEffectIds'> {
    const endedReceipt = receiptEnded ? read.pending : undefined;
    const endedWait = sendEnded ? read.firstHopWait : undefined;
    return {
        removeFirstHopWait: endedWait !== undefined,
        endedTimeoutEffectIds: [
            ...(endedReceipt === undefined ? [] : [toALOutboundAckTimeoutEffectId(endedReceipt)]),
            ...(endedWait === undefined ? [] : [toALOutboundFirstHopTimeoutEffectId(endedWait)])
        ]
    };
}

/**
 * The delivery facts a committed control states: a relay's refusal of the whole send, or the receipt the control
 * moved -- followed by `receipt-exhausted` when a hop refused the message for good and so ended a receipt it still
 * owed. A control that changed no receipt states nothing. Each fact carries the control's trace, the subject's in
 * production because a control is built with it.
 */
export function toALOutboundControlSettlements(
    candidate: Pick<ALControlAdmissionCandidate, 'read' | 'history' | 'pending'>,
    traceId: string
): readonly ALOutboundSettlementFact[] {
    const { read, history } = candidate;
    const relayRejection = resolveALOutboundRelayRejection(read);
    if (relayRejection !== undefined) {
        return [toALOutboundRelayRejectedFact(read.targetMsgId, traceId, relayRejection)];
    }
    const snapshot = resolveAcceptedReceipt(candidate);
    if (snapshot === undefined) {
        return [];
    }
    const acknowledgement = toALOutboundAcknowledgementFact({
        receipt: snapshot,
        hops: {
            nextHopPeerIds: read.sent?.policy.ackTracking?.nextHopPeerIds ?? [],
            completedHopPeerIds: toALOutboundCompletedHopPeerIds(
                history.kind === 'acks' ? history.values : read.acknowledgements
            )
        },
        complete: isALOutboundReceiptComplete(snapshot),
        traceId
    });
    const refused = toRefusedReceiptFact(read, snapshot, traceId);
    return refused === undefined ? [acknowledgement] : [acknowledgement, refused];
}

/**
 * An `expired`, `unauthorized`, `stale`, `membership-fenced`, `held-by-other`, `unsupported` or `no-publish-grant` NACK
 * removed a receipt its hop will never confirm.
 */
function toRefusedReceiptFact(
    read: ALControlAdmissionRead,
    receipt: ALOutboundPendingAckSnapshot,
    traceId: string
): ALOutboundSettlementFact | undefined {
    if (
        read.parsed.type !== 'nack' || !isTerminalNack(read.parsed.payload) ||
        isALOutboundReceiptComplete(receipt)
    ) {
        return undefined;
    }
    const nack = read.parsed.payload;
    return toALOutboundReceiptExhaustedFact({
        receipt,
        exhaustion: { cause: 'hop-refused', hopPeerId: nack.fromPeerId, nackReason: nack.reason },
        detail: `Hop ${nack.fromPeerId} refused the message: ${nack.reason}.`,
        traceId
    });
}

export function controlTargetMsgId(parsed: ALParsedControlMessage): string {
    return parsed.type === 'ack' ? parsed.payload.ackedMsgId : parsed.payload.msgId;
}

/** A `set` carries the receipt the commit wrote; a `remove` the one it tore down. */
function resolveAcceptedReceipt(
    candidate: Pick<ALControlAdmissionCandidate, 'read' | 'pending'>
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
                values: appendBounded(
                    read.history.kind === 'acks' ? read.history.values : [],
                    { ...read.parsed.payload, carrier: read.carrier }
                )
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
        const ack = read.parsed.payload;
        const next = acceptALOutboundPendingAckSnapshot({ current: read.pending, acks: [], ack });
        if (next === undefined) {
            return { kind: 'remove' };
        }
        const owedPeerIds = toALOutboundReceiptClasses(next).unconfirmedPeerIds;
        return {
            kind: 'set',
            value: isALOutboundImpliedNotSubscribedAck(next.mode, ack, owedPeerIds)
                ? acceptALOutboundOutsideAudienceNack(next, ack.logicalRecipientPeerId)
                : next
        };
    }
    if (read.parsed.type === 'nack' && isALOutsideAudienceNackReason(read.parsed.payload.reason) && read.pending) {
        return {
            kind: 'set',
            value: acceptALOutboundOutsideAudienceNack(read.pending, read.parsed.payload.logicalRecipientPeerId)
        };
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
    const request = toALOutboundControlRepairHint(read.parsed);
    return {
        effectId: toALOutboundRepairHintEffectId(read.targetMsgId, request),
        payload: { kind: 'repair-hint', msgId: read.targetMsgId, request },
        retryAtMs: read.nowMs,
        expireAtTimestamp: read.sent.reference.expiresAtMs
    };
}

/** A NACK whose reason may end the whole send: the one control whose admission reads the send's first-hop wait. */
export function mayALOutboundControlEndSend(parsed: ALPeerControlMessage): boolean {
    return parsed.type === 'nack' &&
        (isTerminalNack(parsed.payload) || isALOutboundRelayRejectionReason(parsed.payload.reason));
}

/**
 * A `resync-required`, `held-by-other`, `unsupported` or `no-publish-grant` refusal ends the receipt too: the hop will
 * refuse every resend of the message. An outside-audience NACK (`not-subscribed`, `before-entry`) speaks for one
 * recipient only, so it never ends one.
 */
function isTerminalNack(nack: ALNackPayload): boolean {
    return nack.reason === 'expired' || nack.reason === 'unauthorized' || nack.reason === 'stale' ||
        nack.reason === 'resync-required' || nack.reason === 'membership-fenced' || nack.reason === 'held-by-other' ||
        nack.reason === 'unsupported' || nack.reason === 'no-publish-grant';
}
