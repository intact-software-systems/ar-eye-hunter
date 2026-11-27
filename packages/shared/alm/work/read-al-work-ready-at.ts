import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { isALWorkLeaseSweepDeferred, type ALWorkLeaseSweepState } from './al-work-lease-recovery.ts';
import { computeALWorkLeaseUntilMs, type ALWorkQueuePort } from './al-work-queue-port.ts';

/**
 * Pending rows are read in due order, so the page holds the earliest of them. A reserved row is due at its lease end,
 * which no store orders by: its page stays in key order.
 */
const AL_WORK_READINESS_SCANS = [
    { status: EntityStatus.NEW, order: 'due' },
    { status: EntityStatus.RETRY, order: 'due' },
    { status: EntityStatus.RESERVED, order: 'key' }
] as const;

export interface ReadALWorkReadyAtInput {
    readonly nowMs: number;
    readonly pageSize: number;
    readonly leaseMs: number;
    readonly leaseSweeps: ALWorkLeaseSweepState;
    /** The time an owner's own gate holds a row to; undefined leaves the row's own ready time. */
    readonly readHeldUntilMs: (entry: ResourceEntry) => number | undefined;
}

/**
 * When the row is next claimable: a reserved row at its lease end, any other at its `nextTs`, else when it was
 * created. A reserved row without its reservation start throws `NonRetryableException`.
 */
export function resolveALWorkEntryReadyAt(entry: ResourceEntry, leaseMs: number): number {
    if (entry.status === EntityStatus.RESERVED) {
        if (entry.dequeueAudit.startTs === undefined) {
            throw new NonRetryableException('Work reservation start is missing');
        }
        return computeALWorkLeaseUntilMs(entry, leaseMs);
    }
    return resolveALWorkEntryDueAtMs(entry);
}

/** When the row came due, whatever status it carries: its `nextTs`, else when it was created. */
export function resolveALWorkEntryDueAtMs(entry: ResourceEntry): number {
    return Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ?? entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds
    );
}

/**
 * Retained work is due now, retried work at its own `nextTs`, gated work no earlier than its owner's gate allows,
 * and an expired row is never advertised. A reserved row is advertised at its lease end only while the sweep that
 * recovers it may run: a closed sweep would leave every batch it started empty. A page that held more rows than it
 * returned and holds a due row answers `nowMs`: one status never hides the next. A pending status's page holds each
 * work type's earliest live rows: the queue reads a `due` page past expired rows, so expired rows awaiting the
 * queue's expiry cleanup never hide a due row, and the port keeps every type's page whole, so a gated type's rows,
 * rated later than their own next time, never take the place of another type's due row. The reserved page stays in
 * key order and still returns expired rows: a truncated page whose visible rows are all expired or gated answers
 * from those rows alone. Every status is read in one scan, so the probe the engine runs on each round costs one
 * round trip to storage.
 */
export async function readALWorkReadyAt(
    port: ALWorkQueuePort,
    input: ReadALWorkReadyAtInput
): Promise<number | undefined> {
    const scans = await port.readPages(
        AL_WORK_READINESS_SCANS.map((scan) => ({ ...scan, maxToRead: input.pageSize }))
    );
    let readyAtMs: number | undefined;
    for (const scan of scans) {
        let hasDueEntry = false;
        for (const entry of scan.entries) {
            if (
                entry.audit.expiryTs.epochMilliseconds <= input.nowMs ||
                isALWorkLeaseSweepDeferred(entry, input.leaseSweeps)
            ) {
                continue;
            }
            const candidateAtMs = computeALWorkHeldReadyAt(entry, input);
            hasDueEntry ||= candidateAtMs <= input.nowMs;
            readyAtMs = Math.min(readyAtMs ?? candidateAtMs, candidateAtMs);
        }
        if (hasDueEntry && scan.hasMoreEntries) {
            return input.nowMs;
        }
    }
    return readyAtMs;
}

function computeALWorkHeldReadyAt(entry: ResourceEntry, input: ReadALWorkReadyAtInput): number {
    const readyAtMs = resolveALWorkEntryReadyAt(entry, input.leaseMs);
    const heldUntilMs = input.readHeldUntilMs(entry);
    return heldUntilMs === undefined ? readyAtMs : Math.max(readyAtMs, heldUntilMs);
}
