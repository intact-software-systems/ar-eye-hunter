import assert from 'node:assert/strict';
import {
  databaseBackendStartupLogLine,
  pgliteSchemaInitStartupLogLine,
  readApiV1DatabaseBackendConfig,
  readPGliteSchemaInitMode,
  readRallarSqlBackend,
  requirePostgresDatabaseUrl,
  resolvePGliteDataDir,
  resolvePGliteSchemaInitMode,
} from '../../src/db/database-config.ts';
import { readPostgresConnectionUrl } from '../../src/db/db.ts';

Deno.test('RALLAR_SQL_BACKEND defaults to postgres', () => {
  const env = fakeEnv({});

  assert.equal(readRallarSqlBackend(env), 'postgres');
  assert.deepEqual(readApiV1DatabaseBackendConfig(env), {
    sqlBackend: 'postgres',
  });
});

Deno.test('RALLAR_SQL_BACKEND accepts configured backends', () => {
  assert.equal(
    readRallarSqlBackend(fakeEnv({ RALLAR_SQL_BACKEND: 'postgres' })),
    'postgres',
  );
  assert.equal(
    readRallarSqlBackend(fakeEnv({ RALLAR_SQL_BACKEND: 'pglite-memory' })),
    'pglite-memory',
  );
  assert.equal(
    readRallarSqlBackend(fakeEnv({ RALLAR_SQL_BACKEND: 'pglite-file' })),
    'pglite-file',
  );
});

Deno.test('RALLAR_SQL_BACKEND rejects unsupported values', () => {
  assert.throws(
    () => readRallarSqlBackend(fakeEnv({ RALLAR_SQL_BACKEND: 'sqlite' })),
    /RALLAR_SQL_BACKEND must be one of postgres, pglite-memory, pglite-file/,
  );
});

Deno.test('DATABASE_URL is required only for postgres backend', () => {
  assert.throws(
    () => requirePostgresDatabaseUrl({ sqlBackend: 'postgres' }),
    /DATABASE_URL missing for RALLAR_SQL_BACKEND=postgres/,
  );

  assert.deepEqual(
    readApiV1DatabaseBackendConfig(fakeEnv({ RALLAR_SQL_BACKEND: 'pglite-memory' })),
    { sqlBackend: 'pglite-memory' },
  );
});

Deno.test('RALLAR_PGLITE_DATA_DIR is optional for memory and required for file mode', () => {
  assert.deepEqual(
    readApiV1DatabaseBackendConfig(fakeEnv({
      RALLAR_SQL_BACKEND: 'pglite-memory',
      RALLAR_PGLITE_DATA_DIR: 'memory://',
    })),
    { sqlBackend: 'pglite-memory', pgliteDataDir: 'memory://' },
  );

  assert.equal(
    resolvePGliteDataDir({ sqlBackend: 'pglite-memory' }),
    'memory://',
  );
  assert.equal(
    resolvePGliteDataDir({
      sqlBackend: 'pglite-file',
      pgliteDataDir: './.rallar-pglite/api-v1',
    }),
    './.rallar-pglite/api-v1',
  );

  assert.throws(
    () => resolvePGliteDataDir({ sqlBackend: 'pglite-file' }),
    /RALLAR_PGLITE_DATA_DIR must be configured/,
  );
});

Deno.test('RALLAR_PGLITE_SCHEMA_INIT supports auto and disabled modes', () => {
  assert.deepEqual(
    readApiV1DatabaseBackendConfig(fakeEnv({
      RALLAR_SQL_BACKEND: 'pglite-memory',
      RALLAR_PGLITE_SCHEMA_INIT: 'auto',
    })),
    { sqlBackend: 'pglite-memory', pgliteSchemaInit: 'auto' },
  );
  assert.equal(
    readPGliteSchemaInitMode(fakeEnv({ RALLAR_PGLITE_SCHEMA_INIT: 'disabled' })),
    'disabled',
  );

  assert.throws(
    () => readPGliteSchemaInitMode(fakeEnv({ RALLAR_PGLITE_SCHEMA_INIT: 'manual' })),
    /RALLAR_PGLITE_SCHEMA_INIT must be one of auto, disabled/,
  );
});

Deno.test('PGlite schema init defaults to auto only for PGlite backends', () => {
  assert.equal(
    resolvePGliteSchemaInitMode({ sqlBackend: 'postgres' }),
    'disabled',
  );
  assert.equal(
    resolvePGliteSchemaInitMode({ sqlBackend: 'pglite-memory' }),
    'auto',
  );
  assert.equal(
    resolvePGliteSchemaInitMode({
      sqlBackend: 'pglite-file',
      pgliteSchemaInit: 'disabled',
    }),
    'disabled',
  );

  assert.throws(
    () =>
      resolvePGliteSchemaInitMode({
        sqlBackend: 'postgres',
        pgliteSchemaInit: 'auto',
      }),
    /RALLAR_PGLITE_SCHEMA_INIT=auto requires a PGlite SQL backend/,
  );
});

Deno.test('postgres connection URL preserves default path and maps Prisma schema to search_path', () => {
  assert.equal(
    readPostgresConnectionUrl({
      sqlBackend: 'postgres',
      databaseUrl: 'postgresql://app:app@localhost:5432/appdb',
    }),
    'postgresql://app:app@localhost:5432/appdb',
  );

  assert.equal(
    readPostgresConnectionUrl({
      sqlBackend: 'postgres',
      databaseUrl: 'postgresql://app:app@localhost:5432/appdb?schema=rallar',
    }),
    'postgresql://app:app@localhost:5432/appdb?search_path=rallar',
  );
});

Deno.test('startup log reports selected backend without leaking DATABASE_URL', () => {
  assert.equal(
    databaseBackendStartupLogLine({
      sqlBackend: 'postgres',
      databaseUrl: 'postgresql://app:secret@localhost:5432/appdb',
    }),
    'Rallar API-v1 SQL backend: postgres; DATABASE_URL: configured; RALLAR_PGLITE_DATA_DIR: default',
  );
  assert.equal(
    databaseBackendStartupLogLine({ sqlBackend: 'pglite-memory' }),
    'Rallar API-v1 SQL backend: pglite-memory; DATABASE_URL: not configured; RALLAR_PGLITE_DATA_DIR: default',
  );
  assert.equal(
    databaseBackendStartupLogLine({
      sqlBackend: 'pglite-memory',
      databaseUrl: 'postgresql://app:secret@localhost:5432/appdb',
    }),
    'Rallar API-v1 SQL backend: pglite-memory; DATABASE_URL: ignored; RALLAR_PGLITE_DATA_DIR: default',
  );
  assert.equal(
    databaseBackendStartupLogLine({
      sqlBackend: 'pglite-file',
      pgliteDataDir: './.rallar-pglite/api-v1',
    }),
    'Rallar API-v1 SQL backend: pglite-file; DATABASE_URL: not configured; RALLAR_PGLITE_DATA_DIR: configured',
  );
});

Deno.test('startup log reports PGlite schema init mode', () => {
  assert.equal(
    pgliteSchemaInitStartupLogLine({ sqlBackend: 'postgres' }),
    'Rallar API-v1 PGlite schema init: disabled',
  );
  assert.equal(
    pgliteSchemaInitStartupLogLine({ sqlBackend: 'pglite-memory' }),
    'Rallar API-v1 PGlite schema init: auto',
  );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
