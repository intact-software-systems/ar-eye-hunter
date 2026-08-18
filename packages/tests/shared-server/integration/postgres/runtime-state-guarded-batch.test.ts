import { describe, expect, it } from 'vitest';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { createRuntimeStatePostgresSql } from '../../postgres-runtime-state-client-fixtures.ts';
import { isRuntimeStateGuardedBatchRepositoryLike } from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';

const POSTGRES_INTEGRATION_ENABLED =
  readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('2100-01-02T03:04:05.678Z');

type GlobalEnv = Readonly<{
  Deno?: Readonly<{
    env: Readonly<{
      get(key: string): string | undefined;
    }>;
  }>;
  process?: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
  }>;
}>;

describe('Postgres runtime-state guarded batches', () => {
  postgresIt(
    'executes a non-empty guarded batch through postgres.js',
    async () => {
      const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
      const repository = new PSqlRuntimeStateRepository(sql);
      const namespace = `guarded-batch-${crypto.randomUUID()}`;

      try {
        const result = await repository.begin(async (transactionRepository) => {
          if (
            !isRuntimeStateGuardedBatchRepositoryLike(transactionRepository)
          ) {
            throw new Error('Expected guarded runtime-state batch capability.');
          }
          return await transactionRepository.executeGuardedBatch({
            guard: {
              operation: 'insert',
              namespace,
              key: 'guard',
              value: 'guard-value',
              expireAtTimestamp: FUTURE_MS,
            },
            effects: [
              {
                effectId: 'insert-effect',
                operation: 'insert',
                namespace,
                key: 'effect',
                value: 'effect-value',
                expireAtTimestamp: FUTURE_MS,
              },
            ],
          });
        });

        expect(result).toEqual({
          guard: {
            status: 'applied',
            operation: 'insert',
            namespace,
            key: 'guard',
            resultingRevision: 0,
          },
          effects: [
            {
              status: 'applied',
              effectId: 'insert-effect',
              operation: 'insert',
              namespace,
              key: 'effect',
              resultingRevision: 0,
            },
          ],
        });
      } finally {
        await sql`
                delete from runtime_state_store
                where store_namespace = ${namespace}
            `;
        await sql.end();
      }
    },
  );
});

function requireDatabaseUrl(): string {
  const databaseUrl = readEnv('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1',
    );
  }
  return databaseUrl;
}

function readEnv(key: string): string | undefined {
  const globals = globalThis as GlobalEnv;
  return globals.Deno?.env.get(key) ?? globals.process?.env?.[key];
}
