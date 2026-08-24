import {
    createPSqlResourceInboxRepository,
    PSqlResourceInboxEntryRepository,
    PSqlResourceInboxFinalizationRepository,
    PSqlResourceInboxMaintenance,
    PSqlResourceInboxReservationRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
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
