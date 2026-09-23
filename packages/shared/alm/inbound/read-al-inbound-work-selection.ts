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
import type { ALInboundDurableEffect, ALPersistedInboundEffect } from './al-inbound-admission-store.ts';
import type {
    ALInboundAdmittedDelivery,
    ALInboundDeliveryObservation
} from './al-inbound-admitted-delivery.ts';
import type { ALInboundDeferredEffect } from './al-inbound-runtime-diagnostics.ts';
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
    /** Due rows the eligibility read held back, in observation order: work the page saw and did not clear. */
    readonly deferred: readonly ALInboundDeferredEffect[];
    /** Every decoded row the read cleared, by queue slot, so one the port leaves unreserved can still be named. */
    readonly claimableEffects: ReadonlyMap<ResourceEntryKeyString, ALInboundDeferredEffect>;
    /** The durable kind the read decoded for each claimable row, by queue slot: the batch's own run-order key. */
    readonly effectKinds: ReadonlyMap<ResourceEntryKeyString, ALInboundDurableEffect['kind']>;
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

interface ReadALInboundClaimedSelectionInput {
    readonly page: ALInboundRotationPage;
    readonly port: ALWorkQueuePort;
    readonly pageSize: number;
    readonly nowMs: () => number;
}

/** What one round claimed, with the eligibility surfaces of exactly the rows the port reserved. */
interface ALInboundClaimedSelection {
    readonly selection: ALWorkReadySelection;
    readonly observations: ReadonlyMap<string, ALInboundDeliveryObservation>;
    readonly unreservedDue: readonly ALInboundDeferredEffect[];
}

/** One row's eligibility surface, under the queue slot it was read for, so a claim can be matched to it. */
interface ALInboundClaimableObservation {
    readonly key: ResourceEntryKeyString;
    readonly observed: ALInboundDeliveryObservation;
}

/** What the eligibility read decided about one page, before the port reserves anything from it. */
interface ALInboundPageEligibility extends
    Pick<
        ALInboundWorkSelection,
        | 'claimable'
        | 'observations'
        | 'unleasedReservations'
        | 'deferred'
        | 'claimableEffects'
        | 'effectKinds'
    > {
    /** The earliest time a row this page passed over becomes claimable. */
    readonly readyAtMs: number | undefined;
}

/** What one row's eligibility read decided, before the page folds it into its lists. */
type ALInboundRowEligibility =
    | Readonly<{ kind: 'not-due'; readyAtMs: number; }>
    | Readonly<{
        kind: 'claimable';
        effect: ALPersistedInboundEffect;
        observed: ALInboundDeliveryObservation | undefined;
    }>
    | Readonly<{ kind: 'deferred'; effect: ALPersistedInboundEffect; }>;

/** The held page and the scan position it advanced: what the probe reads and the batch then claims from. */
interface ALInboundRotationPage {
    readSelection(port: ALWorkQueuePort, pageSize: number): Promise<ALInboundWorkSelection>;
    /** Drops the held page, so the round that follows reads a fresh one. */
    forgetSelection(pending: Promise<ALInboundWorkSelection>): void;
    restartScan(): void;
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
     * it, for a row the read cleared that the port did not reserve, and for every row once the next
     * page or a restarted scan replaces this one.
     */
    getDeliveryObservation(effectId: string): ALInboundDeliveryObservation | undefined;
    /**
     * The due rows the last batch's page saw and did not hand it: held back by eligibility, or left
     * unreserved by the port. A row reserved by a live lease is not due, so a batch's own rows never
     * appear here.
     */
    getUnreservedDue(): readonly ALInboundDeferredEffect[];
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
        deferred: eligibility.deferred,
        claimableEffects: eligibility.claimableEffects,
        effectKinds: eligibility.effectKinds,
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
    let page: ALInboundPageEligibility = {
        claimable: [],
        observations: new Map(),
        unleasedReservations: [],
        deferred: [],
        claimableEffects: new Map(),
        effectKinds: new Map(),
        readyAtMs: undefined
    };
    for (const entry of entries) {
        if (entry.audit.expiryTs.epochMilliseconds <= input.nowMs) {
            continue;
        }
        try {
            const row = await readALInboundRowEligibility(entry, input, delivery);
            page = computeALInboundPageEligibilityWithRow(page, entry, row);
        }
        catch (error) {
            if (!(error instanceof ALAdmissionCorruptionError) && !(error instanceof NonRetryableException)) {
                throw error;
            }
            page = entry.status === EntityStatus.RESERVED && entry.dequeueAudit.startTs === undefined
                ? {
                    ...page,
                    unleasedReservations: [...page.unleasedReservations, toUnleasedALWorkClaim(entry, input.nowMs)]
                }
                : { ...page, claimable: [...page.claimable, entry] };
        }
    }
    return page;
}

/** The page with one more row's decision in it: a page holds at most one page size of rows. */
function computeALInboundPageEligibilityWithRow(
    page: ALInboundPageEligibility,
    entry: ResourceEntry,
    row: ALInboundRowEligibility
): ALInboundPageEligibility {
    if (row.kind === 'not-due') {
        return { ...page, readyAtMs: resolveALInboundScannedReadyAtMs(entry, row.readyAtMs, page.readyAtMs) };
    }
    const due = { effectId: row.effect.effectId, dueAtMs: resolveALInboundWorkDueAtMs(entry) };
    if (row.kind === 'deferred') {
        return { ...page, deferred: [...page.deferred, due] };
    }
    const key = toKeyAsString(entry.key);
    return {
        ...page,
        claimable: [...page.claimable, entry],
        claimableEffects: new Map(page.claimableEffects).set(key, due),
        effectKinds: new Map(page.effectKinds).set(key, row.effect.payload.kind),
        observations: row.observed === undefined
            ? page.observations
            : new Map(page.observations).set(row.effect.effectId, { key, observed: row.observed })
    };
}

/** A retained admission is claimable as soon as it is due; every other effect asks its delivery. */
async function readALInboundRowEligibility(
    entry: ResourceEntry,
    input: ALInboundWorkSelectionReadInput,
    delivery: ALInboundAdmittedDelivery
): Promise<ALInboundRowEligibility> {
    const readyAt = resolveALInboundWorkReadyAt(entry);
    if (readyAt > input.nowMs) {
        return { kind: 'not-due', readyAtMs: readyAt };
    }
    const effect = decodeALInboundWorkEntry(entry, input.namespace);
    if (effect.payload.kind === 'admit-message') {
        return { kind: 'claimable', effect, observed: undefined };
    }
    const readiness = await delivery.readReadiness(effect, input.nowMs);
    return readiness.ready
        ? { kind: 'claimable', effect, observed: readiness.observed }
        : { kind: 'deferred', effect };
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
    const page = createALInboundRotationPage(dependencies);
    let claimedObservations: ReadonlyMap<string, ALInboundDeliveryObservation> = new Map();
    let unreservedDue: readonly ALInboundDeferredEffect[] = [];
    return {
        readNextReadyAtMs: (port) => readALInboundNextReadyAtMs(page, port, dependencies.nowMs),
        selectReady: async (port, pageSize) => {
            const claimed = await readALInboundClaimedSelection({ page, port, pageSize, nowMs: dependencies.nowMs });
            claimedObservations = claimed.observations;
            unreservedDue = claimed.unreservedDue;
            return claimed.selection;
        },
        getDeliveryObservation: (effectId) => claimedObservations.get(effectId),
        getUnreservedDue: () => unreservedDue,
        restartScan: () => {
            page.restartScan();
            claimedObservations = new Map();
        }
    };
}

/**
 * The probe's own answer. A rotation that still owes a page is due to the probe, never to the batch
 * that follows, so only an exhausted one reports a real time -- and that one must observe a fresh
 * page next.
 */
async function readALInboundNextReadyAtMs(
    page: ALInboundRotationPage,
    port: ALWorkQueuePort,
    nowMs: () => number
): Promise<number | undefined> {
    const pending = page.readSelection(port, AL_INBOUND_WORK_PAGE_SIZE);
    let selection: ALInboundWorkSelection;
    try {
        selection = await pending;
    }
    catch (error) {
        page.forgetSelection(pending);
        throw error;
    }
    if (selection.readyNow) {
        return nowMs();
    }
    page.forgetSelection(pending);
    return selection.nextReadyAtMs;
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
    const { page, port, pageSize, nowMs } = input;
    const selectionStartedAtMs = nowMs();
    const pending = page.readSelection(port, pageSize);
    page.forgetSelection(pending);
    const selection = await pending;
    const claimStartedAtMs = nowMs();
    const claims = await port.claim({ maxCount: pageSize, observedEntries: selection.claimable });
    const claimedAtMs = nowMs();
    const claimedKeys = new Set(claims.map((claim) => toKeyAsString(claim.entry.key)));
    return {
        selection: {
            claims: computeALInboundClaimOrder([...selection.unleasedReservations, ...claims], selection.effectKinds),
            nextReadyAtMs: selection.nextReadyAtMs,
            selectionDurationMs: Math.max(0, claimStartedAtMs - selectionStartedAtMs),
            claimDurationMs: Math.max(0, claimedAtMs - claimStartedAtMs),
            earliestDueAtMs: computeEarliestALInboundDueAtMs(
                toClaimedALInboundEntries(selection, claimedKeys)
            )
        },
        observations: toClaimedALInboundObservations(selection.observations, claimedKeys),
        unreservedDue: [...selection.deferred, ...toUnreservedClaimableDue(selection, claimedKeys)]
    };
}

/**
 * The batch's run order: page deliveries first, then admission replays and rows whose kind the
 * page never decoded, then control sends and forwards. Stable within each rank, so page order
 * still decides among equals.
 */
export function computeALInboundClaimOrder(
    claims: readonly ALWorkClaim[],
    effectKinds: ReadonlyMap<ResourceEntryKeyString, ALInboundDurableEffect['kind']>
): readonly ALWorkClaim[] {
    return [...claims].sort((left, right) =>
        toALInboundClaimRank(effectKinds.get(toKeyAsString(left.entry.key))) -
        toALInboundClaimRank(effectKinds.get(toKeyAsString(right.entry.key)))
    );
}

/** A row whose kind never decoded ranks with the admission replays: both are read again before delivery. */
function toALInboundClaimRank(kind: ALInboundDurableEffect['kind'] | undefined): 0 | 1 | 2 {
    switch (kind) {
        case 'dispatch-local':
        case 'release-buffered':
            return 0;
        case 'admit-control':
        case 'admit-message':
        case undefined:
            return 1;
        case 'forward-message':
        case 'send-control':
            return 2;
    }
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

/** A row the page cleared that the port did not reserve: due, seen, and handed to no batch. */
function toUnreservedClaimableDue(
    selection: ALInboundWorkSelection,
    claimedKeys: ReadonlySet<ResourceEntryKeyString>
): readonly ALInboundDeferredEffect[] {
    return [...selection.claimableEffects]
        .filter(([key]) => !claimedKeys.has(key))
        .map(([, due]) => due);
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

/** The one page a rotation round holds between its readiness probe and the batch that follows it. */
function createALInboundRotationPage(
    dependencies: ALInboundWorkSelectorDependencies
): ALInboundRotationPage {
    let scan: ALInboundWorkScan = SCAN_START;
    let observed: Promise<ALInboundWorkSelection> | undefined;
    return {
        readSelection: (port, pageSize) => {
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
        },
        forgetSelection: (pending) => {
            if (observed === pending) {
                observed = undefined;
            }
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
