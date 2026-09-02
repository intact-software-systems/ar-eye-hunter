import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import type { StartProcessingEntitySkipped } from './p-sql-resource-inbox-reservation-repository.ts';
import { writeResourceInboxReservationFinish } from './resource-inbox-reservation-write.ts';
import { rowsToMap, toDomain, type ResourceInboxRow } from './resource-inbox-row-codec.ts';

export class PSqlResourceInboxFinalizationRepository {
    private readonly sql: PSqlSql;

    constructor(sql: PSqlSql) {
        this.sql = sql;
    }

    async findRetryExhaustionFinalizationsSkipLocked(
        typeIds: ReadonlySet<string>,
        staleAfterMs: number,
        options: Readonly<{ processingAttempts: number; maxToReserve: number; }>
    ): Promise<Map<string, ResourceEntry>> {
        if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
            throw new Error('Finalization stale duration must be a non-negative safe integer');
        }
        if (!Number.isSafeInteger(options.processingAttempts) || options.processingAttempts < 1) {
            throw new Error('Finalization processing attempts must be a positive safe integer');
        }
        if (!Number.isSafeInteger(options.maxToReserve) || options.maxToReserve < 0) {
            throw new Error('Finalization reservation limit must be a non-negative safe integer');
        }
        if (!typeIds.has(EnqueuedType.APP_INBOX) || options.maxToReserve === 0) {
            return new Map();
        }

        const rows = await this.sql<ResourceInboxRow[]>`
            select *
            from resource_inbox
            where ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts >= ${options.processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
              and start_ts is not null
              and start_ts <= (now() - (${staleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
            order by start_ts asc, ri_row_id asc
                for update skip locked
            limit ${options.maxToReserve}
        `;
        return rowsToMap(rows);
    }

    async isRetryExhaustionFinalizationRequired(
        typeIds: ReadonlySet<string>,
        staleAfterMs: number,
        processingAttempts: number
    ): Promise<boolean> {
        if (!typeIds.has(EnqueuedType.APP_INBOX)) {
            return false;
        }
        const rows = await this.sql<{ one: number; }[]>`
            select 1 as one
            from resource_inbox
            where ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts >= ${processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
              and start_ts is not null
              and start_ts <= (now() - (${staleAfterMs} * interval '1 millisecond')) at time zone 'UTC'
            limit 1
        `;
        return rows.length > 0;
    }

    async startFinalizationRecovery(
        entry: ResourceEntry,
        processingAttempts: number
    ): Promise<Either<StartProcessingEntitySkipped, ResourceEntry>> {
        if (entry.dequeueAudit.attempts >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Resource inbox finalization reservation generation overflow');
        }
        const rows = await this.sql<ResourceInboxRow[]>`
            update resource_inbox
            set ri_attempts = ri_attempts + 1,
                start_ts = now() at time zone 'UTC',
                end_ts = null,
                next_ts = null
            where ri_topic_id = ${entry.key.topicId}
              and ri_resource_id = ${entry.key.resourceId}
              and fk_ext_bank_id = ${entry.key.contextId}
              and ri_type_id = ${EnqueuedType.APP_INBOX}
              and ri_status = ${EntityStatus.RESERVED}
              and expire_ts > (now() at time zone 'UTC')
              and ri_attempts = ${entry.dequeueAudit.attempts}
              and ri_attempts >= ${processingAttempts}
              and ri_attempts < ${Number.MAX_SAFE_INTEGER}
            returning *
        `;
        return rows.length === 0
            ? Either.ofLeft({ kind: 'expired-or-missing', key: entry.key })
            : Either.ofRight(toDomain(rows[0]));
    }

    async finishReserved(
        key: Key,
        expectedAttempts: number,
        status: typeof EntityStatus.COMPLETED | typeof EntityStatus.FAILED,
        completedAt: Date
    ): Promise<boolean> {
        if (status !== EntityStatus.COMPLETED && status !== EntityStatus.FAILED) {
            throw new Error(
                'Resource inbox reservation finish status must be COMPLETED or FAILED'
            );
        }

        return await writeResourceInboxReservationFinish(this.sql, {
            key,
            expectedAttempts,
            status,
            completedAt
        });
    }
}
