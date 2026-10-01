import type {
    ALWorkDiagnostics,
    ALWorkReadinessProbeDiagnostics,
    ALWorkReadySelection
} from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    toResourceEntryWithKey,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

const RETRY_PAGE_SIZE = 16;

export function newWorkEntry(typeId: string, effectId: string): ResourceEntry {
    return toResourceEntryWithKey(
        { topicId: 'AL_TEST', resourceId: 'ns', contextId: effectId },
        typeId,
        { effectId }
    );
}

/**
 * The readiness probe a work owner injects, reduced to what the queue alone can answer: retained
 * work is due now and retried work at its own `nextTs`. Owners whose eligibility rules defer rows
 * pass their own probe instead, so this one lives with the tests that drive the bare handler.
 */
export async function readTestALWorkReadyAtMs(
    queue: QueueBoxResourceEntryRepository,
    workTypes: ReadonlySet<string>,
    nowMs: number
): Promise<number | undefined> {
    const due: number[] = [];
    for (const typeId of workTypes) {
        const retained = await queue.readWorkPage({ typeId, status: EntityStatus.NEW, maxToRead: 1, cursor: null });
        if (retained.entries.length > 0) {
            due.push(nowMs);
        }
        const retried = await queue.readWorkPage({
            typeId,
            status: EntityStatus.RETRY,
            maxToRead: RETRY_PAGE_SIZE,
            cursor: null
        });
        due.push(
            ...retried.entries
                .map((entry) => entry.dequeueAudit.nextTs?.epochMilliseconds)
                .filter((value): value is number => value !== undefined)
        );
    }
    return due.length === 0 ? undefined : Math.min(...due);
}

/**
 * A selection for the tests that drive the bare handler: the port's own claims, with no phase of its
 * own to report. A test pinning where a batch spent its time builds the phases it means instead.
 */
export function toTestALWorkReadySelection(
    claims: readonly ALWorkClaim[],
    nextReadyAtMs?: number
): ALWorkReadySelection {
    return {
        claims,
        nextReadyAtMs,
        selectionDurationMs: 0,
        claimDurationMs: 0,
        earliestDueAtMs: undefined
    };
}

export function collectProbe(probes: ALWorkReadinessProbeDiagnostics[], event: ALWorkDiagnostics): void {
    if (event.kind === 'readiness-probe') {
        probes.push(event);
    }
}

export interface FakeALWorkPortInput {
    readonly claims: readonly string[];
    readonly onRelease: (claim: ALWorkClaim, outcome: ALWorkOutcome) => void;
    /** Effect ids returned once from finalizeExhausted, then drained to []. */
    readonly finalizeExhausted?: readonly string[];
}

export function fakePort(input: FakeALWorkPortInput): ALWorkQueuePort {
    const pending = input.claims.map((effectId) => toFakeALWorkClaim(effectId));
    let exhausted = (input.finalizeExhausted ?? []).map((effectId) => toFakeALWorkClaim(effectId));
    return {
        retainIfAbsent: async (entry) => entry,
        readPage: async () => ({ entries: [], nextCursor: null }),
        readPages: async (inputs) => inputs.map(() => ({ entries: [], hasMoreEntries: false })),
        claim: async ({ maxCount }) => pending.splice(0, maxCount),
        finalizeExhausted: async () => {
            const claims = exhausted;
            exhausted = [];
            return claims;
        },
        releaseAll: async (releases) => {
            for (const release of releases) {
                input.onRelease(release.claim, release.outcome);
            }
        },
        readEntry: async () => undefined
    };
}

export function toFakeALWorkClaim(effectId: string): ALWorkClaim {
    return { entry: newWorkEntry('AL_TEST', effectId), attempts: 0, leaseUntilMs: 0 };
}
