import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type ResourceInboxRepositoryModule = typeof import('@shared-server/queuebox/postgres/resource-inbox-repository.ts');

type ResourceInboxRow = {
    ri_row_id: bigint;
    ri_resource_id: string;
    ri_topic_id: string;
    ri_resource: string;
    ri_type_id: string;
    ri_status: string;
    fk_ext_bank_id: string;
    system_date: string;
    created_by: string;
    created_ts: string;
    expire_ts: string;
    start_ts: string | null;
    end_ts: string | null;
    next_ts: string | null;
    ri_attempts: bigint | null;
};

let repositoryModule: ResourceInboxRepositoryModule;

beforeAll(async () => {
    repositoryModule = await import(
        '@shared-server/queuebox/postgres/resource-inbox-repository.ts'
    );
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ResourceInboxRepository', () => {
    it('claims ordinary retries only when due and never claims failed or expired rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.findEntriesSkipLocked(
            new Set(['APP_INBOX']),
            new Set([EntityStatus.RETRY, EntityStatus.FAILED]),
            7
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('ri_status <>');
        expect(capture.queries[0]?.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(capture.queries[0]?.query).toContain('next_ts <=');
        expect(capture.queries[0]?.query).toContain('ri_attempts <');
        expect(capture.queries[0]?.query).toContain('for update skip locked');
        expect(capture.queries[0]?.query).not.toContain('start_ts is null or next_ts');
    });

    it('claims only retry rows at least thirty seconds overdue through the fairness selector', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);
        const overdueBeforeEpochMs = Date.parse('2026-01-01T00:00:00.000Z');

        await repo.findOverdueRetryEntriesSkipLocked(
            new Set(['APP_INBOX']),
            overdueBeforeEpochMs,
            3
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('ri_status =');
        expect(capture.queries[0]?.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(capture.queries[0]?.query).toContain('next_ts <=');
        expect(capture.queries[0]?.query).toContain('ri_attempts <');
        expect(capture.queries[0]?.query).toContain('order by next_ts asc, ri_row_id asc');
        expect(capture.queries[0]?.query).toContain('for update skip locked');
        expect(capture.queries[0]?.values).toContain(EntityStatus.RETRY);
        expect(capture.queries[0]?.values).not.toContain(EntityStatus.FAILED);
        expect(capture.queries[0]?.values).toContainEqual(new Date(overdueBeforeEpochMs));
    });

    it('uses a configured two-attempt budget in PostgreSQL reservation selectors', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.findEntriesSkipLocked(
            new Set(['APP_INBOX']),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 2 }
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.values).toContain(2);
        expect(capture.queries[0]?.values).not.toContain(20);
    });

    it('uses database time and the configured budget for ordinary work advertisement', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.isEntriesToLock(
            new Set(['APP_INBOX']),
            new Set([EntityStatus.RETRY]),
            2
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(capture.queries[0]?.query).toContain('next_ts <= (now() at time zone \'utc\')');
        expect(capture.queries[0]?.values).toContain(2);
        expect(capture.queries[0]?.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('uses a safely bound database interval for timeout work advertisement', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.isTimeoutOnReservedEntries(
            new Set(['APP_INBOX']),
            Temporal.Duration.from({ seconds: 30 }),
            2
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(capture.queries[0]?.query).toContain('start_ts < (now() -');
        expect(capture.queries[0]?.query).toContain('interval \'1 millisecond\'');
        expect(capture.queries[0]?.values).toContain(30_000);
        expect(capture.queries[0]?.values).toContain(2);
        expect(capture.queries[0]?.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('uses a safely bound database interval for timeout claiming', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.findTimedOutReservedEntriesSkipLocked(
            new Set(['APP_INBOX']),
            30_000,
            { maxToReserve: 3, maxAttempts: 2 }
        );

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(capture.queries[0]?.query).toContain('start_ts < (now() -');
        expect(capture.queries[0]?.query).toContain('interval \'1 millisecond\'');
        expect(capture.queries[0]?.values).toContain(30_000);
        expect(capture.queries[0]?.values).toContain(2);
        expect(capture.queries[0]?.values.some((value) => value instanceof Date)).toBe(false);
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
        'rejects invalid timeout claim interval %s before SQL',
        async (timeSinceStartMs) => {
            const capture = createQueryCapture();
            const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

            await expect(repo.findTimedOutReservedEntriesSkipLocked(
                new Set(['APP_INBOX']),
                timeSinceStartMs,
                1
            )).rejects.toThrow(/non-negative safe integer/u);
            expect(capture.queries).toHaveLength(0);
        }
    );

    it('uses database time for the persisted reservation start timestamp', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);
        const entry = createEntry(createKey('db-clock-start'), {
            text: 'db clock',
            expiryTs: Temporal.Instant.from('9999-01-01T00:00:00Z')
        });

        await repo.startProcessingEntity(entry, 2);

        expect(capture.queries).toHaveLength(1);
        expect(capture.queries[0]?.query).toContain('start_ts = now()');
        expect(capture.queries[0]?.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('selects only live stale exhausted AppInbox reservations with the database clock', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.findRetryExhaustionFinalizationsSkipLocked(
            new Set(['APP_INBOX', 'APP_OUTBOX']),
            300_000,
            { processingAttempts: 20, maxToReserve: 3 }
        );

        const query = capture.queries[0]!;
        expect(query.query).toContain('ri_type_id =');
        expect(query.query).toContain('ri_status =');
        expect(query.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(query.query).toContain('ri_attempts >=');
        expect(query.query).toContain('ri_attempts <');
        expect(query.query).toContain('start_ts <= (now() -');
        expect(query.query).toContain('interval \'1 millisecond\'');
        expect(query.query).toContain('for update skip locked');
        expect(query.values).toContain('APP_INBOX');
        expect(query.values).not.toContain('APP_OUTBOX');
        expect(query.values).toContain(20);
        expect(query.values).toContain(300_000);
        expect(query.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('advances finalization generation with exact attempt and live reservation fences', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);
        const entry = {
            ...createEntry(createKey('finalization-generation'), {
                text: 'recover',
                expiryTs: Temporal.Instant.from('9999-01-01T00:00:00Z')
            }),
            typeId: 'APP_INBOX',
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                attempts: 21,
                startTs: Temporal.Instant.from('2026-01-01T00:00:00Z')
            }
        };

        await repo.startFinalizationRecovery(entry, 20);

        const query = capture.queries[0]!;
        expect(query.query).toContain('ri_attempts = ri_attempts + 1');
        expect(query.query).toContain('start_ts = now()');
        expect(query.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(query.query).toContain('ri_attempts =');
        expect(query.query).toContain('ri_attempts >=');
        expect(query.query).toContain('ri_type_id =');
        expect(query.query).toContain('ri_status =');
        expect(query.values).toContain(21);
        expect(query.values).toContain(20);
        expect(query.values).toContain('APP_INBOX');
        expect(query.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('advertises stale finalization recovery using only the database clock', async () => {
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await repo.isRetryExhaustionFinalizationRequired(
            new Set(['APP_INBOX']),
            300_000,
            20
        );

        const query = capture.queries[0]!;
        expect(query.query).toContain('expire_ts > (now() at time zone \'utc\')');
        expect(query.query).toContain('start_ts <= (now() -');
        expect(query.query).toContain('ri_attempts >=');
        expect(query.values).toContain(300_000);
        expect(query.values).toContain(20);
        expect(query.values.some((value) => value instanceof Date)).toBe(false);
    });

    it('inserts immutable outbox content once and matches an operationally advanced replay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey('idempotent-outbox'), {
            text: 'immutable',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await expect(repo.writeIfAbsentOrMatch(entry)).resolves.toBe('inserted');

        const stored = findStoredRow(harness.rows, entry.key);
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

        await expect(repo.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
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

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
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

        await repo.writeIfAbsentOrMatch(original);

        await expect(repo.writeIfAbsentOrMatch(replay)).rejects.toBeInstanceOf(
            repositoryModule.ResourceInboxInvariantCorruptionError
        );
    });

    it.each([
        [
            'creation',
            'below half',
            '2026-06-01T12:00:00.0000004',
            '2026-06-01 12:00:00.000000'
        ],
        [
            'creation',
            'half even down',
            '2026-06-01T12:00:00.0000005',
            '2026-06-01 12:00:00.000000'
        ],
        [
            'creation',
            'half even up',
            '2026-06-01T12:00:00.0000015',
            '2026-06-01 12:00:00.000002'
        ],
        [
            'creation',
            'above half',
            '2026-06-01T12:00:00.0000006',
            '2026-06-01 12:00:00.000001'
        ],
        [
            'creation',
            'second rollover',
            '2026-06-01T12:00:00.9999995',
            '2026-06-01 12:00:01.000000'
        ],
        [
            'expiry',
            'below half',
            '2026-06-01T13:00:00.0000004Z',
            '2026-06-01 13:00:00.000000'
        ],
        [
            'expiry',
            'half even down',
            '2026-06-01T13:00:00.0000005Z',
            '2026-06-01 13:00:00.000000'
        ],
        [
            'expiry',
            'half even up',
            '2026-06-01T13:00:00.0000015Z',
            '2026-06-01 13:00:00.000002'
        ],
        [
            'expiry',
            'above half',
            '2026-06-01T13:00:00.0000006Z',
            '2026-06-01 13:00:00.000001'
        ],
        [
            'expiry',
            'second rollover',
            '2026-06-01T13:00:00.9999995Z',
            '2026-06-01 13:00:01.000000'
        ]
    ])('matches PostgreSQL timestamp(6) %s %s rounding', async (
        field,
        _scenario,
        candidate,
        persisted
    ) => {
        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const key = createKey(`rounding-${field}-${_scenario}`);
        const entry = createEntry(key, {
            text: 'immutable',
            createdTs: field === 'creation'
                ? Temporal.PlainDateTime.from(candidate)
                : Temporal.PlainDateTime.from('2026-06-01T12:00:00'),
            expiryTs: field === 'expiry'
                ? Temporal.Instant.from(candidate)
                : Temporal.Instant.from('2026-06-01T13:00:00Z')
        });

        await repo.writeIfAbsentOrMatch(entry);
        const stored = findStoredRow(harness.rows, key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        if (field === 'creation') {
            stored.created_ts = persisted;
        }
        else {
            stored.expire_ts = persisted;
        }

        await expect(repo.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
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

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey(`collision-${_field}`), {
            text: 'immutable',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.writeIfAbsentOrMatch(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        mutate(stored);

        await expect(repo.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            repositoryModule.ResourceInboxInvariantCorruptionError
        );
    });

    it('rejects an invalid stored lifecycle when immutable content matches', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey('invalid-lifecycle'), {
            text: 'immutable',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.writeIfAbsentOrMatch(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = 'NOT_A_STATUS';

        await expect(repo.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            repositoryModule.ResourceInboxInvariantCorruptionError
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
        }],
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
        }],
        ['next attempt before end', (row: ResourceInboxRow) => {
            row.ri_status = EntityStatus.RETRY;
            row.ri_attempts = 1n;
            row.start_ts = '2026-01-01 00:01:00.000000';
            row.end_ts = '2026-01-01 00:01:01.000000';
            row.next_ts = '2026-01-01 00:01:00.999999';
        }]
    ])('rejects an enum-valid but impossible lifecycle: %s', async (
        _scenario,
        mutate
    ) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey(`invalid-${_scenario}`), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.writeIfAbsentOrMatch(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        mutate(stored);

        await expect(repo.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            repositoryModule.ResourceInboxInvariantCorruptionError
        );
    });

    it('rejects a lifecycle whose expiry is not after creation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey('invalid-created-expiry-order'), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00.000001'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:00:00.000001Z')
        });

        await repo.writeIfAbsentOrMatch(entry);

        await expect(repo.writeIfAbsentOrMatch(entry)).rejects.toBeInstanceOf(
            repositoryModule.ResourceInboxInvariantCorruptionError
        );
    });

    it.each([
        [
            'scheduled retry',
            EntityStatus.RETRY,
            0n,
            null,
            null,
            '2026-01-01 00:01:00.000000'
        ],
        [
            'active reservation',
            EntityStatus.RESERVED,
            1n,
            '2026-01-01 00:01:00.000000',
            null,
            null
        ],
        [
            'processed retry',
            EntityStatus.RETRY,
            1n,
            '2026-01-01 00:01:00.000000',
            '2026-01-01 00:01:01.000000',
            '2026-01-01 00:01:02.000000'
        ],
        [
            'terminal failure',
            EntityStatus.FAILED,
            1n,
            '2026-01-01 00:01:00.000000',
            '2026-01-01 00:01:01.000000',
            null
        ],
        [
            'delayed failure',
            EntityStatus.FAILED,
            1n,
            '2026-01-01 00:01:00.000000',
            '2026-01-01 00:01:01.000000',
            '2026-01-01 00:01:02.000000'
        ]
    ])('matches immutable content after a valid %s lifecycle advance', async (
        _scenario,
        status,
        attempts,
        startTs,
        endTs,
        nextTs
    ) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const entry = createEntry(createKey(`valid-${_scenario}`), {
            text: 'immutable',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        await repo.writeIfAbsentOrMatch(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = status;
        stored.ri_attempts = attempts;
        stored.start_ts = startTs;
        stored.end_ts = endTs;
        stored.next_ts = nextTs;

        await expect(repo.writeIfAbsentOrMatch(entry)).resolves.toBe('matched');
    });

    it('finishes only the current live reservation with the expected attempt', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const completedAt = new Date('2026-01-01T00:01:00.000Z');
        const entry = createEntry(createKey('reserved-finish'), {
            text: 'reserved',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });
        await repo.write(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = EntityStatus.RESERVED;
        stored.ri_attempts = 2n;

        await expect(repo.finishReserved(
            entry.key,
            1,
            EntityStatus.COMPLETED,
            completedAt
        )).resolves.toBe(false);
        await expect(repo.finishReserved(
            entry.key,
            2,
            EntityStatus.COMPLETED,
            completedAt
        )).resolves.toBe(true);

        expect(stored.ri_status).toBe(EntityStatus.COMPLETED);
        expect(stored.end_ts).toBe(completedAt.toISOString());
        expect(stored.next_ts).toBeNull();
        await expect(repo.finishReserved(
            entry.key,
            2,
            EntityStatus.FAILED,
            completedAt
        )).resolves.toBe(false);
    });

    it('atomically releases only the current live reservation and returns persisted timestamps', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const releasedAt = Temporal.Instant.from('2026-01-01T00:01:00.123Z');
        const entry = createEntry(createKey('reserved-release'), {
            text: 'reserved',
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });
        await repo.write(entry);
        const stored = findStoredRow(harness.rows, entry.key);
        if (!stored) {
            throw new Error('Expected inserted resource inbox row');
        }
        stored.ri_status = EntityStatus.RESERVED;
        stored.ri_attempts = 2n;

        await expect(repo.releaseReserved(entry.key, {
            expectedAttempts: 1,
            releasedAt,
            disposition: { status: EntityStatus.RETRY, delayMs: 37 }
        })).resolves.toBeNull();

        const released = await repo.releaseReserved(entry.key, {
            expectedAttempts: 2,
            releasedAt,
            disposition: { status: EntityStatus.RETRY, delayMs: 37 }
        });

        expect(released?.dequeueAudit.endTs?.toString()).toBe(releasedAt.toString());
        expect(released?.dequeueAudit.nextTs?.toString())
            .toBe(releasedAt.add({ milliseconds: 37 }).toString());
        expect(stored.ri_status).toBe(EntityStatus.RETRY);
        expect(stored.ri_attempts).toBe(2n);
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
        const capture = createQueryCapture();
        const repo = new repositoryModule.ResourceInboxRepository(capture.sql);

        await expect(repo.releaseReserved(createKey(`invalid-${_scenario}`), {
            expectedAttempts: 1,
            releasedAt: Temporal.Instant.from('2026-01-01T00:00:00Z'),
            disposition
        } as never)).rejects.toMatchObject({
            code: 'resource-inbox-invalid-release-disposition'
        });

        expect(capture.queries).toHaveLength(0);
    });

    it('rejects a nonterminal finish status before issuing SQL', async () => {
        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const sqlCallsBefore = harness.sqlCalls.length;

        await expect(repo.finishReserved(
            createKey('invalid-finish-status'),
            1,
            EntityStatus.RETRY as typeof EntityStatus.COMPLETED,
            new Date('2026-01-01T00:01:00.000Z')
        )).rejects.toThrow('COMPLETED or FAILED');
        expect(harness.sqlCalls).toHaveLength(sqlCallsBefore);
    });

    it('keeps write strict while writeIfAbsent returns active rows and replaces expired rows', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
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

        await repo.write(activeOriginal);
        await expect(repo.write(activeReplacement)).rejects.toMatchObject({
            code: '23505'
        });

        const returnedExisting = await repo.writeIfAbsentOrReplaceExpired(activeReplacement);

        expect(JSON.parse(returnedExisting.resource)).toEqual({ text: 'active-original' });
        expect(returnedExisting.audit.createdBy).toBe('alice');
        expect(JSON.parse(findStoredRow(harness.rows, activeKey)?.ri_resource ?? '{}')).toEqual({
            text: 'active-original'
        });

        const expiredOriginal = createEntry(expiredKey, {
            text: 'expired-original',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
            createdBy: 'carol'
        });
        const expiredReplacement = createEntry(expiredKey, {
            text: 'expired-replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 1 }),
            createdBy: 'dave'
        });

        await repo.write(expiredOriginal);
        await expect(repo.write(expiredReplacement)).rejects.toMatchObject({
            code: '23505'
        });

        const replaced = await repo.writeIfAbsentOrReplaceExpired(expiredReplacement);

        expect(JSON.parse(replaced.resource)).toEqual({ text: 'expired-replacement' });
        expect(replaced.audit.createdBy).toBe('dave');
        expect(findStoredRow(harness.rows, expiredKey)?.expire_ts).toBe(
            toStoredTimestamp(expiredReplacement.audit.expiryTs)
        );
    });

    it('replace overwrites an existing row including audit and expiry fields', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
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

        const storedOriginal = await repo.write(original);
        const replaced = await repo.replace(replacement);

        expect(replaced.db?.id).toBe(storedOriginal.db?.id);
        expect(JSON.parse(replaced.resource)).toEqual({ text: 'replacement' });
        expect(replaced.audit.createdBy).toBe('bob');
        expect(findStoredRow(harness.rows, key)?.created_ts).toBe(
            toStoredTimestamp(replacement.audit.createdTs)
        );
        expect(findStoredRow(harness.rows, key)?.expire_ts).toBe(
            toStoredTimestamp(replacement.audit.expiryTs)
        );
    });

    it('filters expired rows from reads and startProcessingEntity', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const active = createEntry(createKey('active-1'), {
            text: 'active',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });

        await repo.write(active);
        await repo.write(expired);

        expect(await repo.findByKey(active.key)).not.toBeNull();
        expect(await repo.findByKey(expired.key)).toBeNull();
        expect((await repo.startProcessingEntity(expired)).left).toEqual({
            kind: 'expired-or-missing',
            key: expired.key
        });

        const reserved = await repo.startProcessingEntity(active);

        expect(reserved.right?.status).toBe(EntityStatus.RESERVED);
        expect(reserved.right?.dequeueAudit.attempts).toBe(1);
        expect(reserved.right?.dequeueAudit.startTs).toBeDefined();
    });

    it('keeps audit fields immutable when upsert updates an existing row', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const key = createKey('immutable-1');
        const original = createEntry(key, {
            text: 'original',
            createdBy: 'alice',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z')
        });

        const storedOriginal = await repo.write(original);

        const updated = await repo.upsert({
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

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const active = createEntry(createKey('active-1'), {
            text: 'active',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 })
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 })
        });

        await repo.write(active);
        await repo.write(expired);

        expect(await repo.deleteExpired()).toBe(1);
        expect(await repo.findByKey(active.key)).not.toBeNull();
        expect(await repo.findByKey(expired.key)).toBeNull();
    });
});

function createQueryCapture() {
    const queries: Array<{ query: string; values: readonly unknown[]; }> = [];
    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ) => {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }

        queries.push({
            query: normalizeQuery(stringsOrValues),
            values
        });
        return [];
    }) as {
        (
            stringsOrValues: TemplateStringsArray | readonly unknown[],
            ...values: unknown[]
        ): unknown;
        begin: <T>(fn: (sql: unknown) => Promise<T>) => Promise<T>;
    };
    sql.begin = async <T>(fn: (sql: unknown) => Promise<T>) => await fn(sql);

    return {
        queries,
        sql: sql as never
    };
}

function createSqlHarness() {
    const rows = new Map<string, ResourceInboxRow>();
    const sqlCalls: string[] = [];
    let nextRowId = 1n;

    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ) => {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }

        const query = normalizeQuery(stringsOrValues);
        sqlCalls.push(query);

        if (
            query.includes('insert into resource_inbox') &&
            !query.includes('on conflict')
        ) {
            const incoming = toRowFromInsert(values, nextRowId);
            const key = toCompositeKey(incoming);

            if (rows.has(key)) {
                throw duplicateKeyError(key);
            }

            rows.set(key, incoming);
            nextRowId += 1n;
            return [cloneRow(incoming)];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)') &&
            query.includes('do nothing')
        ) {
            const incoming = toRowFromInsert(values, nextRowId);
            const key = toCompositeKey(incoming);

            if (rows.has(key)) {
                return [];
            }

            rows.set(key, incoming);
            nextRowId += 1n;
            return [cloneRow(incoming)];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('where resource_inbox.expire_ts <= (now() at time zone \'utc\')')
        ) {
            const incoming = toRowFromInsert(values, nextRowId);
            const key = toCompositeKey(incoming);
            const existing = rows.get(key);

            if (!existing) {
                rows.set(key, incoming);
                nextRowId += 1n;
                return [cloneRow(incoming)];
            }

            if (isExpired(existing.expire_ts)) {
                const replacement = {
                    ...incoming,
                    ri_row_id: existing.ri_row_id
                };
                rows.set(key, replacement);
                return [cloneRow(replacement)];
            }

            return [];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)') &&
            query.includes('created_by = excluded.created_by') &&
            !query.includes('where resource_inbox.expire_ts <= (now() at time zone \'utc\')')
        ) {
            const incoming = toRowFromInsert(values, nextRowId);
            const key = toCompositeKey(incoming);
            const existing = rows.get(key);

            if (!existing) {
                rows.set(key, incoming);
                nextRowId += 1n;
                return [cloneRow(incoming)];
            }

            const updated: ResourceInboxRow = {
                ...incoming,
                ri_row_id: existing.ri_row_id
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)') &&
            !query.includes('where resource_inbox.expire_ts <= (now() at time zone \'utc\')')
        ) {
            const incoming = toRowFromInsert(values, nextRowId);
            const key = toCompositeKey(incoming);
            const existing = rows.get(key);

            if (!existing) {
                rows.set(key, incoming);
                nextRowId += 1n;
                return [cloneRow(incoming)];
            }

            const updated: ResourceInboxRow = {
                ...existing,
                ri_resource: incoming.ri_resource,
                ri_type_id: incoming.ri_type_id,
                ri_status: incoming.ri_status,
                start_ts: incoming.start_ts,
                end_ts: incoming.end_ts,
                next_ts: incoming.next_ts,
                ri_attempts: incoming.ri_attempts
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('from resource_inbox') &&
            query.includes('where ri_topic_id =') &&
            query.includes('ri_resource_id =') &&
            query.includes('fk_ext_bank_id =')
        ) {
            const [topicId, resourceId, contextId, expireAfter] = values;
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            if (!row) {
                return [];
            }

            if (
                expireAfter instanceof Date &&
                toStoredTimestampEpochMs(row.expire_ts) <= expireAfter.getTime()
            ) {
                return [];
            }

            return [cloneRow(row)];
        }

        if (
            query.includes('update resource_inbox') &&
            query.includes('set ri_status = , end_ts') &&
            query.includes('end_ts') &&
            query.includes('next_ts') &&
            query.includes('returning *')
        ) {
            const [status, endTs, nextTs, topicId, resourceId, contextId, reserved, expectedAttempts] = values;
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            if (
                !row ||
                row.ri_status !== reserved ||
                row.ri_attempts !== BigInt(expectedAttempts as number) ||
                isExpired(row.expire_ts)
            ) {
                return [];
            }

            row.ri_status = status as string;
            row.end_ts = toOptionalString(endTs);
            row.next_ts = toOptionalString(nextTs);
            return [cloneRow(row)];
        }

        if (
            query.includes('update resource_inbox') &&
            query.includes('ri_status = \'reserved\'') &&
            query.includes('ri_attempts =') &&
            query.includes('returning ri_row_id')
        ) {
            const [status, completedAt, topicId, resourceId, contextId, expectedAttempts] = values;
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            if (
                !row ||
                row.ri_status !== EntityStatus.RESERVED ||
                row.ri_attempts !== BigInt(expectedAttempts as number) ||
                isExpired(row.expire_ts)
            ) {
                return [];
            }

            row.ri_status = status as string;
            row.end_ts = toOptionalString(completedAt);
            row.next_ts = null;
            return [{ ri_row_id: row.ri_row_id }];
        }

        if (
            query.includes('update resource_inbox') &&
            query.includes('set ri_status =') &&
            query.includes('ri_attempts =') &&
            query.includes('expire_ts > (now() at time zone \'utc\')')
        ) {
            const usesDatabaseStart = query.includes('start_ts = now()');
            const [status, attempts, ...remaining] = values;
            const [startTs, endTs, nextTs, topicId, resourceId, contextId] = usesDatabaseStart
                ? [new Date(), ...remaining]
                : remaining;
            const key = `${contextId}::${topicId}::${resourceId}`;
            const row = rows.get(key);

            if (!row || isExpired(row.expire_ts)) {
                return [];
            }

            const updated: ResourceInboxRow = {
                ...row,
                ri_status: status as string,
                ri_attempts: BigInt(attempts as number),
                start_ts: toOptionalString(startTs),
                end_ts: toOptionalString(endTs),
                next_ts: toOptionalString(nextTs)
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('delete from resource_inbox') &&
            query.includes('where expire_ts <= (now() at time zone \'utc\')')
        ) {
            const deleted: Array<{ ri_row_id: bigint; }> = [];

            for (const [key, row] of rows.entries()) {
                if (!isExpired(row.expire_ts)) {
                    continue;
                }

                rows.delete(key);
                deleted.push({ ri_row_id: row.ri_row_id });
            }

            return deleted;
        }

        throw new Error(`Unhandled SQL in test harness: ${query}`);
    }) as {
        (
            stringsOrValues: TemplateStringsArray | readonly unknown[],
            ...values: unknown[]
        ): unknown;
        begin: <T>(fn: (sql: unknown) => Promise<T>) => Promise<T>;
    };

    sql.begin = async <T>(fn: (sql: unknown) => Promise<T>) => await fn(sql);

    return {
        rows,
        sqlCalls,
        sql: sql as never
    };
}

function isTemplateCall(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}

function normalizeQuery(strings: TemplateStringsArray): string {
    return strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function toRowFromInsert(values: readonly unknown[], rowId: bigint): ResourceInboxRow {
    const [
        resourceId,
        topicId,
        resource,
        typeId,
        status,
        contextId,
        systemDate,
        createdBy,
        createdTs,
        expireTs,
        startTs,
        endTs,
        nextTs,
        attempts
    ] = values;

    return {
        ri_row_id: rowId,
        ri_resource_id: resourceId as string,
        ri_topic_id: topicId as string,
        ri_resource: resource as string,
        ri_type_id: typeId as string,
        ri_status: status as string,
        fk_ext_bank_id: contextId as string,
        system_date: systemDate as string,
        created_by: createdBy as string,
        created_ts: toStoredTimestamp(createdTs),
        expire_ts: toStoredTimestamp(expireTs),
        start_ts: toOptionalString(startTs),
        end_ts: toOptionalString(endTs),
        next_ts: toOptionalString(nextTs),
        ri_attempts: BigInt((attempts as number) ?? 0)
    };
}

function toCompositeKey(row: Pick<ResourceInboxRow, 'fk_ext_bank_id' | 'ri_topic_id' | 'ri_resource_id'>): string {
    return `${row.fk_ext_bank_id}::${row.ri_topic_id}::${row.ri_resource_id}`;
}

function cloneRow(row: ResourceInboxRow): ResourceInboxRow {
    return {
        ...row
    };
}

function duplicateKeyError(key: string): Error & { code: string; } {
    const error = new Error(
        `duplicate key value violates unique constraint resource_inbox_unique_k: ${key}`
    ) as Error & { code: string; };
    error.code = '23505';
    return error;
}

function createKey(resourceId: string): Key {
    return {
        topicId: 'chat.message.v1',
        resourceId,
        contextId: 'room-1'
    };
}

function createEntry(
    key: Key,
    options: Readonly<{
        text: string;
        createdBy?: string;
        createdTs?: Temporal.PlainDateTime;
        expiryTs: Temporal.Instant;
    }>
): ResourceEntry {
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

function findStoredRow(
    rows: ReadonlyMap<string, ResourceInboxRow>,
    key: Key
): ResourceInboxRow | undefined {
    return rows.get(`${key.contextId}::${key.topicId}::${key.resourceId}`);
}

function isExpired(expireTs: string): boolean {
    return toStoredTimestampEpochMs(expireTs) <= Date.now();
}

function toOptionalString(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return String(value);
}

function toStoredTimestamp(value: unknown): string {
    const text = value instanceof Date ? value.toISOString() : String(value);
    const withoutZone = text.replace('T', ' ').replace(/[zZ]$/u, '');
    const [whole, fraction = ''] = withoutZone.split('.');
    return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

function toStoredTimestampEpochMs(value: string): number {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
}
