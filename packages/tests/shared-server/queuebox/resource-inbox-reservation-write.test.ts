import { expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { writeResourceInboxReservationFinish } from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

it('refuses to finish a reservation after database time advances past its expiry', async () => {
    const completedAt = new Date('2026-09-04T10:00:00.000Z');
    const reservationExpiresAt = new Date('2026-09-04T10:00:05.000Z');
    const databaseNow = new Date('2026-09-04T10:00:10.000Z');
    const statements: Array<Readonly<{ strings: readonly string[]; values: readonly PSqlParameter[]; }>> = [];
    const transaction = createReservationFinishTransaction(
        databaseNow,
        reservationExpiresAt,
        statements
    );

    const finished = await writeResourceInboxReservationFinish(transaction, {
        key: {
            topicId: 'topic-1',
            resourceId: 'resource-1',
            contextId: 'context-1'
        },
        expectedAttempts: 3,
        status: EntityStatus.COMPLETED,
        completedAt
    });

    expect(finished).toBe(false);
    expect(statements).toHaveLength(1);
    const statement = statements[0];
    if (statement === undefined) {
        throw new Error('Expected the reservation finish SQL statement');
    }
    const endTsParameterIndex = statement.strings.findIndex((text) => text.includes('end_ts ='));
    expect(endTsParameterIndex).toBeGreaterThanOrEqual(0);
    expect(statement.values[endTsParameterIndex]).toBe(completedAt);
    expect(statement.values.filter((value) => value === completedAt)).toHaveLength(1);
});

function createReservationFinishTransaction(
    databaseNow: Date,
    reservationExpiresAt: Date,
    statements: Array<Readonly<{ strings: readonly string[]; values: readonly PSqlParameter[]; }>>
): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.prototype.hasOwnProperty.call(stringsOrValues, 'raw')) {
            return {};
        }
        const strings = stringsOrValues as TemplateStringsArray;
        statements.push({ strings: Array.from(strings), values });
        const expiryGuardSegment = strings.find((text) => text.includes('expire_ts >'));
        const expiryGuardParameterIndex = strings.indexOf(expiryGuardSegment ?? '');
        const comparedAt = expiryGuardSegment?.includes('now() at time zone \'UTC\'')
            ? databaseNow
            : values[expiryGuardParameterIndex];
        if (!(comparedAt instanceof Date)) {
            throw new Error('Expected the reservation expiry comparison time');
        }
        const rows = reservationExpiresAt.getTime() > comparedAt.getTime()
            ? [{ ri_row_id: 1n }]
            : [];
        return Promise.resolve(rows) as Promise<Result>;
    }
    return Object.assign(sql, {
        begin: async <T>(_write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            throw new Error('Reservation finish test SQL does not open transactions');
        }
    });
}
