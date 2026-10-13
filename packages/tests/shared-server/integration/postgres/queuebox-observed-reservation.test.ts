import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
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

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres observed QueueBox reservation', () => {
    postgresIt.each(['replace', 'insert-if-absent', 'materialize'] as const)('prepares supplied %s timestamps before transaction entry', async (operation) => {
        const { sql, entry: original } = await createStorage();
        const entry = { ...original, audit: { ...original.audit, expiryTs: Temporal.Instant.from('9999-01-01T00:00:00.123456Z') } };
        const serialize = entry.audit.expiryTs.toString.bind(entry.audit.expiryTs);
        let transactionOpen = false;
        const begin = sql.begin;
        vi.spyOn(sql, 'begin').mockImplementation(async (write) => {
            transactionOpen = true;
            try {
                return await begin(write);
            }
            finally {
                transactionOpen = false;
            }
        });
        vi.spyOn(entry.audit.expiryTs, 'toString').mockImplementation(() => {
            expect(transactionOpen).toBe(false);
            return serialize();
        });
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);

        if (operation === 'replace') {
            expect(await queue.enqueue(entry)).toBeUndefined();
        }
        else if (operation === 'insert-if-absent') {
            expect((await queue.enqueueIfAbsent(entry)).resource).toBe(entry.resource);
        }
        else {
            const materialized = await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => {
                expect(transactionOpen).toBe(true);
                return { ...entry, resource: 'materialized' };
            });
            expect(materialized.resource).toBe('materialized');
            expect(
                await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => {
                    throw new Error('Replay must not materialize again');
                })
            ).toEqual(materialized);
        }
        expect((await queue.getItem(entry.key))?.resource).toBe(operation === 'materialize' ? 'materialized' : entry.resource);
    });

    postgresIt.each(['callback-failure', 'identity-change'] as const)('rolls back native winner %s', async (failure) => {
        const { sql, entry } = await createStorage();
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        await expect(repository.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => {
            if (failure === 'callback-failure') {
                throw new Error('Rejected winner payload');
            }
            return { ...entry, key: { ...entry.key, resourceId: 'different-identity' } };
        })).rejects.toThrow();
        expect(await repository.entries.findAnyByKey(entry.key)).toBeNull();
        const recovered = await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(entry, async () => ({ ...entry, resource: 'recovered' }));
        expect(recovered.resource).toBe('recovered');
        expect(await repository.entries.findAnyByKey(entry.key)).toEqual(recovered);
    });

    postgresIt.each([
        ['2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.160789Z'],
        ['2026-10-13T20:00:00.123789123Z', '2026-10-13T20:00:00.123789Z', '2026-10-13T20:00:00.160789Z'],
        ['2026-10-13T20:00:00.123789789Z', '2026-10-13T20:00:00.123790Z', '2026-10-13T20:00:00.160790Z']
    ])('preserves injected release %s at PostgreSQL microsecond precision', async (capturedAt, expectedEnd, expectedNext) => {
        const { sql, entry } = await createStorage();
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), () => Temporal.Instant.from(capturedAt));
        await queue.enqueue({
            ...entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1, startTs: Temporal.Instant.from('2026-10-13T20:00:00.123456Z') }
        });
        const reserved = (await queue.getItem(entry.key))!;

        const released = [...(await queue.releaseEntries([{
            entry: reserved,
            disposition: { status: EntityStatus.RETRY, delayMs: 37, reason: 'not-ready' }
        }])).values()][0]!;

        expect(released.dequeueAudit.startTs?.toString()).toBe('2026-10-13T20:00:00.123456Z');
        expect(released.dequeueAudit.endTs?.equals(Temporal.Instant.from(expectedEnd))).toBe(true);
        expect(released.dequeueAudit.nextTs?.equals(Temporal.Instant.from(expectedNext))).toBe(true);
        expect(released.dequeueAudit.attempts).toBe(0);
        expect(await queue.getItem(entry.key)).toEqual(released);
    });

    postgresIt.each([0, 1])('rejects late readiness at expiry plus %s ms without updating the reserved row', async (lateMs) => {
        const { first, sql, entry } = await createStorage();
        const expiry = Temporal.Instant.from('2026-01-02T00:00:00Z');
        const reserved = {
            ...entry,
            status: EntityStatus.RESERVED,
            audit: { ...entry.audit, expiryTs: expiry },
            dequeueAudit: { attempts: 1, startTs: expiry.subtract({ seconds: 1 }) }
        };
        await first.enqueue(reserved);
        const persisted = await createPSqlResourceInboxRepository(sql, () => new Date()).entries.findAnyByKey(entry.key);
        expect(persisted).toBeDefined();
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        vi.setSystemTime(expiry.epochMilliseconds + lateMs);
        const rowsBefore = await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;
        await expect(first.releaseEntries([{ entry: persisted!, disposition: { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' } }]))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`).toEqual(rowsBefore);
    });

    postgresIt('persists readiness without consuming an attempt and preserves the original guarded reservation', async () => {
        const { first, second, entry } = await createStorage();
        await first.enqueue(entry);
        const claimed =
            [...(await first.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).values()][0];
        const snapshot = JSON.stringify(claimed);
        const waiting =
            [...(await first.releaseEntries([{ entry: claimed, disposition: { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' } }])).values()][
                0
            ];
        expect(waiting.dequeueAudit.attempts).toBe(0);
        expect(waiting.dequeueAudit.nextTs!.epochMilliseconds - waiting.dequeueAudit.endTs!.epochMilliseconds).toBe(60_000);
        expect(waiting.audit).toEqual(claimed.audit);
        expect(waiting.resource).toBe(claimed.resource);
        expect(JSON.stringify(claimed)).toBe(snapshot);
        expect(await second.getItem(entry.key)).toEqual(waiting);
        expect(await second.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.RETRY]), reservationInput: 1 })).toEqual(
            new Map()
        );
        await expect(first.releaseEntries([{ entry: claimed, disposition: { status: EntityStatus.RETRY, delayMs: 1, reason: 'not-ready' } }])).rejects
            .toMatchObject({
                code: 'resource-inbox-lost-reservation'
            });
    });
    postgresIt('gives competing workers one unchanged selected message and preserves stale and waiting work', async () => {
        const { first, second, entry } = await createStorage();
        const stale = { ...entry, key: { ...entry.key, resourceId: 'stale' } };
        const waiting = { ...entry, key: { ...entry.key, resourceId: 'waiting' } };
        for (const value of [stale, entry, waiting]) {
            await first.enqueue(value);
        }
        const observations = [(await first.getItem(stale.key))!, (await first.getItem(entry.key))!];
        await second.replaceIfObserved(observations[0], { ...observations[0], resource: 'replacement' });

        const claims = await Promise.all([
            first.reserveEntries({
                typeIds: new Set([entry.typeId]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1,
                observedEntries: observations
            }),
            second.reserveEntries({
                typeIds: new Set([entry.typeId]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1,
                observedEntries: observations
            })
        ]);

        const claimed = claims.flatMap((claim) => [...claim.values()]);
        expect(claimed).toMatchObject([{ key: entry.key, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } }]);
        expect(await second.getItem(stale.key)).toMatchObject({ resource: 'replacement', dequeueAudit: { attempts: 0 } });
        expect(await second.getItem(waiting.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        await first.releaseEntries(claimed.map((entry) => ({ entry, disposition: { status: EntityStatus.NON_RETRYABLE, delayMs: null } })));
        expect(
            await second.reserveEntries({
                typeIds: new Set([entry.typeId]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 3,
                observedEntries: observations
            })
        ).toEqual(new Map());
        expect(await second.getItem(entry.key)).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1 } });
    });

    postgresIt('fences an old timeout observation while independent stale work remains claimable', async () => {
        const { first, second, entry } = await createStorage();
        const timedOut: ResourceEntry = {
            ...entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 1, startTs: Temporal.Instant.from('2026-01-02T00:00:00Z') }
        };
        const eligible = { ...timedOut, key: { ...entry.key, resourceId: 'eligible' } };
        await first.enqueue(timedOut);
        await first.enqueue(eligible);
        const observations = [(await first.getItem(entry.key))!, (await first.getItem(eligible.key))!];
        const duration = Temporal.Duration.from({ seconds: 10 });
        await second.reserveTimeoutEntries({
            typeIds: new Set([entry.typeId]),
            reservationInput: 1,
            timeSinceStartTs: duration,
            observedEntries: [observations[0]]
        });

        const reclaimed = await first.reserveTimeoutEntries({
            typeIds: new Set([entry.typeId]),
            reservationInput: 1,
            timeSinceStartTs: duration,
            observedEntries: observations
        });

        expect([...reclaimed.values()]).toMatchObject([{ key: eligible.key, dequeueAudit: { attempts: 2 } }]);
        expect(await first.getItem(entry.key)).toMatchObject({ dequeueAudit: { attempts: 2 } });
        expect(await first.reserveTimeoutEntries({ typeIds: new Set([entry.typeId]), reservationInput: 3, timeSinceStartTs: duration, observedEntries: [] }))
            .toEqual(new Map());
    });

    postgresIt('does not claim an identical new row through an observation of a deleted row', async () => {
        const { first, second, entry } = await createStorage();
        await first.enqueue(entry);
        const observed = (await first.getItem(entry.key))!;
        await second.removeItem(entry.key);
        await second.enqueue(entry);

        expect(
            await first.reserveEntries({
                typeIds: new Set([entry.typeId]),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1,
                observedEntries: [observed]
            })
        ).toEqual(new Map());
        expect(await second.getItem(entry.key)).toMatchObject({ resource: entry.resource, dequeueAudit: { attempts: 0 } });
    });

    postgresIt.each(['/', '::'])('keeps observations distinct when different key parts contain %s', async (delimiter) => {
        const { first, second, entry } = await createStorage();
        const left = { ...entry, key: { ...entry.key, topicId: `a${delimiter}b`, resourceId: 'c' } };
        const right = { ...entry, key: { ...entry.key, topicId: 'a', resourceId: `b${delimiter}c` } };
        await first.enqueue(left);
        await first.enqueue(right);
        const observations = [(await second.getItem(left.key))!, (await second.getItem(right.key))!];

        const claimed = await first.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 2,
            observedEntries: observations
        });

        expect(claimed.size).toBe(2);
        expect([...claimed.values()].map((value) => value.key)).toEqual(expect.arrayContaining([left.key, right.key]));
        expect(await second.getItem(left.key)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        expect(await second.getItem(right.key)).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
    });

    postgresIt('retains an expired builder fact for full reads and exact replay while rejecting claims', async () => {
        const { sql, entry: original } = await createStorage();
        const entry = toResourceEntryWithKey(original.key, original.typeId, { fact: 'expired-delivery' }, Temporal.Instant.from('2000-01-01T00:00:00Z'));
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const queue = new PSqlQueueBox(repository, Temporal.Now.instant);
        expect(await repository.entries.writeIfAbsentOrMatch(entry)).toBe('inserted');
        const before = await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;

        const stored = await repository.entries.findAnyByKey(entry.key);
        expect(stored?.audit.createdTs.equals(entry.audit.createdTs.round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' }))).toBe(true);
        expect(stored?.audit.expiryTs.equals(entry.audit.expiryTs)).toBe(true);
        expect(await repository.entries.writeIfAbsentOrMatch(entry)).toBe('matched');
        expect(await queue.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).toEqual(
            new Map()
        );
        expect(await queue.getItem(entry.key)).toBeUndefined();
        expect(await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`).toEqual(before);
    });

    postgresIt('preserves native SQL-live retry expiry across a later independent release clock', async () => {
        const { sql, entry: original } = await createStorage();
        const current = Temporal.Now.instant().round({ smallestUnit: 'microsecond', roundingMode: 'halfEven' });
        const expiry = current.add({ hours: 1 });
        const completion = current.add({ hours: 2 });
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), () => completion);
        await queue.enqueue({
            ...original,
            audit: { ...original.audit, expiryTs: expiry },
            status: EntityStatus.RESERVED,
            dequeueAudit: { attempts: 2, startTs: current }
        });
        const reserved = (await queue.getItem(original.key))!;
        const [eligibility] = await sql<{ eligible: boolean; }[]>`
            select expire_ts > (now() at time zone 'UTC') as eligible from resource_inbox
            where fk_ext_bank_id = ${original.key.contextId}
        `;
        expect(eligibility?.eligible).toBe(true);

        const released = [...(await queue.releaseEntries([{
            entry: reserved,
            disposition: { status: EntityStatus.RETRY, delayMs: 37, reason: 'not-ready' }
        }])).values()][0]!;

        expect(released.dequeueAudit.endTs?.equals(completion)).toBe(true);
        expect(released.dequeueAudit.nextTs?.equals(expiry)).toBe(true);
        expect(released.dequeueAudit.attempts).toBe(1);
        expect(await queue.getItem(original.key)).toEqual(released);
    });

    postgresIt.each([
        [EntityStatus.RESERVED, '2026-01-01 12:00:00.123455', null],
        [EntityStatus.COMPLETED, '2026-01-01 12:00:00.123456', '2026-01-01 12:00:00.123455']
    ])('preserves native %s clock facts across full read and immutable replay', async (status, start, end) => {
        const { sql, entry: original } = await createStorage();
        const entry = { ...original, audit: { ...original.audit, createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00.123456') } };
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        await repository.entries.writeIfAbsentOrMatch(entry);
        await sql`update resource_inbox set ri_status = ${status}, ri_attempts = 1, start_ts = ${start}, end_ts = ${end}
                  where fk_ext_bank_id = ${entry.key.contextId}`;
        const before = await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;

        const stored = await repository.entries.findAnyByKey(entry.key);
        expect(stored?.status).toBe(status);
        expect(stored?.dequeueAudit.startTs!.equals(Temporal.Instant.from(`${start.replace(' ', 'T')}Z`))).toBe(true);
        expect(stored?.dequeueAudit.endTs?.equals(Temporal.Instant.from(`${end?.replace(' ', 'T')}Z`))).toBe(end === null ? undefined : true);
        expect(await repository.entries.writeIfAbsentOrMatch(entry)).toBe('matched');
        expect(await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`).toEqual(before);
    });

    postgresIt.each([EntityStatus.NEW, EntityStatus.RETRY])('rejects corrupt %s reads and reservation without rewriting the SQL row', async (status) => {
        const { first, second, sql, entry } = await createStorage();
        await first.enqueue(entry);
        await sql`update resource_inbox set ri_status = ${status}, ri_attempts = 1,
                  next_ts = ${status === EntityStatus.RETRY ? '2026-01-02T12:00:00.123456Z' : null}
                  where fk_ext_bank_id = ${entry.key.contextId}`;
        const before = await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;

        await expect(first.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([status]),
            reservationInput: 1
        })).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        await expect(second.getItem(entry.key)).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        expect(await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`).toEqual(before);
    });
});

interface ObservedQueueStorage {
    readonly sql: PostgresSql;
    readonly first: PSqlQueueBox;
    readonly second: PSqlQueueBox;
    readonly entry: ResourceEntry;
}

async function createStorage(): Promise<ObservedQueueStorage> {
    const namespace = crypto.randomUUID();
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await sql`delete from resource_inbox where fk_ext_bank_id = ${namespace}`;
        }
        finally {
            await sql.end();
        }
    });
    const otherSql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(() => otherSql.end());
    const entry: ResourceEntry = {
        key: { topicId: 'observed-work', resourceId: 'selected', contextId: namespace },
        typeId: namespace,
        resource: 'message-work',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        dequeueAudit: { attempts: 0 }
    };
    return {
        sql,
        first: new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant),
        second: new PSqlQueueBox(createPSqlResourceInboxRepository(otherSql, () => new Date()), Temporal.Now.instant),
        entry
    };
}
