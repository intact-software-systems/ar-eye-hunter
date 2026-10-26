import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import {
    computeResourceInboxObservedReplacement,
    ResourceInboxInvariantCorruptionError
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import {
    createResourceInboxTestStorage,
    seedResourceInboxRow
} from '../shared-server/queuebox/resource-inbox-test-storage.ts';

import {
    createResourceInboxQueryCapture,
    createResourceInboxSqlHarness,
    findStoredResourceInboxRow,
    toStoredResourceInboxTimestamp
} from './p-sql-resource-inbox-test-harness.ts';

afterEach(() => {
    vi.useRealTimers();
});

describe('PostgreSQL resource inbox persistence', () => {
    it('claims only due retries within the configured budget, even when FAILED is requested', async () => {
        const storage = await createResourceInboxTestStorage('retry_eligibility');
        onTestFinished(() => storage.close());
        const repo = createPSqlResourceInboxRepository(storage.sql, () => new Date('1900-01-01'));
        const rows = [
            { resourceId: 'due', status: EntityStatus.RETRY, attempts: 1, nextInSeconds: -1 },
            { resourceId: 'future', status: EntityStatus.RETRY, attempts: 1, nextInSeconds: 60 },
            { resourceId: 'expired', status: EntityStatus.RETRY, attempts: 1, nextInSeconds: -1, expired: true },
            { resourceId: 'exhausted', status: EntityStatus.RETRY, attempts: 2, nextInSeconds: -1 },
            { resourceId: 'failed', status: EntityStatus.FAILED, attempts: 1, nextInSeconds: -1 }
        ];
        const keys = [];
        for (const row of rows) {
            keys.push(await seedResourceInboxRow(storage.sql, { ...row, startedAgoSeconds: 5, endedAgoSeconds: 4 }));
        }
        const before = await Promise.all(keys.slice(1).map((key) => repo.entries.findAnyByKey(key)));

        const claimed = await repo.reservations.reserveEntriesSkipLocked({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.RETRY, EntityStatus.FAILED]),
            reservationInput: { maxToReserve: 7, maxAttempts: 2 },
            contextClaim: undefined
        });

        expect([...claimed.values()].map((entry) => [entry.key.resourceId, entry.status, entry.dequeueAudit.attempts]))
            .toEqual([['due', EntityStatus.RESERVED, 2]]);
        expect(await Promise.all(keys.slice(1).map((key) => repo.entries.findAnyByKey(key)))).toEqual(before);
    });

    it('selects overdue retries in due order while excluding active contexts and exhausted rows', async () => {
        const storage = await createResourceInboxTestStorage('retry_fairness');
        onTestFinished(() => storage.close());
        const repo = createPSqlResourceInboxRepository(storage.sql, () => new Date('1900-01-01'));
        for (const row of [
            { resourceId: 'recent', nextInSeconds: -10, attempts: 1 },
            { resourceId: 'older', nextInSeconds: -60, attempts: 1 },
            { resourceId: 'oldest', nextInSeconds: -90, attempts: 1 },
            { resourceId: 'exhausted', nextInSeconds: -120, attempts: 2 },
            { resourceId: 'excluded', nextInSeconds: -120, attempts: 1 }
        ]) {
            await seedResourceInboxRow(storage.sql, { ...row, status: EntityStatus.RETRY, startedAgoSeconds: 180, endedAgoSeconds: 150 });
        }
        await storage.sql`update resource_inbox set fk_ext_bank_id = 'active-context' where ri_resource_id = 'excluded'`;
        const selected = await repo.reservations.findOverdueRetryEntriesSkipLocked(
            new Set(['APP_INBOX']), Date.now() - 30_000,
            { maxToReserve: 3, maxAttempts: 2, excludedContextIds: new Set(['active-context']) }
        );
        expect([...selected.values()].map((entry) => entry.key.resourceId)).toEqual(['oldest', 'older']);
    });

    it('advertises lanes on database time using each requested attempt budget', async () => {
        const storage = await createResourceInboxTestStorage('work_budgets');
        onTestFinished(() => storage.close());
        const repo = createPSqlResourceInboxRepository(storage.sql, () => new Date('1900-01-01'));
        await seedResourceInboxRow(storage.sql, { resourceId: 'retry', status: EntityStatus.RETRY, attempts: 2, startedAgoSeconds: 60, endedAgoSeconds: 50, nextInSeconds: -40 });
        await seedResourceInboxRow(storage.sql, { resourceId: 'reservation', status: EntityStatus.RESERVED, attempts: 2, startedAgoSeconds: 400 });
        const options = { typeIds: new Set(['APP_INBOX']), reservationLeaseMs: 30_000, finalizationStaleAfterMs: 300_000, staleDueThresholdMs: 30_000 };
        expect(await repo.reservations.readWorkPresences([{ ...options, maxAttempts: 2 }, { ...options, maxAttempts: 3 }]))
            .toEqual([
                { newRow: false, dueRetry: false, overdueRetry: false, timedOutReservation: false, staleExhaustedReservation: true },
                { newRow: false, dueRetry: true, overdueRetry: true, timedOutReservation: true, staleExhaustedReservation: false }
            ]);
    });

    it('selects only reservations past the database lease and below the attempt budget', async () => {
        const storage = await createResourceInboxTestStorage('timeout_eligibility');
        onTestFinished(() => storage.close());
        const repo = createPSqlResourceInboxRepository(storage.sql, () => new Date('1900-01-01'));
        for (const row of [
            { resourceId: 'recent', attempts: 1, startedAgoSeconds: 5 },
            { resourceId: 'timed-out', attempts: 1, startedAgoSeconds: 60 },
            { resourceId: 'exhausted', attempts: 2, startedAgoSeconds: 60 },
            { resourceId: 'expired', attempts: 1, startedAgoSeconds: 60, expired: true }
        ]) {
            await seedResourceInboxRow(storage.sql, { ...row, status: EntityStatus.RESERVED });
        }
        const selected = await repo.reservations.findTimedOutReservedEntriesSkipLocked({
            typeIds: new Set(['APP_INBOX']), timeSinceStartMs: 30_000,
            reservationInput: { maxToReserve: 3, maxAttempts: 2 }, excludedContextIds: new Set()
        });
        expect([...selected.values()].map((entry) => entry.key.resourceId)).toEqual(['timed-out']);
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
        'rejects invalid timeout claim interval %s before SQL',
        async (timeSinceStartMs) => {
            const capture = createResourceInboxQueryCapture();
            const repo = createPSqlResourceInboxRepository(capture.sql, () => new Date());

            await expect(
                repo.reservations.findTimedOutReservedEntriesSkipLocked({
                    typeIds: new Set(['APP_INBOX']),
                    timeSinceStartMs: timeSinceStartMs,
                    reservationInput: 1,
                    excludedContextIds: new Set()
                })
            ).rejects.toThrow(/non-negative safe integer/u);
            expect(capture.queries).toHaveLength(0);
        }
    );

    it('persists the transaction database clock even after the application clock advances', async () => {
        const storage = await createResourceInboxTestStorage('reservation_clock');
        onTestFinished(() => storage.close());
        const key = await seedResourceInboxRow(storage.sql, { resourceId: 'clock', status: EntityStatus.NEW });
        await storage.sql.begin(async (transaction) => {
            const [clock] = await transaction<readonly { started_at: string; }[]>`select (now() at time zone 'UTC')::text as started_at`;
            const repo = createPSqlResourceInboxRepository(transaction, () => new Date());
            const entry = (await repo.entries.findByKey(key))!;
            await new Promise((resolve) => setTimeout(resolve, 25));
            const result = await repo.reservations.startProcessingEntity(entry, 2);
            const persisted = (await repo.entries.findByKey(key))!;
            const expectedStart = Temporal.PlainDateTime.from(clock!.started_at).toZonedDateTime('UTC').toInstant();
            expect(result.right?.dequeueAudit.startTs).toEqual(expectedStart);
            expect(persisted.dequeueAudit.startTs).toEqual(expectedStart);
            expect(persisted.dequeueAudit.attempts).toBe(1);
        });
    });

    it('advances only the exact live exhausted finalization generation', async () => {
        const storage = await createResourceInboxTestStorage('finalization_generation');
        onTestFinished(() => storage.close());
        const repo = createPSqlResourceInboxRepository(storage.sql, () => new Date('1900-01-01'));
        const key = await seedResourceInboxRow(storage.sql, { resourceId: 'recover', status: EntityStatus.RESERVED, attempts: 21, startedAgoSeconds: 400 });
        const completedKey = await seedResourceInboxRow(storage.sql, { resourceId: 'completed', status: EntityStatus.COMPLETED, attempts: 21, startedAgoSeconds: 400, endedAgoSeconds: 300 });
        const completed = (await repo.entries.findByKey(completedKey))!;
        expect((await repo.finalization.startFinalizationRecovery(completed, 20)).left).toBeDefined();
        expect(await repo.entries.findByKey(completedKey)).toEqual(completed);
        const observed = (await repo.entries.findByKey(key))!;
        expect((await repo.finalization.startFinalizationRecovery(observed, 22)).left).toBeDefined();
        expect((await repo.finalization.startFinalizationRecovery({ ...observed, typeId: 'wrong-type' }, 20)).left).toBeDefined();
        const recovered = (await repo.finalization.startFinalizationRecovery(observed, 20)).right!;
        expect(recovered.dequeueAudit.attempts).toBe(22);
        expect(Temporal.Instant.compare(recovered.dequeueAudit.startTs!, observed.dequeueAudit.startTs!)).toBe(1);
        expect((await repo.finalization.startFinalizationRecovery(observed, 20)).left).toBeDefined();
        expect(await repo.entries.findByKey(key)).toEqual(recovered);
        await storage.sql`update resource_inbox set expire_ts = (now() at time zone 'UTC') - interval '1 second' where ri_resource_id = 'recover'`;
        expect((await repo.finalization.startFinalizationRecovery(recovered, 20)).left).toBeDefined();
    });

    it('inserts immutable outbox content once and matches an operationally advanced replay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey('idempotent-outbox'), {
            text: 'immutable',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('inserted');

        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.created_ts = '2026-01-01 00:00:00.000000';
        stored.expire_ts = '2026-01-01 00:05:00.000000';
        stored.ri_status = EntityStatus.COMPLETED;
        stored.ri_attempts = 3n;
        stored.start_ts = '2026-01-01 00:01:00.000000';
        stored.end_ts = '2026-01-01 00:01:01.000000';
        stored.next_ts = null;

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
    });

    it.each([
        ['creation timestamp', {
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00.000002'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00.000001Z')
        }],
        ['expiry', {
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00.000001'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00.000002Z')
        }]
    ])('rejects a replay whose immutable %s differs by one microsecond', async (
        _field,
        replayTimestamps
    ) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const key = createKey(`microsecond-${_field}`);
        const original = createEntry(key, {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00.000001'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00.000001Z')
        });
        const replay = createEntry(key, {
            text: 'immutable',
            createdTs: replayTimestamps.createdTs,
            expiryTs: replayTimestamps.expiryTs
        });

        await repo.entries.writeIfAbsentOrMatch(original);

        await expect(repo.entries.writeIfAbsentOrMatch(replay)).rejects.toBeInstanceOf(
            ResourceInboxInvariantCorruptionError
        );
    });

    it.each([
        ['creation', 'below half', { candidate: '2026-06-01T12:00:00.0000004', persisted: '2026-06-01 12:00:00.000000' }],
        ['creation', 'half even down', { candidate: '2026-06-01T12:00:00.0000005', persisted: '2026-06-01 12:00:00.000000' }],
        ['creation', 'half even up', { candidate: '2026-06-01T12:00:00.0000015', persisted: '2026-06-01 12:00:00.000002' }],
        ['creation', 'above half', { candidate: '2026-06-01T12:00:00.0000006', persisted: '2026-06-01 12:00:00.000001' }],
        ['creation', 'second rollover', { candidate: '2026-06-01T12:00:00.9999995', persisted: '2026-06-01 12:00:01.000000' }],
        ['expiry', 'below half', { candidate: '2026-06-01T13:00:00.0000004Z', persisted: '2026-06-01 13:00:00.000000' }],
        ['expiry', 'half even down', { candidate: '2026-06-01T13:00:00.0000005Z', persisted: '2026-06-01 13:00:00.000000' }],
        ['expiry', 'half even up', { candidate: '2026-06-01T13:00:00.0000015Z', persisted: '2026-06-01 13:00:00.000002' }],
        ['expiry', 'above half', { candidate: '2026-06-01T13:00:00.0000006Z', persisted: '2026-06-01 13:00:00.000001' }],
        ['expiry', 'second rollover', { candidate: '2026-06-01T13:00:00.9999995Z', persisted: '2026-06-01 13:00:01.000000' }]
    ])('matches PostgreSQL timestamp(6) %s %s rounding', async (field, _scenario, timestamps) => {
        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const key = createKey(`rounding-${field}-${_scenario}`);
        const entry = createEntry(key, {
            text: 'immutable',
            createdTs: field === 'creation'
                ? Temporal.PlainDateTime.from(timestamps.candidate)
                : Temporal.PlainDateTime.from('2026-06-01T12:00:00'),
            expiryTs: field === 'expiry'
                ? Temporal.Instant.from(timestamps.candidate)
                : Temporal.Instant.from('2026-06-01T13:00:00Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        if (field === 'creation') {
            stored.created_ts = timestamps.persisted;
        }
        else {
            stored.expire_ts = timestamps.persisted;
        }

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
    });

    it.each([
        ['topic key', (row: ResourceInboxRow) => {
            row.ri_topic_id = 'other-topic';
        }],
        ['resource key', (row: ResourceInboxRow) => {
            row.ri_resource_id = 'other-resource';
        }],
        ['context key', (row: ResourceInboxRow) => {
            row.fk_ext_bank_id = 'other-context';
        }],
        ['queue type', (row: ResourceInboxRow) => {
            row.ri_type_id = 'app.outbox';
        }],
        ['persisted resource representation', (row: ResourceInboxRow) => {
            row.ri_resource = '{ "text": "immutable" }';
        }],
        ['creator', (row: ResourceInboxRow) => {
            row.created_by = 'mallory';
        }],
        ['creation timestamp', (row: ResourceInboxRow) => {
            row.created_ts = '2026-01-01T00:00:01.000Z';
        }],
        ['expiry', (row: ResourceInboxRow) => {
            row.expire_ts = '2026-01-01T00:06:00.000Z';
        }]
    ])('rejects a replay whose immutable %s differs', async (_field, mutate) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey(`collision-${_field}`), {
            text: 'immutable',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        mutate(stored);

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            ResourceInboxInvariantCorruptionError
        );
    });

    it('rejects an invalid stored lifecycle when immutable content matches', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey('invalid-lifecycle'), {
            text: 'immutable',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = 'NOT_A_STATUS';

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            ResourceInboxInvariantCorruptionError
        );
    });

    it.each([
        ['missing attempt count', (row: ResourceInboxRow) => {
            row.ri_attempts = null;
        }],
        ['completed without a reservation', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.COMPLETED;
            row.ri_attempts = 0n;
            row.start_ts = null;
            row.end_ts = null;
            row.next_ts = null;
        }],
        ['reserved without a start timestamp', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.RESERVED;
            row.ri_attempts = 1n;
            row.start_ts = null;
            row.end_ts = null;
            row.next_ts = null;
        }],
        ['reserved with an end timestamp', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.RESERVED;
            row.ri_attempts = 1n;
            row.start_ts = '2026-01-01 00:01:00.000000';
            row.end_ts = '2026-01-01 00:01:01.000000';
            row.next_ts = null;
        }],
        ['retry without a next timestamp', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.RETRY;
            row.ri_attempts = 1n;
            row.start_ts = '2026-01-01 00:01:00.000000';
            row.end_ts = '2026-01-01 00:01:01.000000';
            row.next_ts = null;
        }],
        ['completed without an end timestamp', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.COMPLETED;
            row.ri_attempts = 1n;
            row.start_ts = '2026-01-01 00:01:00.000000';
            row.end_ts = null;
            row.next_ts = null;
        }],
        ['new with retry scheduling', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.NEW;
            row.ri_attempts = 0n;
            row.start_ts = null;
            row.end_ts = null;
            row.next_ts = '2026-01-01 00:01:00.000000';
        }]
    ])('rejects an enum-valid but impossible lifecycle: %s', async (
        _scenario,
        mutate
    ) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey(`invalid-${_scenario}`), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        mutate(stored);

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            ResourceInboxInvariantCorruptionError
        );
    });

    it.each([
        ['start before creation', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.RESERVED;
            row.ri_attempts = 1n;
            row.start_ts = '2025-12-31 23:59:59.999999';
            row.end_ts = null;
            row.next_ts = null;
        }],
        ['end before start', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.COMPLETED;
            row.ri_attempts = 1n;
            row.start_ts = '2026-01-01 00:01:01.000000';
            row.end_ts = '2026-01-01 00:01:00.999999';
            row.next_ts = null;
        }]
    ])('matches immutable replay and preserves independent %s clocks', async (_scenario, advance) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const harness = createResourceInboxSqlHarness();
        const repository = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey(`independent-${_scenario}`), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });
        await repository.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        advance(stored);
        const before = { ...stored };

        await expect(repository.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
        expect(stored).toEqual(before);
    });

    it('matches exact immutable content after an expiry-capped retry advances', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const harness = createResourceInboxSqlHarness();
        const repository = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey('expiry-capped-replay'), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:01:00.999999Z')
        });
        await repository.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        Object.assign(stored, {
            ri_status: EntityStatus.RETRY,
            ri_attempts: 1n,
            start_ts: '2026-01-01 00:01:00.000000',
            end_ts: '2026-01-01 00:01:01.000000',
            next_ts: stored.expire_ts
        });
        const before = { ...stored };

        await expect(repository.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
        expect(stored).toEqual(before);
    });

    it('matches exact replay when supplied expiry equals creation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey('invalid-created-expiry-order'), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00.000001'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:00:00.000001Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);

        const before = findStoredResourceInboxRow(harness.rows, entry.key);
        expect(before).toBeDefined();
        const saved = { ...before };
        await expect(repo.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
        expect(findStoredResourceInboxRow(harness.rows, entry.key)).toEqual(saved);
    });

    it.each([['scheduled retry', { ri_status: EntityStatus.RETRY, ri_attempts: 0n, start_ts: null, end_ts: null, next_ts: '2026-01-01 00:01:00.000000' }], [
        'active reservation',
        { ri_status: EntityStatus.RESERVED, ri_attempts: 1n, start_ts: '2026-01-01 00:01:00.000000', end_ts: null, next_ts: null }
    ], ['processed retry', {
        ri_status: EntityStatus.RETRY,
        ri_attempts: 1n,
        start_ts: '2026-01-01 00:01:00.000000',
        end_ts: '2026-01-01 00:01:01.000000',
        next_ts: '2026-01-01 00:01:02.000000'
    }], ['terminal failure', {
        ri_status: EntityStatus.FAILED,
        ri_attempts: 1n,
        start_ts: '2026-01-01 00:01:00.000000',
        end_ts: '2026-01-01 00:01:01.000000',
        next_ts: null
    }], ['delayed failure', {
        ri_status: EntityStatus.FAILED,
        ri_attempts: 1n,
        start_ts: '2026-01-01 00:01:00.000000',
        end_ts: '2026-01-01 00:01:01.000000',
        next_ts: '2026-01-01 00:01:02.000000'
    }]])('matches immutable content after a valid %s lifecycle advance', async (_scenario, lifecycle) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const entry = createEntry(createKey(`valid-${_scenario}`), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.entries.writeIfAbsentOrMatch(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        Object.assign(stored, lifecycle);

        await expect(repo.entries.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
    });

    it('finishes only the current live reservation with the expected attempt', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const completedAt = new Date('2026-01-01T00:01:00.000Z');
        const entry = createEntry(createKey('reserved-finish'), {
            text: 'reserved',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });
        await repo.entries.write(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = EntityStatus.RESERVED;
        stored.ri_attempts = 2n;
        stored.start_ts = '2026-01-01 00:00:00.000000';

        await expect(repo.finalization.finishReserved(
            entry.key,
            1,
            EntityStatus.COMPLETED,
            completedAt
        )).resolves.toBe(false);
        await expect(repo.finalization.finishReserved(
            entry.key,
            2,
            EntityStatus.COMPLETED,
            completedAt
        )).resolves.toBe(true);

        expect(stored.ri_status).toBe(EntityStatus.COMPLETED);
        expect(stored.end_ts).toBe('2026-01-01 00:01:00.000000');
        expect(stored.next_ts).toBeNull();
        await expect(repo.finalization.finishReserved(
            entry.key,
            2,
            EntityStatus.FAILED,
            completedAt
        )).resolves.toBe(false);
    });

    it('atomically releases only the current live reservation and returns persisted timestamps', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const releasedAt = Temporal.Instant.from('2026-01-01T00:01:00.123Z');
        const entry = createEntry(createKey('reserved-release'), {
            text: 'reserved',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });
        await repo.entries.write(entry);
        const stored = findStoredResourceInboxRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = EntityStatus.RESERVED;
        stored.ri_attempts = 2n;
        stored.start_ts = '2026-01-01 00:00:00.000000';

        const observed = await repo.entries.findByKey(entry.key);
        if (!observed) {
            throw new Error('Expected current reservation');
        }
        const candidate = {
            ...observed,
            status: EntityStatus.RETRY,
            dequeueAudit: { ...observed.dequeueAudit, endTs: releasedAt, nextTs: releasedAt.add({ milliseconds: 37 }) }
        };
        await expect(repo.reservations.releaseReserved([computeResourceInboxObservedReplacement({
            ...observed,
            dequeueAudit: { ...observed.dequeueAudit, attempts: 1 }
        }, candidate)])).resolves.toEqual([null]);
        const [released] = await repo.reservations.releaseReserved([computeResourceInboxObservedReplacement(observed, candidate)]);

        expect(released?.dequeueAudit.endTs?.toString()).toBe(releasedAt.toString());
        expect(released?.dequeueAudit.nextTs?.toString())
            .toBe(releasedAt.add({ milliseconds: 37 }).toString());
        expect(await repo.entries.findByKey(entry.key)).toMatchObject({
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 2 }
        });
    });

    it('releases a sixteen-claim batch of mixed outcomes in one update statement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const releasedAt = Temporal.Instant.from('2026-01-01T00:01:00.123Z');
        const reserved: ResourceEntry[] = [];
        for (let index = 0; index < 16; index += 1) {
            const entry = createEntry(createKey(`batch-release-${index}`), {
                text: 'reserved',
                expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
            });
            await repo.entries.write(entry);
            const stored = findStoredResourceInboxRow(harness.rows, entry.key)!;
            stored.ri_status = EntityStatus.RESERVED;
            stored.ri_attempts = 1n;
            stored.start_ts = '2026-01-01 00:00:00.000000';
            reserved.push((await repo.entries.findByKey(entry.key))!);
        }
        const dispositions = [
            { status: EntityStatus.COMPLETED, delayMs: null },
            { status: EntityStatus.RETRY, delayMs: 1_000 },
            { status: EntityStatus.RETRY, delayMs: 250, reason: 'not-ready' }
        ] as const;
        harness.sqlCalls.length = 0;

        await new PSqlQueueBox(repo, () => releasedAt).releaseEntries(
            reserved.map((entry, index) => ({ entry, disposition: dispositions[index % 3]! }))
        );

        expect(harness.sqlCalls).toHaveLength(1);
        expect(reserved.map((entry) => {
            const row = findStoredResourceInboxRow(harness.rows, entry.key)!;
            return [row.ri_status, row.ri_attempts, row.next_ts];
        })).toEqual(reserved.map((_, index) =>
            [
                [EntityStatus.COMPLETED, 1n, null],
                [EntityStatus.RETRY, 1n, '2026-01-01 00:01:01.123000'],
                [EntityStatus.RETRY, 0n, '2026-01-01 00:01:00.373000']
            ][index % 3]
        ));
    });

    it.each(
        [
            ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
            ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
            ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
            ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
            ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }]
        ] as const
    )('rejects invalid repository release disposition before SQL: %s', async (
        _scenario,
        disposition
    ) => {
        const capture = createResourceInboxQueryCapture();
        const repo = createPSqlResourceInboxRepository(capture.sql, () => new Date());

        const entry = createEntry(createKey(`invalid-${_scenario}`), {
            text: 'invalid release',
            expiryTs: Temporal.Instant.from('9999-01-01T00:00:00Z')
        });
        await expect(new PSqlQueueBox(repo, Temporal.Now.instant).releaseEntries([{ entry: entry, disposition: disposition as never }])).rejects.toMatchObject({
            code: 'resource-inbox-invalid-release-disposition'
        });

        expect(capture.queries).toHaveLength(0);
    });

    it('rejects a nonterminal finish status before issuing SQL', async () => {
        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const sqlCallsBefore = harness.sqlCalls.length;

        await expect(repo.finalization.finishReserved(
            createKey('invalid-finish-status'),
            1,
            EntityStatus.RETRY as typeof EntityStatus.COMPLETED,
            new Date('2026-01-01T00:01:00.000Z')
        )).rejects.toThrow('Resource inbox reservation finish status must be COMPLETED, FAILED or NON_RETRYABLE');
        expect(harness.sqlCalls).toHaveLength(sqlCallsBefore);
    });

    it('keeps independent SQL rows when topic and resource slots contain delimiters', async () => {
        const harness = createResourceInboxSqlHarness();
        const repository = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const left = createEntry({ topicId: 'a::b', resourceId: 'c', contextId: 'ctx' }, {
            text: 'left',
            expiryTs: Temporal.Instant.from('9999-01-01T00:00:00Z')
        });
        const right = createEntry({ topicId: 'a', resourceId: 'b::c', contextId: 'ctx' }, {
            text: 'right',
            expiryTs: Temporal.Instant.from('9999-01-01T00:00:00Z')
        });

        await repository.entries.write(left);
        await repository.entries.write(right);
        expect(await repository.entries.findByKey(left.key)).toMatchObject({ key: left.key, resource: '{"text":"left"}' });
        expect(await repository.entries.findByKey(right.key)).toMatchObject({ key: right.key, resource: '{"text":"right"}' });
    });

    it('keeps write strict while writeIfAbsent returns active rows and replaces expired rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const activeKey = createKey('active-1');
        const expiredKey = createKey('expired-1');

        const activeOriginal = createEntry(activeKey, {
            text: 'active-original',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 }),
            createdBy: 'alice'
        });
        const activeReplacement = createEntry(activeKey, {
            text: 'active-replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 10 }),
            createdBy: 'bob'
        });

        await repo.entries.write(activeOriginal);
        await expect(repo.entries.write(activeReplacement)).rejects.toMatchObject({
            code: '23505'
        });

        const returnedExisting = await repo.entries.writeIfAbsentOrReplaceExpired(activeReplacement);

        expect(JSON.parse(returnedExisting.resource)).toEqual({ text: 'active-original' });
        expect(returnedExisting.audit.createdBy).toBe('alice');
        expect(JSON.parse(findStoredResourceInboxRow(harness.rows, activeKey)?.ri_resource ?? '{}')).toEqual({
            text: 'active-original'
        });

        const expiredOriginal = createEntry(expiredKey, {
            text: 'expired-original',
            createdTs: Temporal.PlainDateTime.from('2025-12-31T23:59:58'),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
            createdBy: 'carol'
        });
        const expiredReplacement = createEntry(expiredKey, {
            text: 'expired-replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 1 }),
            createdBy: 'dave'
        });

        await repo.entries.write(expiredOriginal);
        await expect(repo.entries.write(expiredReplacement)).rejects.toMatchObject({
            code: '23505'
        });

        const replaced = await repo.entries.writeIfAbsentOrReplaceExpired(expiredReplacement);

        expect(JSON.parse(replaced.resource)).toEqual({ text: 'expired-replacement' });
        expect(replaced.audit.createdBy).toBe('dave');
        expect(findStoredResourceInboxRow(harness.rows, expiredKey)?.expire_ts).toBe(
            toStoredResourceInboxTimestamp(expiredReplacement.audit.expiryTs)
        );
    });

    it('replace overwrites an existing row including audit and expiry fields', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const key = createKey('replace-1');
        const original = createEntry(key, {
            text: 'original',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 }),
            createdBy: 'alice'
        });
        const replacement = createEntry(key, {
            text: 'replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 10 }),
            createdBy: 'bob',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:01:00')
        });

        const storedOriginal = await repo.entries.write(original);
        const replaced = await repo.entries.replace(replacement);

        expect(replaced.db?.id).toBe(storedOriginal.db?.id);
        expect(JSON.parse(replaced.resource)).toEqual({ text: 'replacement' });
        expect(replaced.audit.createdBy).toBe('bob');
        expect(findStoredResourceInboxRow(harness.rows, key)?.created_ts).toBe(
            toStoredResourceInboxTimestamp(replacement.audit.createdTs)
        );
        expect(findStoredResourceInboxRow(harness.rows, key)?.expire_ts).toBe(
            toStoredResourceInboxTimestamp(replacement.audit.expiryTs)
        );
    });

    it('replaces only the exact live PostgreSQL row observation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const key = createKey('replace-observed');
        const observed = await repo.entries.write(createEntry(key, {
            text: 'observed',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        }));
        const replacement = {
            ...observed,
            resource: JSON.stringify({ text: 'replacement' })
        };

        expect(await repo.entries.replaceIfObserved(observed, replacement)).toMatchObject({
            resource: replacement.resource,
            db: observed.db
        });

        const replaced = await repo.entries.findAnyByKey(key);
        if (replaced === null) {
            throw new Error('Expected the replaced row');
        }
        const stored = findStoredResourceInboxRow(harness.rows, key);
        if (stored === undefined) {
            throw new Error('Expected the stored row');
        }
        stored.ri_attempts = 1n;
        stored.ri_status = EntityStatus.RESERVED;
        stored.start_ts = toStoredResourceInboxTimestamp(
            Temporal.Now.instant().add({ seconds: 1 })
        );

        expect(
            await repo.entries.replaceIfObserved(replaced, {
                ...replaced,
                resource: JSON.stringify({ text: 'stale replacement' })
            })
        ).toBeNull();
        expect(JSON.parse(stored.ri_resource)).toEqual({ text: 'replacement' });
    });

    it('rejects a recreated or expired PostgreSQL row as a stale observation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const recreatedKey = createKey('replace-recreated');
        const recreatedObserved = await repo.entries.write(createEntry(recreatedKey, {
            text: 'observed',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        }));
        const recreatedRow = findStoredResourceInboxRow(harness.rows, recreatedKey);
        if (recreatedRow === undefined) {
            throw new Error('Expected the recreated-row fixture');
        }
        recreatedRow.ri_row_id += 1n;

        expect(
            await repo.entries.replaceIfObserved(recreatedObserved, {
                ...recreatedObserved,
                resource: JSON.stringify({ text: 'must not replace recreated row' })
            })
        ).toBeNull();

        const expiredKey = createKey('replace-expired');
        const expiredObserved = await repo.entries.write(createEntry(expiredKey, {
            text: 'observed',
            expiryTs: Temporal.Now.instant().add({ seconds: 1 })
        }));
        vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));

        expect(
            await repo.entries.replaceIfObserved(expiredObserved, {
                ...expiredObserved,
                resource: JSON.stringify({ text: 'must not replace expired row' })
            })
        ).toBeNull();
    });

    it('filters expired rows from reads and startProcessingEntity', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const active = createEntry(createKey('active-1'), {
            text: 'active',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            createdTs: Temporal.PlainDateTime.from('2025-12-31T23:59:58'),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });

        await repo.entries.write(active);
        await repo.entries.write(expired);

        expect(await repo.entries.findByKey(active.key)).not.toBeNull();
        expect(await repo.entries.findByKey(expired.key)).toBeNull();
        expect((await repo.reservations.startProcessingEntity(expired)).left).toEqual({
            kind: 'expired-or-missing',
            key: expired.key
        });

        const reserved = await repo.reservations.startProcessingEntity(active);

        expect(reserved.right?.status).toBe(EntityStatus.RESERVED);
        expect(reserved.right?.dequeueAudit.attempts).toBe(1);
        expect(reserved.right?.dequeueAudit.startTs).toBeDefined();
    });

    it('keeps audit fields immutable when upsert updates an existing row', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const key = createKey('immutable-1');
        const original = createEntry(key, {
            text: 'original',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        const storedOriginal = await repo.entries.write(original);

        const updated = await repo.entries.upsert({
            ...original,
            resource: JSON.stringify({ text: 'updated' }),
            status: EntityStatus.RETRY,
            audit: {
                ...original.audit,
                createdBy: 'bob',
                createdTs: Temporal.PlainDateTime.from('2026-01-01T00:01:00'),
                expiryTs: Temporal.Instant.from('2026-01-01T00:10:00Z')
            },
            dequeueAudit: {
                attempts: 4,
                startTs: Temporal.Instant.from('2026-01-01T00:01:00Z'),
                endTs: Temporal.Instant.from('2026-01-01T00:01:01Z'),
                nextTs: Temporal.Instant.from('2026-01-01T00:02:00Z')
            }
        });

        expect(updated.audit.createdBy).toBe(storedOriginal.audit.createdBy);
        expect(updated.audit.createdTs.toString()).toBe(
            storedOriginal.audit.createdTs.toString()
        );
        expect(updated.audit.expiryTs.toString()).toBe(
            storedOriginal.audit.expiryTs.toString()
        );
        expect(updated.status).toBe(EntityStatus.RETRY);
        expect(updated.dequeueAudit.attempts).toBe(4);
        expect(updated.dequeueAudit.nextTs?.toString()).toBe('2026-01-01T00:02:00Z');
        expect(JSON.parse(updated.resource)).toEqual({ text: 'updated' });
    });

    it('deleteExpired only removes rows whose expiry has passed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createResourceInboxSqlHarness();
        const repo = createPSqlResourceInboxRepository(harness.sql, () => new Date());
        const active = createEntry(createKey('active-1'), {
            text: 'active',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            createdTs: Temporal.PlainDateTime.from('2025-12-31T23:59:58'),
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });

        await repo.entries.write(active);
        await repo.entries.write(expired);

        expect(await repo.maintenance.deleteExpired()).toBe(1);
        expect(await repo.entries.findByKey(active.key)).not.toBeNull();
        expect(await repo.entries.findByKey(expired.key)).toBeNull();
    });
});

function createKey(resourceId: string): Key {
    return {
        topicId: 'chat.message.v1',
        resourceId,
        contextId: 'room-1'
    };
}

interface EntryOptions {
    readonly text: string;
    readonly createdBy?: string;
    readonly createdTs?: Temporal.PlainDateTime;
    readonly expiryTs: Temporal.Instant;
}

function createEntry(key: Key, options: EntryOptions): ResourceEntry {
    return {
        key,
        resource: JSON.stringify({ text: options.text }),
        typeId: 'ws.outbox',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: options.createdBy ?? 'test-user',
            createdTs: options.createdTs ?? Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: options.expiryTs
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0
        }
    };
}
