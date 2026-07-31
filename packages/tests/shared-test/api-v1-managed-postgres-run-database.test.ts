import { describe, expect, it } from 'vitest';

import {
  requiresManagedPostgresRunDatabase,
  toManagedPostgresDatabaseName,
  toManagedPostgresDatabaseUrl,
} from '@shared-test/black-box-runner/api-v1-managed-postgres-run-database.mts';

describe('managed API-v1 PostgreSQL run database', () => {
  it('isolates the exact medium-scale profile from retained base-database queue work', () => {
    expect(
      requiresManagedPostgresRunDatabase({
        backend: 'postgres',
        clusterOnly: true,
        clusterProfile: 'api-v1-black-box-medium-scale',
        recipesOnly: false,
      }),
    ).toBe(true);

    expect(
      requiresManagedPostgresRunDatabase({
        backend: 'postgres',
        clusterOnly: false,
        clusterProfile: 'api-v1-black-box-medium-scale',
        recipesOnly: false,
      }),
    ).toBe(false);
  });

  it('changes only the database selected by the managed PostgreSQL URL', () => {
    const databaseName = toManagedPostgresDatabaseName(
      'local-1785497966315',
      '01234567-89ab-cdef-0123-456789abcdef',
    );
    const databaseUrl = toManagedPostgresDatabaseUrl(
      'postgres://app:secret@localhost:5432/appdb?sslmode=disable',
      databaseName,
    );

    expect(databaseName).toBe('rallar_bb_local_1785497966315_0123456789abcdef');
    expect(databaseName.length).toBeLessThanOrEqual(63);
    expect(databaseUrl).toBe(
      'postgres://app:secret@localhost:5432/rallar_bb_local_1785497966315_0123456789abcdef' +
        '?sslmode=disable',
    );
  });
});
