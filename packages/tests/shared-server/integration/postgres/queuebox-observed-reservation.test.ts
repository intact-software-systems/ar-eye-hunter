import { Temporal } from '@js-temporal/polyfill';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres observed QueueBox reservation', () => {
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
        const persisted = await createPSqlResourceInboxRepository(sql).entries.findAnyByKey(entry.key);
        expect(persisted).toBeDefined();
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        vi.setSystemTime(expiry.epochMilliseconds + lateMs);
        const rowsBefore = await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`;
        await expect(first.releaseEntries([persisted!], { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' }))
            .rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        expect(await sql`select * from resource_inbox where fk_ext_bank_id = ${entry.key.contextId}`).toEqual(rowsBefore);
    });

    postgresIt('persists readiness without consuming an attempt and preserves the original guarded reservation', async () => {
        const { first, second, entry } = await createStorage();
        await first.enqueue(entry);
        const claimed =
            [...(await first.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.NEW]), reservationInput: 1 })).values()][0];
        const snapshot = JSON.stringify(claimed);
        const waiting = [...(await first.releaseEntries([claimed], { status: EntityStatus.RETRY, delayMs: 60_000, reason: 'not-ready' })).values()][0];
        expect(waiting.dequeueAudit.attempts).toBe(0);
        expect(waiting.dequeueAudit.nextTs!.epochMilliseconds - waiting.dequeueAudit.endTs!.epochMilliseconds).toBe(60_000);
        expect(waiting.audit).toEqual(claimed.audit);
        expect(waiting.resource).toBe(claimed.resource);
        expect(JSON.stringify(claimed)).toBe(snapshot);
        expect(await second.getItem(entry.key)).toEqual(waiting);
        expect(await second.reserveEntries({ typeIds: new Set([entry.typeId]), statusIds: new Set([EntityStatus.RETRY]), reservationInput: 1 })).toEqual(
            new Map()
        );
        await expect(first.releaseEntries([claimed], { status: EntityStatus.RETRY, delayMs: 1, reason: 'not-ready' })).rejects.toMatchObject({
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
        await first.releaseEntries(claimed, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
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

    postgresIt('keeps observations distinct when different key parts contain the same delimiter', async () => {
        const { first, second, entry } = await createStorage();
        const left = { ...entry, key: { ...entry.key, topicId: 'a/b', resourceId: 'c' } };
        const right = { ...entry, key: { ...entry.key, topicId: 'a', resourceId: 'b/c' } };
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
});

async function createStorage() {
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
        first: new PSqlQueueBox(createPSqlResourceInboxRepository(sql)),
        second: new PSqlQueueBox(createPSqlResourceInboxRepository(otherSql)),
        entry
    };
}
