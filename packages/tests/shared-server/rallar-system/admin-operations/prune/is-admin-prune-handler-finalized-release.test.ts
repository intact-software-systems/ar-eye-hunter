import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toAdminPruneOutbox } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { isAdminPruneHandlerFinalizedRelease } from '@shared-server/rallar-system/admin-operations/prune/is-admin-prune-handler-finalized-release.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

interface AdminPruneReservationPair {
    readonly reserved: ResourceEntry;
    readonly current: ResourceEntry;
}

interface RejectedAdminPruneCompletion {
    readonly name: string;
    change(entry: ResourceEntry): ResourceEntry;
}

const REJECTED_COMPLETIONS: readonly RejectedAdminPruneCompletion[] = [
    { name: 'another queue', change: (entry) => ({ ...entry, typeId: 'WS_OUTBOX' }) },
    { name: 'unfinished work', change: (entry) => ({ ...entry, status: EntityStatus.RESERVED }) },
    { name: 'newer attempt', change: (entry) => ({ ...entry, dequeueAudit: { ...entry.dequeueAudit, attempts: 2 } }) },
    { name: 'different job', change: (entry) => ({ ...entry, key: { ...entry.key, contextId: 'another-job' } }) },
    { name: 'changed envelope', change: (entry) => ({ ...entry, resource: `${entry.resource} ` }) },
    { name: 'replacement row', change: (entry) => ({ ...entry, db: { id: 'other-row' } }) },
    { name: 'forged creator', change: (entry) => ({ ...entry, audit: { ...entry.audit, createdBy: 'other-server' } }) },
    {
        name: 'changed creation time',
        change: (entry) => ({ ...entry, audit: { ...entry.audit, createdTs: entry.audit.createdTs.add({ seconds: 1 }) } })
    },
    {
        name: 'changed audit date',
        change: (entry) => ({ ...entry, audit: { ...entry.audit, date: entry.audit.date.add({ seconds: 1 }) } })
    },
    {
        name: 'changed expiry',
        change: (entry) => ({ ...entry, audit: { ...entry.audit, expiryTs: entry.audit.expiryTs.add({ seconds: 1 }) } })
    },
    {
        name: 'different reservation start',
        change: (entry) => ({ ...entry, dequeueAudit: { ...entry.dequeueAudit, startTs: Temporal.Instant.fromEpochMilliseconds(0) } })
    },
    {
        name: 'missing completion time',
        change: (entry) => ({ ...entry, dequeueAudit: { ...entry.dequeueAudit, endTs: undefined } })
    },
    {
        name: 'retry scheduled after completion',
        change: (entry) => ({ ...entry, dequeueAudit: { ...entry.dequeueAudit, nextTs: Temporal.Now.instant() } })
    }
];

const CORRUPTED_TIMESTAMPS: readonly RejectedAdminPruneCompletion[] = [
    {
        name: 'string audit date',
        change: (entry) => ({ ...entry, audit: Object.defineProperty({ ...entry.audit }, 'date', { value: entry.audit.date.toString() }) })
    },
    {
        name: 'string creation timestamp',
        change: (entry) => ({ ...entry, audit: Object.defineProperty({ ...entry.audit }, 'createdTs', { value: entry.audit.createdTs.toString() }) })
    },
    {
        name: 'string expiry timestamp',
        change: (entry) => ({ ...entry, audit: Object.defineProperty({ ...entry.audit }, 'expiryTs', { value: entry.audit.expiryTs.toString() }) })
    },
    {
        name: 'string reservation start',
        change: (entry) => ({
            ...entry,
            dequeueAudit: Object.defineProperty({ ...entry.dequeueAudit }, 'startTs', { value: entry.dequeueAudit.startTs?.toString() })
        })
    },
    {
        name: 'string completion timestamp',
        change: (entry) => ({
            ...entry,
            dequeueAudit: Object.defineProperty({ ...entry.dequeueAudit }, 'endTs', { value: entry.dequeueAudit.startTs?.toString() })
        })
    },
    {
        name: 'string retry timestamp',
        change: (entry) => ({
            ...entry,
            dequeueAudit: Object.defineProperty({ ...entry.dequeueAudit }, 'nextTs', { value: entry.dequeueAudit.startTs?.toString() })
        })
    },
    {
        name: 'wrong Temporal audit type',
        change: (entry) => ({ ...entry, audit: Object.defineProperty({ ...entry.audit }, 'date', { value: entry.audit.createdTs }) })
    },
    {
        name: 'audit object with forged equality',
        change: (entry) => ({
            ...entry,
            audit: Object.defineProperty({ ...entry.audit }, 'date', {
                value: { equals: () => true, toString: () => entry.audit.date.toString() }
            })
        })
    },
    {
        name: 'unbranded Instant with a forged prototype and equality',
        change: (entry) => ({
            ...entry,
            dequeueAudit: Object.defineProperty({ ...entry.dequeueAudit }, 'startTs', {
                value: Object.create(Temporal.Instant.prototype, {
                    equals: { value: () => true },
                    toString: { value: () => entry.dequeueAudit.startTs?.toString() }
                })
            })
        })
    }
];

describe('admin page handler completion release', () => {
    it('accepts the exact canonically typed page completed by its reservation owner', () => {
        const { reserved, current } = createReservationPair(Date.now());
        expect(isAdminPruneHandlerFinalizedRelease(current, reserved, {
            status: EntityStatus.COMPLETED,
            delayMs: null
        })).toBe(true);
    });

    it.each(CORRUPTED_TIMESTAMPS)('rejects corrupted admin evidence: $name', ({ change }) => {
        for (const owner of ['current', 'reserved'] as const) {
            const pair = createReservationPair(Date.now());
            // Corrupt the returned persistence row without asserting that the
            // replacement value satisfies the production Temporal contract.
            const changed = { ...pair, [owner]: change(pair[owner]) };
            expect(
                isAdminPruneHandlerFinalizedRelease(changed.current, changed.reserved, {
                    status: EntityStatus.COMPLETED,
                    delayMs: null
                }),
                owner
            ).toBe(false);
        }
    });

    it.each(REJECTED_COMPLETIONS)('rejects $name', ({ change }) => {
        const { reserved, current } = createReservationPair(Date.now());
        expect(isAdminPruneHandlerFinalizedRelease(change(current), reserved, {
            status: EntityStatus.COMPLETED,
            delayMs: null
        })).toBe(false);
    });

    it('does not accept an expired completed page or reopen it for retry', () => {
        const { reserved, current } = createReservationPair(Date.now() - 120_000);
        expect(isAdminPruneHandlerFinalizedRelease(current, reserved, {
            status: EntityStatus.COMPLETED,
            delayMs: null
        })).toBe(false);
        const live = createReservationPair(Date.now());
        expect(isAdminPruneHandlerFinalizedRelease(live.current, live.reserved, {
            status: EntityStatus.RETRY,
            delayMs: 1
        })).toBe(false);
    });

    it.each([
        { mode: 'all', scope: 'global' },
        { mode: 'broadcast', scope: 'world' }
    ])('rejects matching envelopes whose admin target is invalid: %j', (targets) => {
        const { reserved, current } = createReservationPair(Date.now());
        const message = decodePersistedALMessage(reserved.resource);
        const resource = JSON.stringify({ ...message, targets });
        expect(isAdminPruneHandlerFinalizedRelease({ ...current, resource }, { ...reserved, resource }, {
            status: EntityStatus.COMPLETED,
            delayMs: null
        })).toBe(false);
    });
});

function createReservationPair(now: number): AdminPruneReservationPair {
    const entry = toAdminPruneOutbox({
        kind: 'page',
        jobId: 'release-policy',
        category: 'runtime-state',
        requestedBy: 'admin',
        requestedSessionId: 'admin-session',
        capturedAtEpochMs: now,
        expireAtEpochMs: now + 60_000,
        pageSize: 2,
        afterCursor: null,
        pageIndex: 0,
        appData: null
    }, 'server-1');
    const startTs = Temporal.Instant.fromEpochMilliseconds(now);
    const reserved: ResourceEntry = {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1, startTs },
        db: { id: 'row-1' }
    };
    return {
        reserved,
        current: {
            ...reserved,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 1, startTs, endTs: startTs.add({ milliseconds: 1 }) }
        }
    };
}
