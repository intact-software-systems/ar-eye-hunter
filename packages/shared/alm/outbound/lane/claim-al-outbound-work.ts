import { EntityStatus, toKeyAsString, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';

/** Of a queued backlog, the rows a newer row makes redundant, and the newer rows that make them so. */
export interface ALOutboundDequeueCoalescing {
    readonly superseded: readonly ResourceEntry[];
    readonly survivors: readonly ResourceEntry[];
}

/** Pure: given new queued rows oldest first, which of them a later row of the same list supersedes. */
export type ALOutboundDequeueCoalescer = (entries: readonly ResourceEntry[]) => ALOutboundDequeueCoalescing;

export interface ALOutboundCoalescedClaims {
    readonly claims: readonly ALWorkClaim[];
    /** The claims that complete unsent: their survivor is claimed beside them, or already left the queue. */
    readonly superseded: ReadonlySet<ALWorkClaim>;
}

export interface ClaimALOutboundWorkInput {
    readonly port: ALWorkQueuePort;
    readonly pageSize: number;
    readonly dequeueTypes: ReadonlySet<string>;
    /** Absent, the lane claims in queue order only. */
    readonly resolveCoalescing: ALOutboundDequeueCoalescer | undefined;
}

/** How many new rows one pass reads to coalesce: a formation's whole backlog on the hosted 50 is under 200. */
export const AL_OUTBOUND_COALESCING_SCAN_LIMIT = 256;

/** One batch's claims: the coalesced ones first, where the lane coalesces, then a page in queue order. */
export async function claimALOutboundWork(input: ClaimALOutboundWorkInput): Promise<ALOutboundCoalescedClaims> {
    const { port, pageSize, dequeueTypes, resolveCoalescing } = input;
    const coalesced = resolveCoalescing === undefined || dequeueTypes.size === 0
        ? { claims: [], superseded: new Set<ALWorkClaim>() }
        : await claimALOutboundCoalescedWork(port, dequeueTypes, resolveCoalescing);
    const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
    return { claims: [...coalesced.claims, ...claims], superseded: coalesced.superseded };
}

/**
 * Reads the new backlog once and claims every superseded row together with the row that supersedes it, so the
 * newest state of a coalescing key leaves in this pass instead of after every older row before it.
 */
async function claimALOutboundCoalescedWork(
    port: ALWorkQueuePort,
    dequeueTypes: ReadonlySet<string>,
    resolveCoalescing: ALOutboundDequeueCoalescer
): Promise<ALOutboundCoalescedClaims> {
    const page = await port.readPage({
        status: EntityStatus.NEW,
        maxToRead: AL_OUTBOUND_COALESCING_SCAN_LIMIT,
        cursor: null
    });
    const coalescing = resolveCoalescing(page.entries.filter((entry) => dequeueTypes.has(entry.typeId)));
    if (coalescing.superseded.length === 0) {
        return { claims: [], superseded: new Set() };
    }
    const claims = await port.claimObserved([...coalescing.superseded, ...coalescing.survivors]);
    const supersededKeys = new Set(coalescing.superseded.map((entry) => toKeyAsString(entry.key)));
    return {
        claims,
        superseded: new Set(claims.filter((claim) => supersededKeys.has(toKeyAsString(claim.entry.key))))
    };
}
