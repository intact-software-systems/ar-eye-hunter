import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    EntityStatus,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from '../al-runtime/postgres/create-p-sql-admission-test-storage.ts';

describe('ResourceInbox persistence values before transaction entry', () => {
    it('persists the computed enqueue status when its caller changes status during SQL awaits', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const entry = createEntry();
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
        const pending = queue.enqueue(entry);
        entry.status = EntityStatus.FAILED;

        expect(await pending).toBeUndefined();
        const stored = await queue.getItem(entry.key);
        expect(stored?.status).toBe(EntityStatus.NEW);
        expect(stored?.dequeueAudit).toEqual({ attempts: 0, startTs: undefined, endTs: undefined, nextTs: undefined });
        const [row] = await sql<ResourceInboxRow[]>`
            select * from resource_inbox
        `;
        expect(row).toMatchObject({ ri_status: EntityStatus.NEW, start_ts: null, end_ts: null, next_ts: null });
        expect(Number(row?.ri_attempts)).toBe(0);
        expect(entry.status).toBe(EntityStatus.FAILED);
    });

    it.each(['replace', 'insert-if-absent'] as const)('prepares supplied %s timestamps before opening SQL', async (operation) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const entry = createEntry();
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
        const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);

        const previous = operation === 'replace' ? await queue.enqueue(entry) : await queue.enqueueIfAbsent(entry);

        if (operation === 'replace') {
            expect(previous).toBeUndefined();
        }
        else {
            expect(previous).toMatchObject({ key: entry.key, resource: entry.resource });
        }
        expect(await queue.getItem(entry.key)).toMatchObject({ key: entry.key, resource: entry.resource, status: EntityStatus.NEW });
        const candidate = { ...entry, resource: 'next-payload' };
        const returned = operation === 'replace' ? await queue.enqueue(candidate) : await queue.enqueueIfAbsent(candidate);
        expect(returned?.resource).toBe(entry.resource);
        expect((await queue.getItem(entry.key))?.resource).toBe(operation === 'replace' ? candidate.resource : entry.resource);
    });

    it('prepares a supplied placeholder before opening winner materialization SQL', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const placeholder = createEntry();
        const serialize = placeholder.audit.expiryTs.toString.bind(placeholder.audit.expiryTs);
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
        vi.spyOn(placeholder.audit.expiryTs, 'toString').mockImplementation(() => {
            expect(transactionOpen).toBe(false);
            return serialize();
        });
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const materialize = vi.fn(async () => {
            expect(transactionOpen).toBe(true);
            return { ...placeholder, resource: 'winner-payload' };
        });

        const winner = await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(placeholder, materialize);
        const replay = await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(placeholder, async () => {
            throw new Error('Replay cannot create another winner payload');
        });

        expect(materialize).toHaveBeenCalledTimes(1);
        expect(winner.resource).toBe('winner-payload');
        expect(replay).toEqual(winner);
    });
    it.each(['callback-failure', 'identity-change'] as const)('rolls back a winning %s before another materialization can succeed', async (failure) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const placeholder = createEntry();
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const materialization = repository.entries.writeMaterializedIfAbsentOrReplaceExpired(placeholder, async () => {
            if (failure === 'callback-failure') {
                throw new Error('Rejected winner payload');
            }
            return { ...placeholder, key: { ...placeholder.key, resourceId: 'wrong-identity' } };
        });
        await expect(materialization).rejects.toThrow();
        expect(await repository.entries.findAnyByKey(placeholder.key)).toBeNull();

        const recovered = await repository.entries.writeMaterializedIfAbsentOrReplaceExpired(placeholder, async () => ({
            ...placeholder,
            resource: 'recovered-payload'
        }));

        expect(recovered.resource).toBe('recovered-payload');
        expect(await repository.entries.findAnyByKey(placeholder.key)).toEqual(recovered);
    });
});

function createEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-01-01T00:00:00.123456');
    return {
        key: { contextId: 'precomputed-enqueue', topicId: 'operation', resourceId: 'candidate' },
        typeId: 'operation',
        resource: 'supplied-payload',
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'sender',
            createdTs,
            expiryTs: Temporal.Instant.from('9999-01-01T00:00:00.123456Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}
