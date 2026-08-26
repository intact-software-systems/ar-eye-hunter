import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from './p-sql-resource-inbox-entry-repository.ts';
import { PSqlResourceInboxFinalizationRepository } from './p-sql-resource-inbox-finalization-repository.ts';
import { PSqlResourceInboxReservationRepository } from './p-sql-resource-inbox-reservation-repository.ts';
import { PSqlResourceInboxMaintenance } from './resource-inbox-maintenance.ts';

export interface PSqlResourceInboxRepository {
    readonly entries: PSqlResourceInboxEntryRepository;
    readonly reservations: PSqlResourceInboxReservationRepository;
    readonly finalization: PSqlResourceInboxFinalizationRepository;
    readonly maintenance: PSqlResourceInboxMaintenance;
    transaction<T>(
        work: (repository: PSqlResourceInboxRepository) => Promise<T>
    ): Promise<T>;
}

export function createPSqlResourceInboxRepository(
    sql: PSqlSql
): PSqlResourceInboxRepository {
    return {
        entries: new PSqlResourceInboxEntryRepository(sql),
        reservations: new PSqlResourceInboxReservationRepository(sql),
        finalization: new PSqlResourceInboxFinalizationRepository(sql),
        maintenance: new PSqlResourceInboxMaintenance(sql),
        transaction: async <T>(
            work: (transaction: PSqlResourceInboxRepository) => Promise<T>
        ): Promise<T> =>
            await sql.begin(
                async (transactionSql) =>
                    await work(
                        createPSqlResourceInboxRepository(transactionSql)
                    )
            )
    };
}
