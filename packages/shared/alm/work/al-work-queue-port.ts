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

export interface ClaimALWorkInput {
    readonly maxCount: number;
    /** Observations from a prior page read; undefined lets the queue select. */
    readonly observedEntries: readonly ResourceEntry[] | undefined;
}

export interface ALWorkQueuePort {
    readonly workTypes: ReadonlySet<string>;
    retainIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>;
    readPage(input: ReadALWorkPageInput): Promise<ALWorkPage>;
    claim(input: ClaimALWorkInput): Promise<readonly ALWorkClaim[]>;
    finalizeExhausted(maxCount: number): Promise<readonly ALWorkClaim[]>;
    release(claim: ALWorkClaim, outcome: ALWorkOutcome): Promise<void>;
    peekNextReadyAt(): Promise<number | undefined>;
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
    const { queue, workTypes, leaseMs, nowMs } = input;
    const maxAttempts = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts;
    return {
        workTypes,
        retainIfAbsent: (entry) => queue.enqueueIfAbsent(entry),
        readPage: (pageInput) => readMergedALWorkPage(queue, workTypes, pageInput),
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
            return [...pending.values(), ...recovered.values()].map((entry) => toALWorkClaim(entry, nowMs() + leaseMs));
        },
        finalizeExhausted: async (maxCount) => {
            const reserved = await queue.reserveRetryExhaustionFinalizations(new Set(workTypes), {
                processingAttempts: maxAttempts,
                maxToReserve: maxCount,
                staleAfterMs: leaseMs
            });
            return [...reserved.values()].map(({ entry }) => toALWorkClaim(entry, nowMs() + leaseMs));
        },
        release: (claim, outcome) => releaseALWorkClaim(queue, claim, toReleaseDisposition(outcome, claim, input)),
        peekNextReadyAt: () => readALWorkNextReadyAtMs(queue, workTypes),
        readEntry: (key) => queue.getItem(key)
    };
}

function toALWorkClaim(entry: ResourceEntry, leaseUntilMs: number): ALWorkClaim {
    return { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs };
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
        const remaining = maxToRead - entries.length;
        const page = await queue.readWorkPage({
            typeId: types[index],
            status,
            maxToRead: remaining > 0 ? remaining : maxToRead,
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

async function readALWorkNextReadyAtMs(
    queue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>
): Promise<number | undefined> {
    const due: number[] = [];
    for (const typeId of workTypes) {
        const page = await queue.readWorkPage({
            typeId,
            status: EntityStatus.RETRY,
            maxToRead: 16,
            cursor: null
        });
        due.push(
            ...page.entries
                .map((entry) => entry.dequeueAudit.nextTs?.epochMilliseconds)
                .filter((value): value is number => value !== undefined)
        );
    }
    return due.length === 0 ? undefined : Math.min(...due);
}
