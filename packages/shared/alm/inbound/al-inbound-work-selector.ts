import type { ResourceInboxWorkPage } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import {
    EntityStatus,
    toKeyAsString,
    type ResourceEntry,
    type ResourceEntryKeyString
} from '../../queuebox/ResourceEntry.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkReadySelection } from '../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALInboundAdmittedDelivery,
    ALInboundDeliveryObservation
} from './al-inbound-admitted-delivery.ts';
import {
    decodeALInboundWorkEntry,
    resolveALInboundWorkDueAtMs,
    resolveALInboundWorkReadyAt
} from './al-inbound-work-entry.ts';

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
    readonly observations: ReadonlyMap<string, ALInboundClaimableObservation>;
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

/** What one round claimed, with the eligibility surfaces of exactly the rows the port reserved. */
interface ALInboundClaimedSelection {
    readonly selection: ALWorkReadySelection;
    readonly observations: ReadonlyMap<string, ALInboundDeliveryObservation>;
}

/** One row's eligibility surface, under the queue slot it was read for, so a claim can be matched to it. */
interface ALInboundClaimableObservation {
    readonly key: ResourceEntryKeyString;
    readonly observed: ALInboundDeliveryObservation;
}

/** What the eligibility read decided about one page, before the port reserves anything from it. */
interface ALInboundPageEligibility
    extends Pick<ALInboundWorkSelection, 'claimable' | 'observations' | 'unleasedReservations'> {
    /** The earliest time a row this page passed over becomes claimable. */
    readonly readyAtMs: number | undefined;
}

interface ReadALInboundClaimedSelectionInput {
    readonly selection: ALInboundWorkSelection;
    readonly port: ALWorkQueuePort;
    readonly pageSize: number;
    readonly nowMs: () => number;
    readonly selectionStartedAtMs: number;
}

export namespace ALInboundWorkSelector {
    export interface Dependencies {
        readonly delivery: ALInboundAdmittedDelivery;
        readonly namespace: string;
        readonly nowMs: () => number;
    }
}

/** Owns the natural status rotation and the page shared by readiness and reservation. */
export class ALInboundWorkSelector {
    private readonly dependencies: ALInboundWorkSelector.Dependencies;
    private scan: ALInboundWorkScan = SCAN_START;
    private observed: Promise<ALInboundWorkSelection> | undefined;
    private claimedObservations: ReadonlyMap<string, ALInboundDeliveryObservation> = new Map();

    constructor(dependencies: ALInboundWorkSelector.Dependencies) {
        this.dependencies = dependencies;
    }

    /** An unfinished rotation is due to the probe; an exhausted one advertises actual readiness. */
    async readNextReadyAtMs(port: ALWorkQueuePort): Promise<number | undefined> {
        const pending = this.readSelection(port, AL_INBOUND_WORK_PAGE_SIZE);
        let selection: ALInboundWorkSelection;
        try {
            selection = await pending;
        }
        catch (error) {
            this.forgetSelection(pending);
            throw error;
        }
        if (selection.readyNow) {
            return this.dependencies.nowMs();
        }
        this.forgetSelection(pending);
        return selection.nextReadyAtMs;
    }

    async selectReady(port: ALWorkQueuePort, pageSize: number): Promise<ALWorkReadySelection> {
        const selectionStartedAtMs = this.dependencies.nowMs();
        const pending = this.readSelection(port, pageSize);
        this.forgetSelection(pending);
        const selection = await pending;
        const claimed = await readALInboundClaimedSelection({
            selection,
            port,
            pageSize,
            nowMs: this.dependencies.nowMs,
            selectionStartedAtMs
        });
        this.claimedObservations = claimed.observations;
        return claimed.selection;
    }

    /** Only surfaces matched to a successful reservation survive until the next selection. */
    getDeliveryObservation(effectId: string): ALInboundDeliveryObservation | undefined {
        return this.claimedObservations.get(effectId);
    }

    private readSelection(port: ALWorkQueuePort, pageSize: number): Promise<ALInboundWorkSelection> {
        this.observed ??= readALInboundWorkSelection({
            port,
            scan: this.scan,
            namespace: this.dependencies.namespace,
            pageSize,
            nowMs: this.dependencies.nowMs()
        }, this.dependencies.delivery).then((selection) => {
            this.scan = selection.scan;
            return selection;
        });
        return this.observed;
    }

    private forgetSelection(pending: Promise<ALInboundWorkSelection>): void {
        if (this.observed === pending) {
            this.observed = undefined;
        }
    }
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
    const observations = new Map<string, ALInboundClaimableObservation>();
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
                    observations.set(effect.effectId, {
                        key: toKeyAsString(entry.key),
                        observed: readiness.observed
                    });
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
 * One rotation round's claim, timed in the two halves a slow drain has to be split into: the page
 * read with its eligibility reads, and the port's reservation of what that read cleared. The wait it
 * reports is read from the observed page, because the reservation that follows replaces a row's own
 * due stamp with its lease, and it covers every row the batch takes -- the unleased reservations
 * included, since those are claims the port itself never made.
 */
async function readALInboundClaimedSelection(
    input: ReadALInboundClaimedSelectionInput
): Promise<ALInboundClaimedSelection> {
    const { selection, port, pageSize, nowMs, selectionStartedAtMs } = input;
    const claimStartedAtMs = nowMs();
    const claims = await port.claim({ maxCount: pageSize, observedEntries: selection.claimable });
    const claimedAtMs = nowMs();
    const claimedKeys = new Set(claims.map((claim) => toKeyAsString(claim.entry.key)));
    return {
        selection: {
            claims: [...selection.unleasedReservations, ...claims],
            nextReadyAtMs: selection.nextReadyAtMs,
            selectionDurationMs: Math.max(0, claimStartedAtMs - selectionStartedAtMs),
            claimDurationMs: Math.max(0, claimedAtMs - claimStartedAtMs),
            earliestDueAtMs: computeEarliestALInboundDueAtMs(
                toClaimedALInboundEntries(selection, claimedKeys)
            )
        },
        observations: toClaimedALInboundObservations(selection.observations, claimedKeys)
    };
}

/**
 * Every row this selection hands the batch, as the page observed it before any reservation: the ones
 * the port reserved, and the unleased reservations the page recovered itself, which the port never
 * sees and which a batch of nothing else would otherwise report as no wait at all.
 */
function toClaimedALInboundEntries(
    selection: ALInboundWorkSelection,
    claimedKeys: ReadonlySet<ResourceEntryKeyString>
): readonly ResourceEntry[] {
    return [
        ...selection.unleasedReservations.map((claim) => claim.entry),
        ...selection.claimable.filter((entry) => claimedKeys.has(toKeyAsString(entry.key)))
    ];
}

/** The earliest of those rows' own due times, which is the wait the batch reports. */
function computeEarliestALInboundDueAtMs(entries: readonly ResourceEntry[]): number | undefined {
    let earliest: number | undefined;
    for (const entry of entries) {
        const dueAtMs = resolveALInboundWorkDueAtMs(entry);
        earliest = earliest === undefined ? dueAtMs : Math.min(earliest, dueAtMs);
    }
    return earliest;
}

/** A row the page cleared but the port did not reserve is delivered by no one, so its surface is dropped. */
function toClaimedALInboundObservations(
    observations: ReadonlyMap<string, ALInboundClaimableObservation>,
    claimedKeys: ReadonlySet<ResourceEntryKeyString>
): ReadonlyMap<string, ALInboundDeliveryObservation> {
    const claimed = new Map<string, ALInboundDeliveryObservation>();
    for (const [effectId, observation] of observations) {
        if (claimedKeys.has(observation.key)) {
            claimed.set(effectId, observation.observed);
        }
    }
    return claimed;
}

function toUnleasedALWorkClaim(entry: ResourceEntry, nowMs: number): ALWorkClaim {
    return { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: nowMs };
}
