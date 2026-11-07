import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';

/** How a dequeued row's attempt ended: superseded at its read, failed for good, its commit, or nothing dispatched. */
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

/** A failed attempt ends its row only when its work fails for good: non-retryable or corrupt. */
export function toALOutboundFailedTrackIndexEndCause(error: Error): 'failed' | undefined {
    return error instanceof NonRetryableException || error instanceof ALAdmissionCorruptionError ? 'failed' : undefined;
}

/** Clears the index row of a tracked row whose end leaves its sequence pending; every other end writes nothing. */
export async function writeALOutboundTrackIndexEnd<TPrepared>(
    store: Pick<ALOutboundAdmissionStore<TPrepared>, 'commitOrderingMessageEnd'>,
    msg: ALMessage | undefined,
    cause: ALOutboundTrackIndexEndCause<TPrepared>
): Promise<void> {
    const end = toALOutboundTrackIndexEnd(msg, cause);
    if (end !== undefined) {
        await store.commitOrderingMessageEnd(end);
    }
}

/**
 * The index row a tracked row's end clears: one that ended without recording leaves its sequence pending for its
 * successors until its deadline otherwise. A row that recorded, or that no successor waits for, keeps its index, and
 * an expired one needs no write.
 */
export function toALOutboundTrackIndexEnd<TPrepared>(
    msg: ALMessage | undefined,
    cause: ALOutboundTrackIndexEndCause<TPrepared>
): ALOutboundTrackIndexEnd | undefined {
    const trackKey = msg === undefined ? undefined : toALOrderingTrackKey(msg);
    const seq = msg?.ordering?.seq;
    return msg === undefined || trackKey === undefined || seq === undefined || !leavesSequencePending(cause)
        ? undefined
        : { trackKey, seq, msgId: msg.id.msgId };
}

/** Superseded or failed, refused, or committed with no positions recorded under a policy that records them. */
function leavesSequencePending<TPrepared>(cause: ALOutboundTrackIndexEndCause<TPrepared>): boolean {
    if (cause === undefined) {
        return false;
    }
    if (
        cause === 'superseded' || cause === 'failed' || cause.verdict.kind === 'superseded' ||
        cause.verdict.kind === 'refused'
    ) {
        return true;
    }
    const sent = cause.bundle?.mutations.find((mutation) => mutation.kind === 'set-sent-message');
    return sent?.kind === 'set-sent-message' && sent.sentPositions === null && sent.policy.persist &&
        sent.policy.admittedAudience !== undefined;
}
