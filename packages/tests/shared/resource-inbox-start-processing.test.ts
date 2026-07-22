import { beforeAll, describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { EntityStatus, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';

(globalThis as { Temporal?: typeof Temporal }).Temporal ??= Temporal;

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

describe('ResourceInboxRepository.startProcessingEntity', () => {
    it('returns Either left for expired rows and Either right for reserved rows', async () => {
        const active = createEntry('active-1', Temporal.Now.instant().add({ minutes: 5 }));
        const expired = createEntry(
            'expired-1',
            Temporal.Now.instant().subtract({ seconds: 1 }),
        );
        const harness = createSqlHarness([toRow(active, 1n), toRow(expired, 2n)]);
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);

        const skipped = await repo.startProcessingEntity(expired);
        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: expired.key,
        });

        const reserved = await repo.startProcessingEntity(active);
        expect(reserved.right?.status).toBe(EntityStatus.RESERVED);
        expect(reserved.right?.dequeueAudit.attempts).toBe(1);
        expect(reserved.right?.dequeueAudit.startTs).toBeDefined();
    });

    it('does not reserve an entry whose processing-attempt budget is exhausted', async () => {
        const exhausted = {
            ...createEntry('exhausted-20', Temporal.Now.instant().add({ minutes: 5 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Now.instant().subtract({ minutes: 1 }),
                endTs: Temporal.Now.instant().subtract({ seconds: 31 }),
                nextTs: Temporal.Now.instant().subtract({ seconds: 30 }),
            },
        } satisfies ResourceEntry;
        const harness = createSqlHarness([toRow(exhausted, 1n)]);
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);

        const skipped = await repo.startProcessingEntity(exhausted);

        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: exhausted.key,
        });
    });

    it('does not create attempt three with a configured two-attempt budget', async () => {
        const exhausted = {
            ...createEntry('exhausted-2', Temporal.Now.instant().add({ minutes: 5 })),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                attempts: 2,
                startTs: Temporal.Now.instant().subtract({ minutes: 1 }),
                endTs: Temporal.Now.instant().subtract({ seconds: 31 }),
                nextTs: Temporal.Now.instant().subtract({ seconds: 30 }),
            },
        } satisfies ResourceEntry;
        const harness = createSqlHarness([toRow(exhausted, 1n)]);
        const repo = new repositoryModule.ResourceInboxRepository(harness.sql);

        const skipped = await repo.startProcessingEntity(exhausted, 2);

        expect(skipped.left).toEqual({
            kind: 'expired-or-missing',
            key: exhausted.key,
        });
    });
});

function createSqlHarness(seedRows: ResourceInboxRow[]) {
    const rows = new Map(
        seedRows.map((row) => [toCompositeKey(row), row] as const),
    );

    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ) => {
        if (!isTemplateCall(stringsOrValues)) {
            return stringsOrValues;
        }

        const query = normalizeQuery(stringsOrValues);
        if (
            query.includes('update resource_inbox') &&
            query.includes('set ri_status =') &&
            query.includes('ri_attempts =') &&
            query.includes('expire_ts > now()')
        ) {
            const [status, attempts, startTs, endTs, nextTs, topicId, resourceId, contextId, maxAttempts] =
                values;
            const key = `${contextId}::${topicId}::${resourceId}`;
            const row = rows.get(key);

            if (
                !row ||
                Date.parse(row.expire_ts) <= Date.now() ||
                (maxAttempts !== undefined && Number(row.ri_attempts) >= Number(maxAttempts))
            ) {
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

        throw new Error(`Unhandled SQL in test harness: ${query}`);
    }) as {
        (
            stringsOrValues: TemplateStringsArray | readonly unknown[],
            ...values: unknown[]
        ): unknown;
    };

    return {
        sql: sql as never,
    };
}

function createEntry(resourceId: string, expiryTs: Temporal.Instant): ResourceEntry {
    return {
        key: {
            topicId: 'topic-1',
            resourceId,
            contextId: 'ctx-1',
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'type-1',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.Now.plainDateTimeISO().toPlainTime(),
            createdBy: 'tester',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs,
        },
        dequeueAudit: {
            attempts: 0,
        },
    };
}

function toRow(entry: ResourceEntry, rowId: bigint): ResourceInboxRow {
    return {
        ri_row_id: rowId,
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        ri_resource: entry.resource,
        ri_type_id: entry.typeId,
        ri_status: entry.status,
        fk_ext_bank_id: entry.key.contextId,
        system_date: entry.audit.createdTs.toPlainDate().toString(),
        created_by: entry.audit.createdBy,
        created_ts: entry.audit.createdTs.toString(),
        expire_ts: entry.audit.expiryTs.toString(),
        start_ts: null,
        end_ts: null,
        next_ts: null,
        ri_attempts: BigInt(entry.dequeueAudit.attempts ?? 0),
    };
}

function toCompositeKey(row: ResourceInboxRow): string {
    return `${row.fk_ext_bank_id}::${row.ri_topic_id}::${row.ri_resource_id}`;
}

function cloneRow(row: ResourceInboxRow): ResourceInboxRow {
    return { ...row };
}

function isTemplateCall(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}

function normalizeQuery(strings: TemplateStringsArray): string {
    return strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function toOptionalString(value: unknown): string | null {
    return value == null ? null : String(value);
}
