import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    requiresManagedPostgresRunDatabase,
    toManagedPostgresDatabaseName,
    toManagedPostgresDatabaseUrl,
    withManagedPostgresRunDatabase
} from '@shared-test/black-box-runner/managed-api/api-v1-managed-postgres-run-database.mts';

vi.mock('postgres', () => ({ default: vi.fn() }));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('managed API-v1 PostgreSQL run database', () => {
    it('isolates the exact medium-scale profile from retained base-database queue work', () => {
        expect(
            requiresManagedPostgresRunDatabase({
                backend: 'postgres',
                clusterOnly: true,
                clusterProfile: 'api-v1-black-box-medium-scale',
                recipesOnly: false
            })
        ).toBe(true);

        expect(
            requiresManagedPostgresRunDatabase({
                backend: 'postgres',
                clusterOnly: false,
                clusterProfile: 'api-v1-black-box-medium-scale',
                recipesOnly: false
            })
        ).toBe(false);
    });

    it('isolates the topology replay proof from retained streams and queue work', () => {
        expect(
            requiresManagedPostgresRunDatabase({
                backend: 'postgres',
                profile: 'api-v1-black-box-topology-replay',
                clusterOnly: false,
                clusterProfile: 'api-v1-black-box-cluster',
                recipesOnly: false
            })
        ).toBe(true);
    });

    it('changes only the database selected by the managed PostgreSQL URL', () => {
        const databaseName = toManagedPostgresDatabaseName(
            'local-1785497966315',
            '01234567-89ab-cdef-0123-456789abcdef'
        );
        const databaseUrl = toManagedPostgresDatabaseUrl(
            'postgres://app:secret@localhost:5432/appdb?sslmode=disable',
            databaseName
        );

        expect(databaseName).toBe('rallar_bb_local_1785497966315_0123456789abcdef');
        expect(databaseName.length).toBeLessThanOrEqual(63);
        expect(databaseUrl).toBe(
            'postgres://app:secret@localhost:5432/rallar_bb_local_1785497966315_0123456789abcdef' +
                '?sslmode=disable'
        );
    });

    it('drops the isolated database after the managed callback rejects', async () => {
        const unsafe = vi.fn((_query: string) => Promise.resolve([]));
        const end = vi.fn((_options: { timeout: number; }) => Promise.resolve());
        vi.mocked(postgres).mockReturnValue({ unsafe, end } as never);

        await expect(
            withManagedPostgresRunDatabase(
                'postgres://app:secret@localhost:5432/appdb',
                'rejected-callback-run',
                async () => {
                    throw new Error('managed callback rejected');
                }
            )
        ).rejects.toThrow('managed callback rejected');

        expect(unsafe).toHaveBeenCalledTimes(2);
        expect(unsafe.mock.calls[0]?.[0]).toMatch(/^create database "rallar_bb_/);
        expect(unsafe.mock.calls[1]?.[0]).toMatch(/^drop database "rallar_bb_.*" with \(force\)$/);
        expect(end).toHaveBeenCalledWith({ timeout: 5 });
    });
});
