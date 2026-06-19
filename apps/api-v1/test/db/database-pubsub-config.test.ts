import assert from 'node:assert/strict';
import {
  databasePubSubStartupLogLine,
  defaultRallarDbPubSubMode,
  readApiV1DatabasePubSubConfig,
  readRallarDbPubSubMode,
} from '../../src/db/database-pubsub-config.ts';

Deno.test('RALLAR_DB_PUBSUB defaults to postgres for postgres SQL backend', () => {
  assert.equal(
    defaultRallarDbPubSubMode({ sqlBackend: 'postgres' }),
    'postgres',
  );
  assert.deepEqual(
    readApiV1DatabasePubSubConfig(fakeEnv({}), { sqlBackend: 'postgres' }),
    { mode: 'postgres' },
  );
});

Deno.test('RALLAR_DB_PUBSUB defaults to local for PGlite SQL backends', () => {
  assert.equal(
    defaultRallarDbPubSubMode({ sqlBackend: 'pglite-memory' }),
    'local',
  );
  assert.equal(
    defaultRallarDbPubSubMode({ sqlBackend: 'pglite-file' }),
    'local',
  );
  assert.deepEqual(
    readApiV1DatabasePubSubConfig(fakeEnv({}), { sqlBackend: 'pglite-memory' }),
    { mode: 'local' },
  );
});

Deno.test('RALLAR_DB_PUBSUB accepts local and disabled overrides', () => {
  assert.equal(
    readRallarDbPubSubMode(
      fakeEnv({ RALLAR_DB_PUBSUB: 'local' }),
      { sqlBackend: 'postgres' },
    ),
    'local',
  );
  assert.equal(
    readRallarDbPubSubMode(
      fakeEnv({ RALLAR_DB_PUBSUB: 'disabled' }),
      { sqlBackend: 'pglite-memory' },
    ),
    'disabled',
  );
});

Deno.test('RALLAR_DB_PUBSUB rejects unsupported values and PGlite postgres bridge mode', () => {
  assert.throws(
    () =>
      readRallarDbPubSubMode(
        fakeEnv({ RALLAR_DB_PUBSUB: 'redis' }),
        { sqlBackend: 'postgres' },
      ),
    /RALLAR_DB_PUBSUB must be one of postgres, local, disabled/,
  );

  assert.throws(
    () =>
      readRallarDbPubSubMode(
        fakeEnv({ RALLAR_DB_PUBSUB: 'postgres' }),
        { sqlBackend: 'pglite-memory' },
      ),
    /RALLAR_DB_PUBSUB=postgres requires RALLAR_SQL_BACKEND=postgres/,
  );
});

Deno.test('startup log reports selected pubsub mode', () => {
  assert.equal(
    databasePubSubStartupLogLine({ mode: 'local' }),
    'Rallar API-v1 DB pub/sub: local',
  );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
  return {
    get(name: string): string | undefined {
      return values[name];
    },
  };
}
