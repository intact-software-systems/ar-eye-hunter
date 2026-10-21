import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type { ComputedCoalescedAppOutboxWork } from '../../app-outbox/coalesced-app-outbox-work.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import {
    resolveQueuedRtcTopologySuccessor,
    type QueuedRtcTopologySuccessor,
    type RtcTopologySuccessorRequest
} from '../../topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    toTopologyReplanOrigin,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryWrite,
    type TopologyReplanDecision
} from './group-presence-summary-effects.ts';

/**
 * One transaction's writes for every summary expansion of one group claimed
 * in the same tick: the expansions share one read, so they agree on the
 * summary row and the replan; each keeps its own delta row and reservation.
 */
export interface GroupPresenceSummaryCoalescedWrite {
    readonly summaryWrite: GroupPresenceSummaryWrite | null;
    readonly downstreamOutboxWrites: readonly AppOutboxInsert[];
    readonly topologyReplan: TopologyReplanDecision;
    /** The request the replan's successor carries, from the expansion that decided the replan; null when held. */
    readonly topologyReplanSuccessor: RtcTopologySuccessorRequest | null;
    readonly reservationFinishes: readonly ResourceInboxReservationFinish[];
}

export function computeGroupPresenceSummaryCoalescedWrite(
    expansions: readonly GroupPresenceSummaryComputedWork[]
): GroupPresenceSummaryCoalescedWrite {
    const first = expansions[0];
    const last = expansions[expansions.length - 1];
    if (first === undefined || last === undefined) {
        throw new TypeError('A coalesced presence summary write needs at least one expansion');
    }
    const replanning = resolveCoalescedTopologyReplanExpansion(expansions, last);
    return {
        summaryWrite: first.summaryWrite,
        downstreamOutboxWrites: expansions.flatMap((expansion) => expansion.downstreamOutboxWrites),
        topologyReplan: replanning.topologyReplan,
        topologyReplanSuccessor: replanning.topologyReplan.decision === 'enqueue'
            ? toTopologyReplanSuccessorRequest(replanning)
            : null,
        reservationFinishes: expansions.map((expansion) => expansion.reservationFinish)
    };
}

export function validateGroupPresenceSummaryCoalescedWrite(
    expansions: readonly GroupPresenceSummaryComputedWork[],
    computed: GroupPresenceSummaryCoalescedWrite
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeGroupPresenceSummaryCoalescedWrite(expansions), computed, 'coalesced');
}

/**
 * How a page writes its replan. Without a stored successor observed, the computed coalesced work is written, and a
 * row another writer queued meanwhile is a lost race. An observed successor that serves the request stands: the write
 * only guards that it is still stored as observed.
 */
export type GroupPresenceSummaryReplanWrite =
    | Readonly<{ write: 'none'; }>
    | Readonly<{ write: 'coalesced'; work: ComputedCoalescedAppOutboxWork; }>
    | Readonly<{ write: 'observed-successor'; observed: ResourceEntry; }>;

/** An observed successor that does not serve the request: one that must wait for the head, or another request. */
export interface GroupPresenceSummaryReplanIssue {
    readonly queued: Exclude<QueuedRtcTopologySuccessor, 'serves-request'>;
    readonly key: Key;
}

/** A page's writes: its coalesced summary, deltas and reservation finishes, and how its replan is written. */
export interface GroupPresenceSummaryPageWrite extends GroupPresenceSummaryCoalescedWrite {
    readonly replanWrite: GroupPresenceSummaryReplanWrite;
}

/**
 * The successor row a page's replan must observe before its transaction: only a head in flight makes the replan
 * write a successor, and only then can one already be stored for the same revision.
 */
export function toObservedReplanSuccessorKey(coalesced: GroupPresenceSummaryCoalescedWrite): Key | null {
    const replan = coalesced.topologyReplan;
    return replan.decision === 'enqueue' && replan.work.operation === 'write-successor'
        ? replan.work.successorWrite.entry.key
        : null;
}

/** The replan write for the successor observed before the transaction, or null when none was stored or none read. */
export function resolveGroupPresenceSummaryReplanWrite(
    coalesced: GroupPresenceSummaryCoalescedWrite,
    observedSuccessor: ResourceEntry | null
): Either<GroupPresenceSummaryReplanIssue, GroupPresenceSummaryReplanWrite> {
    const replan = coalesced.topologyReplan;
    const request = coalesced.topologyReplanSuccessor;
    if (replan.decision !== 'enqueue' || request === null) {
        return Either.ofRight({ write: 'none' });
    }
    if (observedSuccessor === null) {
        return Either.ofRight({ write: 'coalesced', work: replan.work });
    }
    const queued = resolveQueuedRtcTopologySuccessor(request, observedSuccessor);
    return queued === 'serves-request'
        ? Either.ofRight({ write: 'observed-successor', observed: observedSuccessor })
        : Either.ofLeft({ queued, key: observedSuccessor.key });
}

/** A commanded replan always runs, so it wins over the automatic decision the other expansions share. */
function resolveCoalescedTopologyReplanExpansion(
    expansions: readonly GroupPresenceSummaryComputedWork[],
    last: GroupPresenceSummaryComputedWork
): GroupPresenceSummaryComputedWork {
    const commanded = expansions.find(
        (expansion) =>
            expansion.topologyReplan.decision === 'enqueue' &&
            toTopologyReplanOrigin(expansion.work) === 'commanded'
    );
    return commanded ?? last;
}

/** The request the replan's successor carries, from the facts its computation took: room, snapshot revision, origin. */
function toTopologyReplanSuccessorRequest(expansion: GroupPresenceSummaryComputedWork): RtcTopologySuccessorRequest {
    return {
        overlayId: toScopedOverlayId(expansion.work.aggregateRef),
        sourceGroupStateCausalRevision: expansion.snapshot.causalRevision,
        origin: toTopologyReplanOrigin(expansion.work)
    };
}
