import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { PSqlQueueReleaseTiming } from '@shared-server/queuebox/postgres/p-sql-queue-release-timing.ts';
import { createRallarPSqlReleaseTiming } from '@shared-server/rallar-system/observability/p-sql-release-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('Postgres release timing projection', () => {
    it.each(['root', 'savepoint'] as const)('projects scalar boundaries and one identity-only member array with explicit %s scope', (transactionScope) => {
        const events: RallarTimingEvent[] = [];
        const timing = new PSqlQueueReleaseTiming({
            namespace: 'outbound',
            port: createRallarPSqlReleaseTiming({
                timing: (event) => events.push(event),
                serviceId: 'api',
                publisherId: 'publisher',
                processId: 123,
                processStartedAtEpochMs: 9_000,
                transactionScope,
                readMonotonicMs: () => 0,
                readEpochMs: () => 10_000
            })
        });
        timing.recordSucceeded(createCompletion());
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            component: 'alm-outbound-dequeue',
            operation: 'postgres-release',
            status: 'ok',
            durationMs: 125,
            details: {
                namespace: 'outbound',
                releaseSequence: 1,
                processId: 123,
                processStartedAtEpochMs: 9_000,
                transactionScope,
                availability: 'available',
                eligible: false,
                memberCount: 1,
                truncated: false,
                fallbackCount: 0,
                candidateElapsedMs: 5,
                transactionAdmissionElapsedMs: 7,
                callbackElapsedMs: 100,
                transactionReturnElapsedMs: 13,
                releaseOwnerElapsedMs: 125,
                anchorEpochMs: 10_000,
                anchorMonotonicMs: 0,
                anchorUncertaintyMs: 0
            }
        });
        expect(events[0]?.details?.releaseMembersJson).toBe(JSON.stringify([{
            ordinal: 0,
            key: { topicId: 'release', contextId: 'scope', resourceId: 'member' },
            reservationAttempt: 3,
            reservationStartedAt: '2026-01-01T00:00:00.123456Z',
            reservationStartedAtEpochMs: 1767225600123,
            rowId: '9007199254740993',
            updated: true
        }]));
        expect(JSON.stringify(events)).not.toContain('secret payload');
        expect(Object.values(events[0]!.details!).every((value) => value === undefined || ['string', 'number', 'boolean'].includes(typeof value))).toBe(true);
    });

    it('retains setup and callback remainder instead of attributing them to statement elapsed', () => {
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const timing = createTiming((value) => observed.push(value));
        const completion = createCompletion();
        timing.recordSucceeded({
            ...completion,
            candidateStartedAtMs: 2,
            transactionCalledAtMs: 7,
            callback: { ...completion.callback, statementEndedAtMs: 92 }
        });
        expect(observed[0]).toMatchObject({
            phases: {
                candidateElapsedMs: 3,
                transactionAdmissionElapsedMs: 5,
                callbackElapsedMs: 100,
                releaseReservedElapsedMs: 80,
                callbackRemainderElapsedMs: 20,
                setupRemainderElapsedMs: 4,
                releaseOwnerElapsedMs: 125
            }
        });
    });

    it('contains optional identity formatting and sink failures and never publishes failed inner phases', () => {
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const timing = createTiming((value) => observed.push(value));
        const completion = createCompletion();
        const start = completion.callback.members[0]!.entry.dequeueAudit.startTs!;
        const formatting = vi.spyOn(start, 'toString').mockImplementation(() => {
            throw new Error('format failed');
        });
        try {
            timing.recordSucceeded(completion);
        }
        finally {
            formatting.mockRestore();
        }
        expect(observed).toEqual([{ namespace: 'outbound', sequence: 1, outcome: 'succeeded', availability: 'unavailable', reason: 'projection-failed' }]);
        timing.recordFailed(completion.invocation);
        expect(observed[1]).toEqual({ namespace: 'outbound', sequence: 1, outcome: 'failed', availability: 'unavailable', reason: 'release-failed' });
        const throwing = createTiming(() => {
            throw new Error('sink failed');
        });
        expect(() => throwing.recordSucceeded(completion)).not.toThrow();
        expect(() => throwing.recordFailed(completion.invocation)).not.toThrow();
    });

    it('uses a queue-instance sequence even when an earlier invocation failed', () => {
        const observed: PSqlQueueReleaseTiming.Observation[] = [];
        const first = createTiming((value) => observed.push(value));
        first.recordFailed(first.start());
        first.recordSucceeded({ ...createCompletion(), invocation: first.start() });
        const other = createTiming((value) => observed.push(value));
        other.recordFailed(other.start());
        expect(observed.map((value) => [value.sequence, value.outcome])).toEqual([[1, 'failed'], [2, 'succeeded'], [1, 'failed']]);
    });
});

function createTiming(record: PSqlQueueReleaseTiming.Port['record']): PSqlQueueReleaseTiming {
    return new PSqlQueueReleaseTiming({ namespace: 'outbound', port: { readMonotonicMs: () => 0, readEpochMs: () => 10_000, record } });
}

function createCompletion(): PSqlQueueReleaseTiming.Completion {
    const entry: ResourceEntry = {
        key: { topicId: 'release', contextId: 'scope', resourceId: 'member' },
        typeId: 'work',
        resource: 'secret payload',
        status: EntityStatus.RESERVED,
        db: { id: '9007199254740993' },
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 3, startTs: Temporal.Instant.from('2026-01-01T00:00:00.123456Z') }
    };
    return {
        invocation: { sequence: 1, startedAtMs: 0, anchorAfterMs: 0, anchorEpochMs: 10_000 },
        memberCount: 1,
        candidateStartedAtMs: 0,
        candidateEndedAtMs: 5,
        transactionCalledAtMs: 5,
        transactionReturnedAtMs: 125,
        callback: { startedAtMs: 12, statementEndedAtMs: 112, endedAtMs: 112, fallbackCount: 0, members: [{ entry, ordinal: 0, updated: true }] }
    };
}
