import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { toALWorkFailureOutcome, type ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundCapturedPolicy } from '../admission/al-outbound-admission-validation.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';

/** How a dequeued row's attempt ended: superseded at its read, failed for good, its commit, or not at all. */
export type ALOutboundTrackIndexEndCause<TPrepared> =
    | ALOutboundComputedDto<TPrepared>
    | 'superseded'
    | 'failed'
    | undefined;

/** The index row of one track sequence, and the message it must still name to be cleared. */
export interface ALOutboundTrackIndexEnd {
    readonly trackKey: string;
    readonly seq: number;
    readonly msgId: string;
}

/** What a row recorded: its positions (`null`, none) under the policy it was admitted with. */
export interface ALOutboundTrackIndexRecord {
    readonly sentPositions: Readonly<Record<string, number>> | null;
    readonly policy: ALOutboundCapturedPolicy;
}

/** A dequeued row's attempt as it finished: its outcome, what its read decided, and its batch's commits. */
export interface ALOutboundCompletedAttempt<TPrepared> {
    readonly outcome: ALWorkAttemptResult;
    readonly read: Promise<Readonly<{ kind: 'superseded' | 'dispatch'; }> | undefined>;
    readonly commits: Promise<readonly (PromiseSettledResult<ALOutboundComputedDto<TPrepared>> | undefined)[]>;
    readonly index: number;
}

/**
 * What a completed attempt ended in: superseded at its read, the commit it made, or nothing it dispatched; an attempt
 * that did not complete ended nothing.
 */
export async function resolveALOutboundCompletedTrackIndexEndCause<TPrepared>(
    attempt: ALOutboundCompletedAttempt<TPrepared>
): Promise<ALOutboundTrackIndexEndCause<TPrepared>> {
    if (attempt.outcome.status !== 'completed') {
        return undefined;
    }
    const read = await attempt.read;
    if (read?.kind !== 'dispatch') {
        return read?.kind;
    }
    const commit = (await attempt.commits)[attempt.index];
    return commit?.status === 'fulfilled' ? commit.value : undefined;
}

/** A failed attempt ends its row only when the work handler settles the failure non-retryable. */
export function toALOutboundFailedTrackIndexEndCause(error: Error): 'failed' | undefined {
    return toALWorkFailureOutcome(error).status === 'non-retryable' ? 'failed' : undefined;
}

/**
 * Clears the index row of a tracked row that ended without recording; the end's own failure is logged and settles
 * nothing, so it never changes the row's outcome (successors then wait for the row's deadline, as before the index).
 */
export async function writeALOutboundTrackIndexEnd<TPrepared>(
    store: Pick<ALOutboundAdmissionStore<TPrepared>, 'readStoredMessage' | 'commitOrderingMessageEnd'>,
    msg: ALMessage | undefined,
    cause: ALOutboundTrackIndexEndCause<TPrepared>
): Promise<void> {
    const end = toALOutboundTrackIndexEnd(msg, cause);
    if (end === undefined) {
        return;
    }
    try {
        const record = toCommittedRecord(cause) ?? await store.readStoredMessage(end.msgId);
        if (leavesSequencePending(cause, record)) {
            await store.commitOrderingMessageEnd(end);
        }
    }
    catch (error) {
        console.error('Outbound track index end failed', { msgId: end.msgId, error });
    }
}

/** The track sequence a terminal end of a tracked row may clear; none for a row still to retry or with no track. */
export function toALOutboundTrackIndexEnd<TPrepared>(
    msg: ALMessage | undefined,
    cause: ALOutboundTrackIndexEndCause<TPrepared>
): ALOutboundTrackIndexEnd | undefined {
    const trackKey = msg === undefined ? undefined : toALOrderingTrackKey(msg);
    const seq = msg?.ordering?.seq;
    return msg === undefined || trackKey === undefined || seq === undefined || !isTerminalEnd(cause)
        ? undefined
        : { trackKey, seq, msgId: msg.id.msgId };
}

/**
 * Whether a terminal end leaves its sequence pending for its successors: the row recorded no positions (no stored
 * row, or none recorded on it). A row that recorded keeps its index for repair by sequence, and so does a delivered
 * row that was never to record (no durable audience), since no successor waits for it.
 */
export function leavesSequencePending<TPrepared>(
    cause: ALOutboundTrackIndexEndCause<TPrepared>,
    record: ALOutboundTrackIndexRecord | undefined
): boolean {
    if (record === undefined) {
        return true;
    }
    return record.sentPositions === null &&
        (!isDeliveredEnd(cause) || (record.policy.persist && record.policy.admittedAudience !== undefined));
}

/** `completed` or a failure for good; deferred, pending and `no-route` retry to their deadline. */
function isTerminalEnd<TPrepared>(cause: ALOutboundTrackIndexEndCause<TPrepared>): boolean {
    if (typeof cause !== 'object') {
        return cause !== undefined;
    }
    const { verdict } = cause;
    return verdict.kind !== 'deferred' && verdict.kind !== 'pending' &&
        !(verdict.kind === 'unroutable' && verdict.reason === 'no-route');
}

function isDeliveredEnd<TPrepared>(cause: ALOutboundTrackIndexEndCause<TPrepared>): boolean {
    return typeof cause === 'object' && (cause.verdict.kind === 'admitted' || cause.verdict.kind === 'duplicate');
}

/** The record the end's own commit wrote, when it wrote one. */
function toCommittedRecord<TPrepared>(
    cause: ALOutboundTrackIndexEndCause<TPrepared>
): ALOutboundTrackIndexRecord | undefined {
    const sent = typeof cause === 'object'
        ? cause.bundle?.mutations.find((mutation) => mutation.kind === 'set-sent-message')
        : undefined;
    return sent?.kind === 'set-sent-message' ? sent : undefined;
}
