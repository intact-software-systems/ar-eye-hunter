import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { PSqlResourceInboxFinalizationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { PSqlResourceInboxReservationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import { PSqlResourceInboxMaintenance } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';
import { describe, expect, it, vi } from 'vitest';

describe('PostgreSQL resource inbox ownership', () => {
    it('constructs named owners behind one explicit transaction boundary', () => {
        const sql = Object.assign(vi.fn(), {
            begin: vi.fn()
        });

        const repository = createPSqlResourceInboxRepository(sql as never);

        expect(repository.entries).toBeInstanceOf(PSqlResourceInboxEntryRepository);
        expect(repository.reservations).toBeInstanceOf(
            PSqlResourceInboxReservationRepository
        );
        expect(repository.finalization).toBeInstanceOf(
            PSqlResourceInboxFinalizationRepository
        );
        expect(repository.maintenance).toBeInstanceOf(PSqlResourceInboxMaintenance);
        expect(repository.transaction).toEqual(expect.any(Function));
        expect('write' in repository).toBe(false);
        expect('finishReserved' in repository).toBe(false);
    });
});
