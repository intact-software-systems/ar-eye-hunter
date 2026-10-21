import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxRowCorruptionError } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';

import { createResourceInboxQueryCapture } from '../../shared/p-sql-resource-inbox-test-harness.ts';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from './resource-inbox-test-storage.ts';

const key: Key = { topicId: 'AppInbox', resourceId: 'request-1', contextId: 'context-1' };

let storage: ResourceInboxTestStorage;
let sql: PSqlSql;
let repository: PSqlResourceInboxEntryRepository;

beforeAll(async () => {
    storage = await createResourceInboxTestStorage('poll_projection');
    sql = storage.sql;
    repository = new PSqlResourceInboxEntryRepository(sql, () => new Date());
});
afterAll(async () => await storage?.close());
beforeEach(async () => await sql`delete from resource_inbox`);

describe('resource inbox poll projection', () => {
    it('selects unexpired entries using the injected reader clock and excludes equality', async () => {
        await writeRow(key, 'NEW', 0n);
        const expiry = new Date('2060-01-01T12:00:00.000Z');
        await sql`update resource_inbox set expire_ts = ${expiry}`;
        let now = new Date(expiry.valueOf() - 1);
        const entries = new PSqlResourceInboxEntryRepository(sql, () => now);
        expect(await entries.findByKey(key)).toMatchObject({ key });
        expect(await entries.findAllByTopicAndResourceId(key.topicId, key.resourceId)).toMatchObject([{ key }]);
        expect(await entries.findAllKeys()).toEqual([key]);
        expect([...(await entries.findByTopicId(key.topicId)).values()]).toMatchObject([{ key }]);
        expect([...(await entries.findByTypeId('APP_INBOX')).values()]).toMatchObject([{ key }]);
        expect(await entries.isAnyWithStatuses(new Set([EntityStatus.NEW]))).toBe(true);
        expect(await entries.readStatusAndAttempts(key)).toEqual({ status: 'NEW', attempts: 0 });
        now = expiry;
        expect(await entries.findByKey(key)).toBeNull();
        expect(await entries.findAllByTopicAndResourceId(key.topicId, key.resourceId)).toEqual([]);
        expect(await entries.findAllKeys()).toEqual([]);
        expect(await entries.findByTopicId(key.topicId)).toEqual(new Map());
        expect(await entries.findByTypeId('APP_INBOX')).toEqual(new Map());
        expect(await entries.isAnyWithStatuses(new Set([EntityStatus.NEW]))).toBe(false);
        expect(await entries.readStatusAndAttempts(key)).toBeUndefined();
        expect(await entries.findAnyByKey(key)).toMatchObject({ key });
    });

    it('preserves the injected expiry clock through aggregate transactions', async () => {
        await writeRow(key, 'COMPLETED', 1n);
        await sql`update resource_inbox set expire_ts = ${new Date('2060-01-01T12:00:00.000Z')}`;
        const resources = createPSqlResourceInboxRepository(sql, () => new Date('2060-01-01T12:00:00.000Z'));
        expect(await resources.entries.readStatusAndAttempts(key)).toBeUndefined();
        expect(await resources.transaction(async (transaction) => await transaction.entries.readStatusAndAttempts(key))).toBeUndefined();
    });

    it('answers the distinct status reads of one turn with one statement returning only ordinal, status and attempts', async () => {
        const capture = createResourceInboxQueryCapture();
        const entries = new PSqlResourceInboxEntryRepository(capture.sql, () => new Date());
        const other = { ...key, resourceId: 'request-2' };
        expect(await Promise.all([entries.readStatusAndAttempts(key), entries.readStatusAndAttempts(key), entries.readStatusAndAttempts(other)]))
            .toEqual([undefined, undefined, undefined]);
        expect(capture.queries).toEqual([{
            query: 'select requested.key_ordinal::int as key_ordinal, resource_inbox.ri_status, resource_inbox.ri_attempts ' +
                'from unnest( ::text[], ::text[], ::text[] ) ' +
                'with ordinality as requested (context_id, resource_id, topic_id, key_ordinal) ' +
                'join resource_inbox on resource_inbox.fk_ext_bank_id = requested.context_id ' +
                'and resource_inbox.ri_resource_id = requested.resource_id ' +
                'and resource_inbox.ri_topic_id = requested.topic_id ' +
                'where resource_inbox.expire_ts >',
            values: [['context-1', 'context-1'], ['request-1', 'request-2'], ['AppInbox', 'AppInbox'], expect.any(Date)]
        }]);
    });

    it('isolates every key slot and ignores expired exact-key rows', async () => {
        await writeRow({ ...key, topicId: 'other-topic' }, 'COMPLETED', 4n);
        await writeRow({ ...key, resourceId: 'other-request' }, 'FAILED', 5n);
        await writeRow({ ...key, contextId: 'other-context' }, 'NON_RETRYABLE', 6n);
        expect(await repository.readStatusAndAttempts(key)).toBeUndefined();
        await writeRow(key, 'NEW', 0n);
        expect(await repository.readStatusAndAttempts(key)).toEqual({ status: 'NEW', attempts: 0 });
        await sql`update resource_inbox set expire_ts = (now() at time zone 'UTC') - interval '1 second'
                  where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}`;
        expect(await repository.readStatusAndAttempts(key)).toBeUndefined();
    });

    it.each(['NEW', 'RESERVED', 'RETRY', 'COMPLETED', 'FAILED', 'NON_RETRYABLE', 'ABORTED', 'PARTITIONED', 'MERGED'] as const)(
        'projects canonical %s and its valid attempts without decoding resource bytes',
        async (status) => {
            await writeRow(key, status, 17n);
            expect(await repository.readStatusAndAttempts(key)).toEqual({ status, attempts: 17 });
        }
    );

    it.each(
        [
            ['unknown status', 'UNKNOWN', 1n],
            ['missing attempts', 'COMPLETED', null],
            ['negative attempts', 'COMPLETED', -1n],
            ['unsafe attempts', 'COMPLETED', 9007199254740992n]
        ] as const
    )('fails closed for %s', async (_label, status, attempts) => {
        await writeRow(key, status, attempts);
        await expect(repository.readStatusAndAttempts(key)).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        const events: RallarTimingEvent[] = [];
        const waiter = new AppInboxResultWaiter({
            statusRepository: repository,
            resultRepository: { findByKey: async () => undefined }
        }, {
            serviceId: 'server-1',
            timing: (event) => events.push(event),
            options: normalizeAppInboxOptions({ phaseTiming: true, waitMaxElapsedMsecs: 0 })
        });
        const result = await waiter.waitForReservedResult(
            { enqueue: { type: AppInboxType.GROUP_CREATE, ...key, data: null }, key: key, winner: false },
            (value) => value
        );
        expect(result.left).toMatchObject({ code: 'app-inbox-unavailable', status: 503 });
        expect(events.filter((event) => event.operation === 'wait-poll')).toEqual([
            expect.objectContaining({
                status: 'error',
                details: { type: 'GROUP_CREATE', ...key, queueObservation: 'read-failure', trigger: 'first', readRow: 'status' }
            })
        ]);
    });
});

async function writeRow(key: Key, status: string, attempts: bigint | null): Promise<void> {
    await sql`insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
             fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts)
             values (${key.resourceId}, ${key.topicId}, 'invalid-resource-json', 'APP_INBOX', ${status},
             ${key.contextId}, '2026-10-10', 'server-1', (now() at time zone 'UTC'),
             (now() at time zone 'UTC') + interval '1 day', ${attempts})`;
}
