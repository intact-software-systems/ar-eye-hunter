import type { ResourceInboxWorkPage } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkReadySelection } from '../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { decodeALInboundWorkEntry, resolveALInboundWorkReadyAt } from './al-inbound-work-entry.ts';

const SCAN_STATUSES = [EntityStatus.NEW, EntityStatus.RETRY, EntityStatus.RESERVED] as const;
const SCAN_START = { cursor: null, statusIndex: 0, nextReadyAtMs: undefined } as const;

export const AL_INBOUND_WORK_PAGE_SIZE = 16;

interface ALInboundWorkScan {
    readonly cursor: ResourceInboxWorkPage.Cursor | null;
    readonly statusIndex: number;
    readonly nextReadyAtMs: number | undefined;
}

interface ALInboundWorkSelectionReadInput {
    readonly port: ALWorkQueuePort;
    readonly scan: ALInboundWorkScan;
    readonly namespace: string;
    readonly pageSize: number;
    readonly nowMs: number;
}

interface ALInboundWorkSelection {
    /** Entries the port may reserve, in observation order. */
    readonly claimable: readonly ResourceEntry[];
    /** Reservations without a lease start: timeout reservation can never reach them, so they are released as observed. */
    readonly unleasedReservations: readonly ALWorkClaim[];
    readonly scan: ALInboundWorkScan;
    /** Claimable work, or a rotation that still owes a page: one status never hides work on the next. */
    readonly readyNow: boolean;
    /**
     * What a batch that read this page advertises: `nowMs` only when the page held work it could
     * claim. An unfinished rotation is a scan, so it advertises the earliest scanned readiness and
     * lets the engine's own pass rate carry it to the next status.
     */
    readonly nextReadyAtMs: number | undefined;
}

interface ALInboundWorkSelectorDependencies {
    readonly delivery: ALInboundAdmittedDelivery;
    readonly namespace: string;
    readonly nowMs: () => number;
}

export interface ALInboundWorkSelector {
    /**
     * The readiness probe the handler asks for. The port reports every retained row as due; inbound
     * eligibility defers rows whose predecessor or consumer is missing, so the rotation answers instead.
     */
    readNextReadyAtMs(port: ALWorkQueuePort): Promise<number | undefined>;
    selectReady(port: ALWorkQueuePort, pageSize: number): Promise<ALWorkReadySelection>;
    /** A commit writes new work behind the rotation; the next page read starts over. */
    restartScan(): void;
}

/** Reads message eligibility before reservation so waiting work does not spend processing attempts. */
async function readALInboundWorkSelection(
    input: ALInboundWorkSelectionReadInput,
    delivery: ALInboundAdmittedDelivery
): Promise<ALInboundWorkSelection> {
    const page = await input.port.readPage({
        status: SCAN_STATUSES[input.scan.statusIndex],
        maxToRead: input.pageSize,
        cursor: input.scan.cursor
    });
    const claimable: ResourceEntry[] = [];
    const unleasedReservations: ALWorkClaim[] = [];
    let readyAtMs: number | undefined;
    for (const entry of page.entries) {
        if (entry.audit.expiryTs.epochMilliseconds <= input.nowMs) {
            continue;
        }
        try {
            const readyAt = resolveALInboundWorkReadyAt(entry);
            if (readyAt > input.nowMs) {
                // A row that expires before it is ready can never be claimed, so it advertises nothing.
                if (readyAt < entry.audit.expiryTs.epochMilliseconds) {
                    readyAtMs = Math.min(readyAtMs ?? readyAt, readyAt);
                }
                continue;
            }
            const effect = decodeALInboundWorkEntry(entry, input.namespace);
            if (effect.payload.kind === 'admit-message' || await delivery.readReadiness(effect, input.nowMs)) {
                claimable.push(entry);
            }
        }
        catch (error) {
            if (!(error instanceof ALAdmissionCorruptionError) && !(error instanceof NonRetryableException)) {
                throw error;
            }
            if (entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs === undefined) {
                unleasedReservations.push(toUnleasedALWorkClaim(entry, input.nowMs));
            }
            else {
                claimable.push(entry);
            }
        }
    }
    const statusIndex = page.nextCursor === null
        ? (input.scan.statusIndex + 1) % SCAN_STATUSES.length
        : input.scan.statusIndex;
    const continueScan = page.nextCursor !== null || statusIndex !== 0;
    const scannedReadyAtMs = readyAtMs === undefined
        ? input.scan.nextReadyAtMs
        : Math.min(input.scan.nextReadyAtMs ?? readyAtMs, readyAtMs);
    const claimableNow = claimable.length > 0 || unleasedReservations.length > 0;
    return {
        claimable,
        unleasedReservations,
        readyNow: claimableNow || continueScan,
        scan: {
            cursor: page.nextCursor,
            statusIndex,
            nextReadyAtMs: continueScan ? scannedReadyAtMs : undefined
        },
        nextReadyAtMs: claimableNow ? input.nowMs : scannedReadyAtMs
    };
}

/**
 * Rotates one bounded page across NEW, RETRY and RESERVED. The readiness probe and the batch that
 * follows it share one page read, so advertised work is the work the batch claims. An unfinished
 * rotation is due to the probe alone: the batch that reads a page with nothing claimable advertises
 * the next real ready time, so the engine's own pass rate carries the scan to the next status.
 */
export function createALInboundWorkSelector(
    dependencies: ALInboundWorkSelectorDependencies
): ALInboundWorkSelector {
    let scan: ALInboundWorkScan = SCAN_START;
    let observed: Promise<ALInboundWorkSelection> | undefined;

    const readSelection = (port: ALWorkQueuePort, pageSize: number): Promise<ALInboundWorkSelection> => {
        const scanned = scan;
        const pending = observed ?? readALInboundWorkSelection({
            port,
            scan: scanned,
            namespace: dependencies.namespace,
            pageSize,
            nowMs: dependencies.nowMs()
        }, dependencies.delivery).then((selection) => {
            if (scan === scanned) {
                scan = selection.scan;
            }
            return selection;
        });
        observed = pending;
        return pending;
    };
    const forgetSelection = (pending: Promise<ALInboundWorkSelection>): void => {
        if (observed === pending) {
            observed = undefined;
        }
    };
    return {
        readNextReadyAtMs: async (port) => {
            const pending = readSelection(port, AL_INBOUND_WORK_PAGE_SIZE);
            let selection: ALInboundWorkSelection;
            try {
                selection = await pending;
            }
            catch (error) {
                forgetSelection(pending);
                throw error;
            }
            if (!selection.readyNow) {
                // An exhausted rotation must observe a fresh page on the next probe.
                forgetSelection(pending);
                return selection.nextReadyAtMs;
            }
            // A rotation that still owes a page is due to the probe, never to the batch that follows.
            return dependencies.nowMs();
        },
        selectReady: async (port, pageSize) => {
            const pending = readSelection(port, pageSize);
            forgetSelection(pending);
            const selection = await pending;
            const claims = await port.claim({ maxCount: pageSize, observedEntries: selection.claimable });
            return {
                claims: [...selection.unleasedReservations, ...claims],
                nextReadyAtMs: selection.nextReadyAtMs
            };
        },
        restartScan: () => {
            scan = SCAN_START;
            observed = undefined;
        }
    };
}

function toUnleasedALWorkClaim(entry: ResourceEntry, nowMs: number): ALWorkClaim {
    return { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: nowMs };
}
