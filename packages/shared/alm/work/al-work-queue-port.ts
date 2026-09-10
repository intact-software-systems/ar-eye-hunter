import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxLostReservationError } from '../../queuebox/queue-box-types.ts';
import type {
    QueueBoxResourceEntryRepository,
    ResourceInboxReleaseDisposition,
    ResourceInboxWorkPage
} from '../../queuebox/queue-box-types.ts';
import { EntityStatus, NEW_AND_RETRY_STATUSES, type Key, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';

export type ALWorkOutcome =
    | Readonly<{ status: 'completed'; }>
    | Readonly<{ status: 'non-retryable'; }>
    | Readonly<{ status: 'retry'; }>
    | Readonly<{ status: 'not-ready'; readyAtMs: number; }>;

export interface ALWorkClaim {
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly leaseUntilMs: number;
}

export interface ALWorkPage {
    readonly entries: readonly ResourceEntry[];
    readonly nextCursor: ResourceInboxWorkPage.Cursor | null;
}

export interface ReadALWorkPageInput {
    readonly status: EntityStatus;
    readonly maxToRead: number;
    readonly cursor: ResourceInboxWorkPage.Cursor | null;
}

/** One status of a readiness scan: a scan always starts at the beginning, so it carries no cursor. */
export interface ReadALWorkPageScanInput {
    readonly status: EntityStatus;
    readonly maxToRead: number;
}

export interface ALWorkPageScan {
    /** The merged page `readPage` would have returned for this status, in work-type order. */
    readonly entries: readonly ResourceEntry[];
    /** The queue holds more rows of this status than the cap returned. */
    readonly hasMoreEntries: boolean;
}

export interface ClaimALWorkInput {
    readonly maxCount: number;
    /** Observations from a prior page read; undefined lets the queue select. */
    readonly observedEntries: readonly ResourceEntry[] | undefined;
}

/**
 * The queue half of a work owner. `retainIfAbsent`, `claim`, `finalizeExhausted` and `release` all
 * change the rows a readiness probe reads: a handler runs them inside `runBatch`, whose end drops
 * the answer it remembers, so **any of them performed outside `runBatch` must invalidate that
 * memory** -- `ALWorkHandler.committed()` for this owner's own writes, the engine wake for anyone
 * else's.
 */
export interface ALWorkQueuePort {
    retainIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>;
    readPage(input: ReadALWorkPageInput): Promise<ALWorkPage>;
    /** The readiness scan: several statuses read together, so a probe costs one round trip. */
    readPages(inputs: readonly ReadALWorkPageScanInput[]): Promise<readonly ALWorkPageScan[]>;
    claim(input: ClaimALWorkInput): Promise<readonly ALWorkClaim[]>;
    finalizeExhausted(maxCount: number): Promise<readonly ALWorkClaim[]>;
    release(claim: ALWorkClaim, outcome: ALWorkOutcome): Promise<void>;
    readEntry(key: Key): Promise<ResourceEntry | undefined>;
}

export interface CreateALWorkQueuePortInput {
    readonly queue: QueueBoxResourceEntryRepository;
    readonly workTypes: ReadonlySet<string>;
    readonly leaseMs: number;
    readonly nowMs: () => number;
    readonly random: () => number;
}

export function createALWorkQueuePort(input: CreateALWorkQueuePortInput): ALWorkQueuePort {
    const { queue, workTypes, leaseMs } = input;
    const maxAttempts = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts;
    return {
        retainIfAbsent: (entry) => queue.enqueueIfAbsent(entry),
        readPage: (pageInput) => readMergedALWorkPage(queue, workTypes, pageInput),
        readPages: (scanInputs) => readMergedALWorkPageScans(queue, workTypes, scanInputs),
        claim: async ({ maxCount, observedEntries }) => {
            const pending = await queue.reserveEntries({
                typeIds: new Set(workTypes),
                statusIds: new Set(NEW_AND_RETRY_STATUSES),
                reservationInput: { maxToReserve: maxCount, maxAttempts },
                observedEntries
            });
            const recovered = await queue.reserveTimeoutEntries({
                typeIds: new Set(workTypes),
                reservationInput: {
                    maxToReserve: Math.max(0, maxCount - pending.size),
                    maxAttempts
                },
                timeSinceStartTs: Temporal.Duration.from({ milliseconds: leaseMs }),
                observedEntries
            });
            return [...pending.values(), ...recovered.values()].map((entry) => toALWorkClaim(entry, leaseMs));
        },
        finalizeExhausted: async (maxCount) => {
            const reserved = await queue.reserveRetryExhaustionFinalizations(new Set(workTypes), {
                processingAttempts: maxAttempts,
                maxToReserve: maxCount,
                staleAfterMs: leaseMs
            });
            return [...reserved.values()].map(({ entry }) => toALWorkClaim(entry, leaseMs));
        },
        release: (claim, outcome) => releaseALWorkClaim(queue, claim, toReleaseDisposition(outcome, claim, input)),
        readEntry: (key) => queue.getItem(key)
    };
}

/**
 * The lease belongs to the reservation, not to the caller's clock: a queue that stamps the start
 * from its own store (Postgres `now()`) would otherwise disagree with a claim measured after the
 * round trip. Readiness probes round the stored start up to the millisecond, so this does too.
 */
export function computeALWorkLeaseUntilMs(entry: ResourceEntry, leaseMs: number): number {
    const startTs = entry.dequeueAudit.startTs;
    assertReservedWorkStart(startTs);
    return Number(
        startTs.round({ smallestUnit: 'millisecond', roundingMode: 'ceil' }).epochMilliseconds
    ) + leaseMs;
}

function assertReservedWorkStart(
    startTs: Temporal.Instant | undefined
): asserts startTs is Temporal.Instant {
    if (startTs === undefined) {
        throw new TypeError('A reserved work entry carries no reservation start');
    }
}

function toALWorkClaim(entry: ResourceEntry, leaseMs: number): ALWorkClaim {
    return {
        entry,
        attempts: entry.dequeueAudit.attempts,
        leaseUntilMs: computeALWorkLeaseUntilMs(entry, leaseMs)
    };
}

async function releaseALWorkClaim(
    queue: QueueBoxResourceEntryRepository,
    claim: ALWorkClaim,
    disposition: ResourceInboxReleaseDisposition
): Promise<void> {
    try {
        await queue.releaseEntries([claim.entry], disposition);
    }
    catch (error) {
        if (!(error instanceof ResourceInboxLostReservationError)) {
            throw error;
        }
    }
}

function toReleaseDisposition(
    outcome: ALWorkOutcome,
    claim: ALWorkClaim,
    input: CreateALWorkQueuePortInput
): ResourceInboxReleaseDisposition {
    switch (outcome.status) {
        case 'completed':
            return { status: EntityStatus.COMPLETED, delayMs: null };
        case 'non-retryable':
            return { status: EntityStatus.NON_RETRYABLE, delayMs: null };
        case 'not-ready':
            return {
                status: EntityStatus.RETRY,
                delayMs: Math.max(1, Math.ceil(outcome.readyAtMs - input.nowMs())),
                reason: 'not-ready'
            };
        case 'retry': {
            const decision = retryAfterAttempt(
                DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
                claim.attempts,
                input.random()
            );
            return decision.status === 'failed'
                ? { status: EntityStatus.FAILED, delayMs: null }
                : { status: EntityStatus.RETRY, delayMs: Math.max(1, decision.delayMs ?? 1) };
        }
    }
}

/**
 * Reads every status of a scan across every type in `workTypes` from one repository call. Each status
 * keeps the page `readPage` would have produced -- whole per-type pages in type order, cut at
 * `maxToRead` -- and reports whether the queue held more rows than that cap returned, which is what
 * the single-page read expressed as a cursor it never resumed from.
 */
async function readMergedALWorkPageScans(
    queue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>,
    inputs: readonly ReadALWorkPageScanInput[]
): Promise<readonly ALWorkPageScan[]> {
    const types = [...workTypes];
    const pages = await queue.readWorkPages(
        inputs.flatMap((input) =>
            types.map((typeId) => ({ typeId, status: input.status, maxToRead: input.maxToRead, cursor: null }))
        )
    );
    return inputs.map((input, index) => {
        const entries = pages.slice(index * types.length, (index + 1) * types.length)
            .flatMap((page) => page.entries);
        return { entries: entries.slice(0, input.maxToRead), hasMoreEntries: entries.length >= input.maxToRead };
    });
}

/**
 * Reads across every type in `workTypes`, concatenating whole per-type pages until `maxToRead`
 * is met. A type that drains exactly at the cap is not left ambiguous: the read continues into
 * the next type (reads are non-destructive, so re-reading a drained type on a later call is
 * harmless) rather than fabricating a resume position the underlying queue never issued.
 */
async function readMergedALWorkPage(
    queue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>,
    input: ReadALWorkPageInput
): Promise<ALWorkPage> {
    const { status, maxToRead, cursor } = input;
    const types = [...workTypes];
    const cursorIndex = cursor === null ? -1 : types.indexOf(cursor.typeId);
    const startIndex = Math.max(0, cursorIndex);
    const entries: ResourceEntry[] = [];
    let nextCursor: ResourceInboxWorkPage.Cursor | null = null;

    for (let index = startIndex; index < types.length; index += 1) {
        const page = await queue.readWorkPage({
            typeId: types[index],
            status,
            maxToRead: maxToRead - entries.length,
            cursor: index === cursorIndex ? cursor : null
        });
        entries.push(...page.entries);
        if (page.nextCursor !== null) {
            nextCursor = page.nextCursor;
            break;
        }
    }

    return { entries, nextCursor };
}
