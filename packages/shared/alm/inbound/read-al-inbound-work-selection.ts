import type { ResourceInboxWorkPage } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkReadySelection } from '../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALInboundAdmittedDelivery,
    ALInboundDeliveryObservation
} from './al-inbound-admitted-delivery.ts';
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
    /** The surface the eligibility read took for each claimable row, by effect id. */
    readonly observations: ReadonlyMap<string, ALInboundDeliveryObservation>;
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

/** What the eligibility read decided about one page, before the port reserves anything from it. */
interface ALInboundPageEligibility
    extends Pick<ALInboundWorkSelection, 'claimable' | 'observations' | 'unleasedReservations'> {
    /** The earliest time a row this page passed over becomes claimable. */
    readonly readyAtMs: number | undefined;
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
    /**
     * What this batch's own eligibility read observed for the row it claimed, so the delivery that
     * follows re-reads none of it. Absent for a row the batch claimed without reading a surface for
     * it, and for every row once the next page or a restarted scan replaces this one.
     */
    getDeliveryObservation(effectId: string): ALInboundDeliveryObservation | undefined;
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
    const eligibility = await readALInboundPageEligibility(page.entries, input, delivery);
    const statusIndex = page.nextCursor === null
        ? (input.scan.statusIndex + 1) % SCAN_STATUSES.length
        : input.scan.statusIndex;
    const continueScan = page.nextCursor !== null || statusIndex !== 0;
    const readyAtMs = eligibility.readyAtMs;
    const scannedReadyAtMs = readyAtMs === undefined
        ? input.scan.nextReadyAtMs
        : Math.min(input.scan.nextReadyAtMs ?? readyAtMs, readyAtMs);
    const claimableNow = eligibility.claimable.length > 0 || eligibility.unleasedReservations.length > 0;
    return {
        claimable: eligibility.claimable,
        observations: eligibility.observations,
        unleasedReservations: eligibility.unleasedReservations,
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
 * One eligibility read per row the page holds, and the port then reserves at most the same page:
 * a row this returns as claimable is a row the batch that follows can take, and a row it defers
 * costs the batch nothing further.
 */
async function readALInboundPageEligibility(
    entries: readonly ResourceEntry[],
    input: ALInboundWorkSelectionReadInput,
    delivery: ALInboundAdmittedDelivery
): Promise<ALInboundPageEligibility> {
    const claimable: ResourceEntry[] = [];
    const observations = new Map<string, ALInboundDeliveryObservation>();
    const unleasedReservations: ALWorkClaim[] = [];
    let readyAtMs: number | undefined;
    for (const entry of entries) {
        if (entry.audit.expiryTs.epochMilliseconds <= input.nowMs) {
            continue;
        }
        try {
            const readyAt = resolveALInboundWorkReadyAt(entry);
            if (readyAt > input.nowMs) {
                readyAtMs = resolveALInboundScannedReadyAtMs(entry, readyAt, readyAtMs);
                continue;
            }
            const effect = decodeALInboundWorkEntry(entry, input.namespace);
            if (effect.payload.kind === 'admit-message') {
                claimable.push(entry);
                continue;
            }
            const readiness = await delivery.readReadiness(effect, input.nowMs);
            if (readiness.ready) {
                claimable.push(entry);
                if (readiness.observed !== undefined) {
                    observations.set(effect.effectId, readiness.observed);
                }
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
    return { claimable, observations, unleasedReservations, readyAtMs };
}

/** A row that expires before it is ready can never be claimed, so it advertises nothing. */
function resolveALInboundScannedReadyAtMs(
    entry: ResourceEntry,
    readyAt: number,
    scanned: number | undefined
): number | undefined {
    return readyAt < entry.audit.expiryTs.epochMilliseconds ? Math.min(scanned ?? readyAt, readyAt) : scanned;
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
    let claimedObservations: ReadonlyMap<string, ALInboundDeliveryObservation> = new Map();

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
            claimedObservations = selection.observations;
            return {
                claims: [...selection.unleasedReservations, ...claims],
                nextReadyAtMs: selection.nextReadyAtMs
            };
        },
        getDeliveryObservation: (effectId) => claimedObservations.get(effectId),
        restartScan: () => {
            scan = SCAN_START;
            observed = undefined;
            claimedObservations = new Map();
        }
    };
}

function toUnleasedALWorkClaim(entry: ResourceEntry, nowMs: number): ALWorkClaim {
    return { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: nowMs };
}
