import { Temporal } from '@js-temporal/polyfill';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres observed QueueBox reservation', () => {
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
            first.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1, observations),
            second.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1, observations)
        ]);

        const claimed = claims.flatMap((claim) => [...claim.values()]);
        expect(claimed).toMatchObject([{ key: entry.key, status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } }]);
        expect(await second.getItem(stale.key)).toMatchObject({ resource: 'replacement', dequeueAudit: { attempts: 0 } });
        expect(await second.getItem(waiting.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        await first.releaseEntries(claimed, { status: EntityStatus.NON_RETRYABLE, delayMs: null });
        expect(await second.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 3, observations)).toEqual(new Map());
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
        await second.reserveTimeoutEntries(new Set([entry.typeId]), 1, duration, [observations[0]]);

        const reclaimed = await first.reserveTimeoutEntries(new Set([entry.typeId]), 1, duration, observations);

        expect([...reclaimed.values()]).toMatchObject([{ key: eligible.key, dequeueAudit: { attempts: 2 } }]);
        expect(await first.getItem(entry.key)).toMatchObject({ dequeueAudit: { attempts: 2 } });
        expect(await first.reserveTimeoutEntries(new Set([entry.typeId]), 3, duration, [])).toEqual(new Map());
    });

    postgresIt('does not claim an identical new row through an observation of a deleted row', async () => {
        const { first, second, entry } = await createStorage();
        await first.enqueue(entry);
        const observed = (await first.getItem(entry.key))!;
        await second.removeItem(entry.key);
        await second.enqueue(entry);

        expect(await first.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1, [observed])).toEqual(new Map());
        expect(await second.getItem(entry.key)).toMatchObject({ resource: entry.resource, dequeueAudit: { attempts: 0 } });
    });

    postgresIt('keeps observations distinct when different key parts contain the same delimiter', async () => {
        const { first, second, entry } = await createStorage();
        const left = { ...entry, key: { ...entry.key, topicId: 'a/b', resourceId: 'c' } };
        const right = { ...entry, key: { ...entry.key, topicId: 'a', resourceId: 'b/c' } };
        await first.enqueue(left);
        await first.enqueue(right);
        const observations = [(await second.getItem(left.key))!, (await second.getItem(right.key))!];

        const claimed = await first.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 2, observations);

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
        first: new PSqlQueueBox(createPSqlResourceInboxRepository(sql)),
        second: new PSqlQueueBox(createPSqlResourceInboxRepository(otherSql)),
        entry
    };
}
