import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { isCanonicalGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    sortGroupPresenceSummaryWorkByCausalOrder,
    type GroupPresenceSummaryWorkItem
} from './compute-group-presence-summary-page.ts';
import { decodeCanonicalGroupPresenceSummaryWork } from './decode-canonical-group-presence-summary-work.ts';
import type { GroupPresenceSummaryReservationRead } from './group-presence-summary-effects.ts';

/** The queue caps a work page at 256 rows; one page of pending APP_OUTBOX work per status is scanned per claim. */
const COALESCED_SUMMARY_WORK_SCAN_LIMIT = 256;

const COALESCED_SUMMARY_WORK_STATUSES = [EntityStatus.NEW, EntityStatus.RETRY] as const;

/**
 * Claims, through the queue, the same group's summary rows still waiting: new ones and due retries, among them the
 * rows an earlier page released unexpanded. An unchanged observation is the claim's guard, and a retry still in its
 * backoff is not due, so it is not claimed.
 */
export async function claimPendingGroupPresenceSummaryWork(
    outbox: QueueBoxResourceEntryRepository,
    entry: ResourceEntry
): Promise<readonly ResourceEntry[]> {
    const pages = await outbox.readWorkPages(COALESCED_SUMMARY_WORK_STATUSES.map((status) => ({
        typeId: EnqueuedType.APP_OUTBOX,
        status,
        maxToRead: COALESCED_SUMMARY_WORK_SCAN_LIMIT,
        cursor: null
    })));
    const pending = pages.flatMap((page) =>
        page.entries.filter((candidate) => isPendingSummaryWorkOfSameGroup(candidate, entry))
    );
    if (pending.length === 0) {
        return [];
    }
    const reserved = await outbox.reserveEntries({
        typeIds: new Set([EnqueuedType.APP_OUTBOX]),
        statusIds: new Set(COALESCED_SUMMARY_WORK_STATUSES),
        reservationInput: pending.length,
        observedEntries: pending
    });
    return [...reserved.values()];
}

/** A claimed row that was not expanded consumed no attempt; it goes back to the queue at once. */
export async function releaseUnexpandedGroupPresenceSummaryWork(
    outbox: QueueBoxResourceEntryRepository,
    claimed: readonly ResourceEntry[]
): Promise<void> {
    if (claimed.length === 0) {
        return;
    }
    try {
        await outbox.releaseEntries(
            claimed.map((entry) => ({
                entry,
                disposition: { status: EntityStatus.RETRY, delayMs: 1, reason: 'not-ready' }
            }))
        );
    }
    catch {
        // The expansion's own failure is the one to report; a claim this release could not return
        // is reclaimed by the queue's reservation timeout.
    }
}

export function toGroupPresenceSummaryWorkItem(message: ALMessage, entry: ResourceEntry): GroupPresenceSummaryWorkItem {
    return {
        work: decodeCanonicalGroupPresenceSummaryWork(message, entry),
        reservation: toReservationRead(entry),
        traceId: message.id.traceId
    };
}

/** The reserved row first, then its claimed siblings in causal order. */
export function toGroupPresenceSummaryCandidates(
    primary: GroupPresenceSummaryWorkItem,
    claimed: readonly ResourceEntry[]
): readonly GroupPresenceSummaryWorkItem[] {
    return [
        primary,
        ...sortGroupPresenceSummaryWorkByCausalOrder(
            claimed.map((sibling) =>
                toGroupPresenceSummaryWorkItem(decodePersistedALMessage(sibling.resource), sibling)
            )
        )
    ];
}

/** The claimed siblings a page left unexpanded. */
export function toDeferredGroupPresenceSummaryWork(
    claimed: readonly ResourceEntry[],
    deferred: readonly GroupPresenceSummaryWorkItem[]
): readonly ResourceEntry[] {
    return claimed.filter((sibling) => deferred.some((item) => isKeysEqual(item.reservation.key, sibling.key)));
}

function isPendingSummaryWorkOfSameGroup(candidate: ResourceEntry, entry: ResourceEntry): boolean {
    return candidate.key.topicId === entry.key.topicId &&
        candidate.key.contextId === entry.key.contextId &&
        !isKeysEqual(candidate.key, entry.key) &&
        isCanonicalGroupPresenceSummaryEntry(candidate);
}

function toReservationRead(entry: ResourceEntry): GroupPresenceSummaryReservationRead {
    return { key: entry.key, expectedAttempts: entry.dequeueAudit.attempts };
}
