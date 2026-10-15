import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../../computed-data-validation.ts';
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
    return {
        summaryWrite: first.summaryWrite,
        downstreamOutboxWrites: expansions.flatMap((expansion) => expansion.downstreamOutboxWrites),
        topologyReplan: resolveCoalescedTopologyReplan(expansions, last),
        reservationFinishes: expansions.map((expansion) => expansion.reservationFinish)
    };
}

export function validateGroupPresenceSummaryCoalescedWrite(
    expansions: readonly GroupPresenceSummaryComputedWork[],
    computed: GroupPresenceSummaryCoalescedWrite
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeGroupPresenceSummaryCoalescedWrite(expansions), computed, 'coalesced');
}

/** A commanded replan always runs, so it wins over the automatic decision the other expansions share. */
function resolveCoalescedTopologyReplan(
    expansions: readonly GroupPresenceSummaryComputedWork[],
    last: GroupPresenceSummaryComputedWork
): TopologyReplanDecision {
    const commanded = expansions.find(
        (expansion) =>
            expansion.topologyReplan.decision === 'enqueue' &&
            toTopologyReplanOrigin(expansion.work) === 'commanded'
    );
    return commanded?.topologyReplan ?? last.topologyReplan;
}
