import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxRowCorruptionError } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    toResourceEntryWithKey,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../al-runtime/postgres/create-p-sql-admission-test-storage.ts';

const NEW_ENTRY: ResourceEntry = {
    key: { topicId: 'work', resourceId: 'request', contextId: 'context' },
    typeId: 'WORK',
    resource: 'opaque-resource',
    status: EntityStatus.NEW,
    audit: {
        date: Temporal.PlainTime.from('12:00:00.123456'),
        createdBy: 'sender',
        createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00.123456'),
        expiryTs: NEVER_EXPIRE_TS
    },
    dequeueAudit: { attempts: 0 }
};

describe('PostgreSQL full-row integrity', () => {
    it('reads an already-expired builder entry without claiming or rewriting it', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const entry = toResourceEntryWithKey(NEW_ENTRY.key, 'WORK', { fact: 'expired-delivery' }, Temporal.Instant.from('2000-01-01T00:00:00Z'));
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        expect(await repository.entries.writeIfAbsentOrMatch(entry)).toBe('inserted');
        const before = await sql`select * from resource_inbox`;

        const stored = await repository.entries.findAnyByKey(entry.key);
        expect(stored?.audit.createdTs.equals(entry.audit.createdTs.round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' }))).toBe(true);
        expect(stored?.audit.expiryTs.equals(entry.audit.expiryTs)).toBe(true);
        expect(await repository.entries.writeIfAbsentOrMatch(entry)).toBe('matched');
        expect(await queue.reserveEntries({ typeIds: new Set(['WORK']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).toEqual(new Map());
        expect(await queue.getItem(entry.key)).toBeUndefined();
        expect(await sql`select * from resource_inbox`).toEqual(before);
    });

    it('preserves a not-ready retry capped by expiry across independent SQL and release clocks', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const current = Temporal.Now.instant().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const expiry = current.add({ hours: 1 });
        const completion = current.add({ hours: 2 });
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), () => completion);
        await queue.enqueue({
            ...NEW_ENTRY,
            status: EntityStatus.RESERVED,
            audit: { ...NEW_ENTRY.audit, expiryTs: expiry },
            dequeueAudit: { attempts: 2, startTs: current }
        });
        const reserved = (await queue.getItem(NEW_ENTRY.key))!;
        const [eligibility] = await sql<{ eligible: boolean; }[]>`
            select expire_ts > (now() at time zone 'UTC') as eligible from resource_inbox
        `;
        expect(eligibility?.eligible).toBe(true);

        const released = [...(await queue.releaseEntries([{
            entry: reserved,
            disposition: { status: EntityStatus.RETRY, delayMs: 37, reason: 'not-ready' }
        }])).values()][0]!;

        expect(released.dequeueAudit.endTs?.equals(completion)).toBe(true);
        expect(released.dequeueAudit.nextTs?.equals(expiry)).toBe(true);
        expect(released.dequeueAudit.attempts).toBe(1);
        expect(await queue.getItem(NEW_ENTRY.key)).toEqual(released);
    });

    it.each([
        ['2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.160789Z'],
        ['2026-10-13T20:00:00.123789123Z', '2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.160789Z'],
        ['2026-10-13T20:00:00.123789789Z', '2026-10-13T20:00:00.123790Z', '2026-10-13T20:00:00.160790Z']
    ])('preserves injected release %s at PostgreSQL microsecond precision', async (capturedAt, expectedEnd, expectedNext) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), () => Temporal.Instant.from(capturedAt));
        await queue.enqueue({
            ...NEW_ENTRY,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1, startTs: Temporal.Instant.from('2026-10-13T20:00:00.123456Z') }
        });
        const reserved = (await queue.getItem(NEW_ENTRY.key))!;

        const released = [...(await queue.releaseEntries([{
            entry: reserved,
            disposition: { status: EntityStatus.RETRY, delayMs: 37, reason: 'not-ready' }
        }])).values()][0]!;

        expect(released.dequeueAudit.startTs?.toString()).toBe('2026-10-13T20:00:00.123456Z');
        expect(released.dequeueAudit.endTs?.equals(Temporal.Instant.from(expectedEnd))).toBe(true);
        expect(released.dequeueAudit.nextTs?.equals(Temporal.Instant.from(expectedNext))).toBe(true);
        expect(released.dequeueAudit.attempts).toBe(0);
        expect(await queue.getItem(NEW_ENTRY.key)).toEqual(released);
    });

    it.each([
        [{ contextId: 'ctx', topicId: 'a::b', resourceId: 'c' }, { contextId: 'ctx', topicId: 'a', resourceId: 'b::c' }],
        [{ contextId: 'ctx::a', topicId: 'b', resourceId: 'c' }, { contextId: 'ctx', topicId: 'a::b', resourceId: 'c' }]
    ])('reserves both SQL identities when different key slots contain delimiters', async (leftKey, rightKey) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        await queue.enqueue({ ...NEW_ENTRY, key: leftKey });
        await queue.enqueue({ ...NEW_ENTRY, key: rightKey });
        const observations = [(await queue.getItem(leftKey))!, (await queue.getItem(rightKey))!];

        const claimed = await queue.reserveEntries({
            typeIds: new Set(['WORK']),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 2,
            observedEntries: observations
        });

        expect([...claimed.values()]).toHaveLength(2);
        expect([...claimed.values()].map((entry) => entry.key)).toEqual(expect.arrayContaining([leftKey, rightKey]));
        expect(await queue.getItem(leftKey)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        expect(await queue.getItem(rightKey)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
    });

    it.each([
        [EntityStatus.RESERVED, '2026-01-01 12:00:00.123455', null],
        [EntityStatus.COMPLETED, '2026-01-01 12:00:00.123456', '2026-01-01 12:00:00.123455']
    ])('reads and matches a %s row without imposing cross-clock ordering', async (status, start, end) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        await repository.entries.writeIfAbsentOrMatch(NEW_ENTRY);
        await sql`update resource_inbox set ri_status = ${status}, ri_attempts = 1,
                  start_ts = ${start}, end_ts = ${end}`;
        const before = await sql`select * from resource_inbox`;

        const entry = await repository.entries.findAnyByKey(NEW_ENTRY.key);
        expect(entry?.status).toBe(status);
        expect(entry?.dequeueAudit.startTs!.equals(Temporal.Instant.from(`${start.replace(' ', 'T')}Z`))).toBe(true);
        expect(entry?.dequeueAudit.endTs?.equals(Temporal.Instant.from(`${end?.replace(' ', 'T')}Z`))).toBe(end === null ? undefined : true);
        expect(await repository.entries.writeIfAbsentOrMatch(NEW_ENTRY)).toBe('matched');
        expect(await sql`select * from resource_inbox`).toEqual(before);
    });

    it.each([EntityStatus.NEW, EntityStatus.RETRY])('rejects corrupt %s full reads and claims without repairing the persisted row', async (status) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        await queue.enqueue(NEW_ENTRY);
        await sql`update resource_inbox set ri_status = ${status}, ri_attempts = 1,
                  next_ts = ${status === EntityStatus.RETRY ? '2026-01-02T12:00:00.123456Z' : null}`;
        const before = await sql`select * from resource_inbox`;

        await expect(queue.getItem(NEW_ENTRY.key)).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(repository.entries.findAnyByKey(NEW_ENTRY.key)).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(repository.entries.findByTopicId('work')).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(repository.entries.findByTypeId('WORK')).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(repository.entries.findAllByTopicAndResourceId('work', 'request')).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(queue.reserveEntries({
            typeIds: new Set(['WORK']),
            statusIds: new Set([status]),
            reservationInput: 1
        })).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        if (status === EntityStatus.RETRY) {
            await expect(queue.reserveOverdueRetryEntries(new Set(['WORK']), Date.now(), 1))
                .rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        }
        expect(await sql`select * from resource_inbox`).toEqual(before);
        expect(await repository.entries.readStatusAndAttempts(NEW_ENTRY.key)).toEqual({ status, attempts: 1 });
    });

    it('rolls back a batch containing valid and corrupt rows without claiming the valid row', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
        await queue.enqueue(NEW_ENTRY);
        await queue.enqueue({ ...NEW_ENTRY, key: { ...NEW_ENTRY.key, resourceId: 'corrupt' } });
        await sql`update resource_inbox set ri_attempts = 1 where ri_resource_id = 'corrupt'`;
        const before = await sql`select * from resource_inbox order by ri_row_id`;

        await expect(queue.reserveEntries({
            typeIds: new Set(['WORK']),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 2
        })).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        expect(await sql`select * from resource_inbox order by ri_row_id`).toEqual(before);
    });

    it.each(['2026-01-02T12:00:00.123456Z', '2026-01-01T12:00:00.123455Z'])(
        'preserves microsecond UTC creation and zero-attempt readiness scheduled at %s through reservation and release',
        async (next) => {
            const { sql } = await createPSqlAdmissionTestStorage();
            const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
            const waiting: ResourceEntry = {
                ...NEW_ENTRY,
                status: EntityStatus.RETRY,
                dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.from(next) }
            };
            await queue.enqueue(waiting);
            const observed = (await queue.getItem(waiting.key))!;
            expect(observed.audit.createdTs.toString()).toBe('2026-01-01T12:00:00.123456');
            expect(observed.dequeueAudit.nextTs?.equals(Temporal.Instant.from(next))).toBe(true);
            const claimed = [...(await queue.reserveEntries({
                typeIds: new Set(['WORK']),
                statusIds: new Set([EntityStatus.RETRY]),
                reservationInput: 1
            })).values()][0]!;
            const released = [...(await queue.releaseEntries([{
                entry: claimed,
                disposition: { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' }
            }])).values()][0]!;

            expect(released.dequeueAudit.attempts).toBe(0);
            expect(released.dequeueAudit.nextTs!.epochMilliseconds - released.dequeueAudit.endTs!.epochMilliseconds).toBe(60_000);
            expect(released.audit.createdTs.toString()).toBe('2026-01-01T12:00:00.123456');
            expect(await queue.getItem(waiting.key)).toEqual(released);
        }
    );

    it.each(
        [
            ['scheduled new work', { status: 'NEW', attempts: 0, start: null, end: null, next: '2026-01-01 12:00:03.000000' }, '2026-01-01T12:00:03Z'],
            ['already due new work', { status: 'NEW', attempts: 0, start: null, end: null, next: '2026-01-01 11:59:59.000000' }, '2026-01-01T11:59:59Z'],
            ['unprocessed canonical record', { status: 'COMPLETED', attempts: 0, start: null, end: null, next: null }, null],
            [
                'cancelled unclaimed timeout',
                { status: 'COMPLETED', attempts: 0, start: null, end: null, next: '2026-01-01 12:00:03.000000' },
                '2026-01-01T12:00:03Z'
            ],
            ['cancelled readiness retry', {
                status: 'COMPLETED',
                attempts: 0,
                start: '2026-01-01 12:00:01.000000',
                end: '2026-01-01 12:00:02.000000',
                next: '2026-01-01 12:00:03.000000'
            }, '2026-01-01T12:00:03Z'],
            ['cancelled expiry-capped processed retry', {
                status: 'COMPLETED',
                attempts: 1,
                expiry: '2026-01-01 12:00:02.000000',
                start: '2026-01-01 12:00:01.000000',
                end: '2026-01-01 12:00:03.000000',
                next: '2026-01-01 12:00:02.000000'
            }, '2026-01-01T12:00:02Z'],
            ['cancelled processed retry', {
                status: 'COMPLETED',
                attempts: 1,
                start: '2026-01-01 12:00:01.000000',
                end: '2026-01-01 12:00:02.000000',
                next: '2026-01-01 12:00:03.000000'
            }, '2026-01-01T12:00:03Z']
        ] as const
    )('reads the verified %s shape without rewriting it', async (_label, row, expectedNext) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        await sql`insert into resource_inbox (ri_resource_id, ri_topic_id, fk_ext_bank_id, ri_type_id, ri_resource,
                  ri_status, ri_attempts, created_by, system_date, created_ts, expire_ts, start_ts, end_ts, next_ts)
                  values ('request', 'work', 'context', 'WORK', 'opaque-resource', ${row.status}, ${row.attempts}, 'ALM', '2026-01-01',
                  '2026-01-01 12:00:00.123456', ${'expiry' in row ? row.expiry : '9999-01-01 12:00:00.000000'}, ${row.start}, ${row.end}, ${row.next})`;
        const before = await sql`select * from resource_inbox`;
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());

        const entry = await repository.entries.findAnyByKey({ topicId: 'work', resourceId: 'request', contextId: 'context' });

        expect(entry).toMatchObject({ status: row.status, dequeueAudit: { attempts: row.attempts }, resource: 'opaque-resource' });
        expect(entry?.audit.createdTs.toString()).toBe('2026-01-01T12:00:00.123456');
        expect(entry?.dequeueAudit.nextTs?.toString()).toBe(expectedNext ?? undefined);
        expect(await sql`select * from resource_inbox`).toEqual(before);
    });

    it.each(
        [
            ['processed retry missing its start', {
                status: 'RETRY',
                attempts: 1,
                start: null,
                end: '2026-01-01 12:00:02.000000',
                next: '2026-01-01 12:00:03.000000'
            }],
            ['processed retry missing its end', {
                status: 'RETRY',
                attempts: 1,
                start: '2026-01-01 12:00:01.000000',
                end: null,
                next: '2026-01-01 12:00:03.000000'
            }],
            ['unprocessed completion recording half a reservation', {
                status: 'COMPLETED',
                attempts: 0,
                start: '2026-01-01 12:00:01.000000',
                end: null,
                next: null
            }],
            ['processed completion missing its end', { status: 'COMPLETED', attempts: 1, start: '2026-01-01 12:00:01.000000', end: null, next: null }]
        ] as const
    )('rejects %s as typed corruption without rewriting it', async (_label, row) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        await sql`insert into resource_inbox (ri_resource_id, ri_topic_id, fk_ext_bank_id, ri_type_id, ri_resource,
                  ri_status, ri_attempts, created_by, system_date, created_ts, expire_ts, start_ts, end_ts, next_ts)
                  values ('request', 'work', 'context', 'WORK', 'opaque-resource', ${row.status}, ${row.attempts}, 'ALM', '2026-01-01',
                  '2026-01-01 12:00:00.123456', '9999-01-01 12:00:00.000000', ${row.start}, ${row.end}, ${row.next})`;
        const before = await sql`select * from resource_inbox`;
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());

        await expect(repository.entries.findByKey({ topicId: 'work', resourceId: 'request', contextId: 'context' }))
            .rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        expect(await sql`select * from resource_inbox`).toEqual(before);
    });
});
