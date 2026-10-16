import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxReservationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

interface ClaimedRowFixture {
    readonly rowId: bigint;
    readonly resourceId: string;
    /** A due RETRY row's selected due time, in either text form a driver returns; `null` is a NEW row. */
    readonly selectedNextTs: string | null;
}

describe('PSqlResourceInboxReservationRepository claim order', () => {
    it('orders claimed rows by their selected due instant with unscheduled rows first, then by row identity', async () => {
        // The later due time is space-separated, the earlier one T-separated: as text the later one sorts first.
        const rows = [
            createClaimedRow({ rowId: 2n, resourceId: 'due-later', selectedNextTs: '2026-10-17 00:00:01.000000' }),
            createClaimedRow({ rowId: 3n, resourceId: 'due-earlier', selectedNextTs: '2026-10-17T00:00:00.000000' }),
            createClaimedRow({ rowId: 10n, resourceId: 'unscheduled-ten', selectedNextTs: null }),
            createClaimedRow({ rowId: 9n, resourceId: 'unscheduled-nine', selectedNextTs: null })
        ];
        const repository = new PSqlResourceInboxReservationRepository(createClaimingSql(rows), () => new Date());

        const claimed = await repository.reserveEntriesSkipLocked({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.NEW, EntityStatus.RETRY]),
            reservationInput: 4,
            contextClaim: undefined
        });

        expect([...claimed.values()].map((entry) => entry.key.resourceId))
            .toEqual(['unscheduled-nine', 'unscheduled-ten', 'due-earlier', 'due-later']);
    });
});

function createClaimedRow(fixture: ClaimedRowFixture): Record<string, PSqlParameter> {
    return {
        ri_row_id: fixture.rowId,
        ri_resource_id: fixture.resourceId,
        ri_topic_id: 'app-inbox.test',
        ri_resource: '{}',
        ri_type_id: 'APP_INBOX',
        ri_status: EntityStatus.RESERVED,
        fk_ext_bank_id: 'context-1',
        system_date: '2026-10-13',
        created_by: 'server-1',
        created_ts: '2026-10-13 12:00:00.000000',
        expire_ts: '2027-10-13 12:00:00.000000',
        start_ts: '2026-10-13 12:00:05.000000',
        end_ts: null,
        next_ts: null,
        ri_attempts: fixture.selectedNextTs === null ? 1n : 2n,
        selected_status: fixture.selectedNextTs === null ? EntityStatus.NEW : EntityStatus.RETRY,
        selected_attempts: fixture.selectedNextTs === null ? 0n : 1n,
        selected_start_ts: fixture.selectedNextTs === null ? null : '2026-10-13 12:00:01.000000',
        selected_end_ts: fixture.selectedNextTs === null ? null : '2026-10-13 12:00:02.000000',
        selected_next_ts: fixture.selectedNextTs
    };
}

/** Answers the one claim statement with the rows in the order `RETURNING` happened to produce them. */
function createClaimingSql(rows: readonly Record<string, PSqlParameter>[]): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.prototype.hasOwnProperty.call(stringsOrValues, 'raw')) {
            return {};
        }
        return Promise.resolve(rows as Result);
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('The claim statement runs on the transaction handle it is given');
        }
    });
}
