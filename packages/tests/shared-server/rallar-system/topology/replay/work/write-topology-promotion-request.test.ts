import { Temporal } from '@js-temporal/polyfill';
import type {
    PSqlParameter,
    PSqlSql
} from '@shared-server/postgres/p-sql-sql.ts';
import {
    ResourceInboxInvariantCorruptionError
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { writeTopologyPromotionRequest } from '@shared-server/rallar-system/topology/replay/work/write-topology-promotion-request.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

describe('topology promotion request write', () => {
    it('rejects an immutable ResourceInbox collision', async () => {
        const entry = promotionEntry();

        await expect(
            writeTopologyPromotionRequest(createConflictingTransaction(), entry)
        ).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
    });
});

function promotionEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-01-02T03:04:05');
    return {
        key: {
            topicId: 'topology-promotion',
            resourceId: 'promotion-1',
            contextId: 'group-1'
        },
        resource: '{"promotion":1}',
        typeId: 'APP_OUTBOX',
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'topology-service',
            createdTs,
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}

function createConflictingTransaction(): PSqlSql {
    function sql<Result>(
        _strings: TemplateStringsArray,
        ..._values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(_values: readonly PSqlParameter[]): object;
    function sql(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): Promise<readonly object[]> | object {
        return Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')
            ? {}
            : Promise.resolve([]);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Topology promotion write must not open a transaction');
        }
    });
}
