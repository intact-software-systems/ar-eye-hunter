import { Temporal } from '@js-temporal/polyfill';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityStatus, type Key, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';

type ResourceInboxRepositoryModule =
    typeof import('@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts');

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
        '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts'
        );
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ResourceInboxRepository', () => {
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
            createdBy: 'alice',
        });
        const activeReplacement = createEntry(activeKey, {
            text: 'active-replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 10 }),
            createdBy: 'bob',
        });

        await repo.write(activeOriginal);
        await expect(repo.write(activeReplacement)).rejects.toMatchObject({
            code: '23505',
        });

        const returnedExisting = await repo.writeIfAbsentOrReplaceExpired(activeReplacement);

        expect(JSON.parse(returnedExisting.resource)).toEqual({ text: 'active-original' });
        expect(returnedExisting.audit.createdBy).toBe('alice');
        expect(JSON.parse(findStoredRow(harness.rows, activeKey)?.ri_resource ?? '{}')).toEqual({
            text: 'active-original',
        });

        const expiredOriginal = createEntry(expiredKey, {
            text: 'expired-original',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
            createdBy: 'carol',
        });
        const expiredReplacement = createEntry(expiredKey, {
            text: 'expired-replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 1 }),
            createdBy: 'dave',
        });

        await repo.write(expiredOriginal);
        await expect(repo.write(expiredReplacement)).rejects.toMatchObject({
            code: '23505',
        });

        const replaced = await repo.writeIfAbsentOrReplaceExpired(expiredReplacement);

        expect(JSON.parse(replaced.resource)).toEqual({ text: 'expired-replacement' });
        expect(replaced.audit.createdBy).toBe('dave');
        expect(findStoredRow(harness.rows, expiredKey)?.expire_ts).toBe(
            expiredReplacement.audit.expiryTs.toString(),
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
            createdBy: 'alice',
        });
        const replacement = createEntry(key, {
            text: 'replacement',
            expiryTs: Temporal.Now.instant().add({ minutes: 10 }),
            createdBy: 'bob',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:01:00'),
        });

        const storedOriginal = await repo.write(original);
        const replaced = await repo.replace(replacement);

        expect(replaced.db?.id).toBe(storedOriginal.db?.id);
        expect(JSON.parse(replaced.resource)).toEqual({ text: 'replacement' });
        expect(replaced.audit.createdBy).toBe('bob');
        expect(findStoredRow(harness.rows, key)?.created_ts).toBe(
            replacement.audit.createdTs.toString(),
        );
        expect(findStoredRow(harness.rows, key)?.expire_ts).toBe(
            replacement.audit.expiryTs.toString(),
        );
    });

    it('filters expired rows from reads and startProcessingEntity', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const harness = createSqlHarness();
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);
        const active = createEntry(createKey('active-1'), {
            text: 'active',
            expiryTs: Temporal.Now.instant().add({ minutes: 5 }),
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });

        await repo.write(active);
        await repo.write(expired);

        expect(await repo.findByKey(active.key)).not.toBeNull();
        expect(await repo.findByKey(expired.key)).toBeNull();
        expect((await repo.startProcessingEntity(expired)).left).toEqual({
            kind: 'expired-or-missing',
            key: expired.key,
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
            expiryTs: Temporal.Instant.from('2026-01-01T00:05:00Z'),
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
                expiryTs: Temporal.Instant.from('2026-01-01T00:10:00Z'),
            },
            dequeueAudit: {
                attempts: 4,
                nextTs: Temporal.Instant.from('2026-01-01T00:02:00Z'),
            },
        });

        expect(updated.audit.createdBy).toBe(storedOriginal.audit.createdBy);
        expect(updated.audit.createdTs.toString()).toBe(
            storedOriginal.audit.createdTs.toString(),
        );
        expect(updated.audit.expiryTs.toString()).toBe(
            storedOriginal.audit.expiryTs.toString(),
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
            expiryTs: Temporal.Now.instant().add({ minutes: 5 }),
        });
        const expired = createEntry(createKey('expired-1'), {
            text: 'expired',
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });

        await repo.write(active);
        await repo.write(expired);

        expect(await repo.deleteExpired()).toBe(1);
        expect(await repo.findByKey(active.key)).not.toBeNull();
        expect(await repo.findByKey(expired.key)).toBeNull();
    });
});

function createSqlHarness() {
    const rows = new Map<string, ResourceInboxRow>();
    let nextRowId = 1n;

    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ) => {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }

        const query = normalizeQuery(stringsOrValues);

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
            query.includes('where resource_inbox.expire_ts <= now()')
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
                    ri_row_id: existing.ri_row_id,
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
            !query.includes('where resource_inbox.expire_ts <= now()')
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
                ri_row_id: existing.ri_row_id,
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('insert into resource_inbox') &&
            query.includes('on conflict (fk_ext_bank_id, ri_resource_id, ri_topic_id)') &&
            !query.includes('where resource_inbox.expire_ts <= now()')
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
                ri_attempts: incoming.ri_attempts,
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('select * from resource_inbox') &&
            query.includes('where ri_topic_id =') &&
            query.includes('ri_resource_id =') &&
            query.includes('fk_ext_bank_id =')
        ) {
            const [topicId, resourceId, contextId, expireAfter] = values;
            const row = rows.get(`${contextId}::${topicId}::${resourceId}`);
            if (!row) {
                return [];
            }

            if (expireAfter instanceof Date && Date.parse(row.expire_ts) <= expireAfter.getTime()) {
                return [];
            }

            return [cloneRow(row)];
        }

        if (
            query.includes('update resource_inbox') &&
            query.includes('set ri_status =') &&
            query.includes('ri_attempts =') &&
            query.includes('expire_ts > now()')
        ) {
            const [status, attempts, startTs, endTs, nextTs, topicId, resourceId, contextId] = values;
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
                next_ts: toOptionalString(nextTs),
            };
            rows.set(key, updated);
            return [cloneRow(updated)];
        }

        if (
            query.includes('delete from resource_inbox') &&
            query.includes('where expire_ts <= now()')
        ) {
            const deleted: Array<{ ri_row_id: bigint }> = [];

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
        sql: sql as never,
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
        attempts,
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
        created_ts: createdTs as string,
        expire_ts: expireTs as string,
        start_ts: toOptionalString(startTs),
        end_ts: toOptionalString(endTs),
        next_ts: toOptionalString(nextTs),
        ri_attempts: BigInt((attempts as number) ?? 0),
    };
}

function toCompositeKey(row: Pick<ResourceInboxRow, 'fk_ext_bank_id' | 'ri_topic_id' | 'ri_resource_id'>): string {
    return `${row.fk_ext_bank_id}::${row.ri_topic_id}::${row.ri_resource_id}`;
}

function cloneRow(row: ResourceInboxRow): ResourceInboxRow {
    return {
        ...row,
    };
}

function duplicateKeyError(key: string): Error & { code: string } {
    const error = new Error(
        `duplicate key value violates unique constraint resource_inbox_unique_k: ${key}`,
    ) as Error & { code: string };
    error.code = '23505';
    return error;
}

function createKey(resourceId: string): Key {
    return {
        topicId: 'chat.message.v1',
        resourceId,
        contextId: 'room-1',
    };
}

function createEntry(
    key: Key,
    options: Readonly<{
        text: string;
        createdBy?: string;
        createdTs?: Temporal.PlainDateTime;
        expiryTs: Temporal.Instant;
    }>,
): ResourceEntry {
    return {
        key,
        resource: JSON.stringify({ text: options.text }),
        typeId: 'ws.outbox',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: options.createdBy ?? 'test-user',
            createdTs:
                options.createdTs ?? Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: options.expiryTs,
        },
        status: EntityStatus.NEW,
        dequeueAudit: {
            attempts: 0,
        },
    };
}

function findStoredRow(
    rows: ReadonlyMap<string, ResourceInboxRow>,
    key: Key,
): ResourceInboxRow | undefined {
    return rows.get(`${key.contextId}::${key.topicId}::${key.resourceId}`);
}

function isExpired(expireTs: string): boolean {
    return Date.parse(expireTs) <= Date.now();
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
