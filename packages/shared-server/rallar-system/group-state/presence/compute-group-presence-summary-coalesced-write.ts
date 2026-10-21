import type { GroupPresenceSummaryWorkData } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import type { ResourceInboxReservationFinish } from '../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import { isWithinStateSyncPayloadLimit } from '../../state-sync/state-sync-entry-computation.ts';
import {
    computeGroupStateDeltaEnvelope,
    toTopologyReplanOrigin,
    type GroupPresenceSummaryComputedWork,
    type GroupPresenceSummaryReservationRead,
    type GroupPresenceSummaryWorkRead,
    type GroupPresenceSummaryWrite,
    type TopologyReplanDecision
} from './group-presence-summary-effects.ts';

/** One summary work row and the reservation its finish must match. */
export interface GroupPresenceSummaryWorkItem {
    readonly work: GroupPresenceSummaryWorkData;
    readonly reservation: GroupPresenceSummaryReservationRead;
}

/** The claimed items one expansion writes, in causal order, and the claimed items it leaves to the next claim. */
export interface GroupPresenceSummaryPage {
    readonly items: readonly GroupPresenceSummaryWorkItem[];
    readonly deferred: readonly GroupPresenceSummaryWorkItem[];
}

export interface ComputeGroupPresenceSummaryPageInput {
    /** The reserved row first, then the claimed siblings in causal order. */
    readonly candidates: readonly GroupPresenceSummaryWorkItem[];
    /** The group read every candidate shares. */
    readonly read: GroupPresenceSummaryWorkRead;
    /** The reserved row expanded alone, whose summary and snapshot every page of this read shares. */
    readonly reservedExpansion: GroupPresenceSummaryComputedWork;
}

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

/**
 * The reserved row with as many of its siblings, earliest first, as one page can carry: the page's first delta carries
 * the merged slice of every event in it, and that delta must fit one AL payload. The reserved row always forms a page,
 * so a single event that does not fit fails its own expansion. A slice only grows as events join it.
 */
export function computeGroupPresenceSummaryPage(input: ComputeGroupPresenceSummaryPageInput): GroupPresenceSummaryPage {
    const { candidates } = input;
    if (fitsPage(input, candidates.length)) {
        return toPage(candidates, candidates.length);
    }
    let fitting = 1;
    let exceeding = candidates.length;
    while (exceeding - fitting > 1) {
        const size = Math.floor((fitting + exceeding) / 2);
        if (fitsPage(input, size)) {
            fitting = size;
        }
        else {
            exceeding = size;
        }
    }
    return toPage(candidates, fitting);
}

/** Every item's read of one shared group read, with the items' own events as the coalesced batch. */
export function toGroupPresenceSummaryWorkReads(
    items: readonly GroupPresenceSummaryWorkItem[],
    read: Omit<GroupPresenceSummaryWorkRead, 'reservation' | 'coalescedEvents'>
): readonly GroupPresenceSummaryWorkRead[] {
    const coalescedEvents = items.map((item) => item.work.event);
    return items.map((item) => ({
        nowEpochMs: read.nowEpochMs,
        reservation: {
            key: { ...item.reservation.key },
            expectedAttempts: item.reservation.expectedAttempts
        },
        presence: read.presence,
        coalescedEvents,
        coalescedTopologyEntry: read.coalescedTopologyEntry,
        topologyReplanPolicyFacts: read.topologyReplanPolicyFacts
    }));
}

export function sortGroupPresenceSummaryWorkByCausalOrder(
    items: readonly GroupPresenceSummaryWorkItem[]
): readonly GroupPresenceSummaryWorkItem[] {
    return [...items].sort((left, right) =>
        left.work.acceptedCausalRevision.groupRevision - right.work.acceptedCausalRevision.groupRevision ||
        left.work.acceptedCausalRevision.presenceRevision - right.work.acceptedCausalRevision.presenceRevision ||
        left.work.createdAtEpochMs - right.work.createdAtEpochMs ||
        left.work.commandId.localeCompare(right.work.commandId)
    );
}

function toPage(candidates: readonly GroupPresenceSummaryWorkItem[], size: number): GroupPresenceSummaryPage {
    return {
        items: sortGroupPresenceSummaryWorkByCausalOrder(candidates.slice(0, size)),
        deferred: candidates.slice(size)
    };
}

/** Whether the first delta of a page of the first `size` candidates fits one AL payload. */
function fitsPage(input: ComputeGroupPresenceSummaryPageInput, size: number): boolean {
    const items = sortGroupPresenceSummaryWorkByCausalOrder(input.candidates.slice(0, size));
    const { summary, snapshot } = input.reservedExpansion;
    return isWithinStateSyncPayloadLimit(computeGroupStateDeltaEnvelope({
        event: items[0]!.work.event,
        coalescedEvents: items.map((item) => item.work.event),
        summary,
        summaryPredecessorCausalRevision: input.read.presence.current?.value.causalRevision ?? null,
        snapshot
    }));
}
