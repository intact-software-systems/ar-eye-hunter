import { describe, expect, it } from 'vitest';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { isRuntimeStateGuardedBatchRepositoryLike } from '@shared-server/runtime-state/RuntimeStateGuardedBatch.ts';

const POSTGRES_INTEGRATION_ENABLED =
  readEnv('RALLAR_POSTGRES_INTEGRATION') === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const FUTURE_MS = Date.parse('2100-01-02T03:04:05.678Z');

type PostgresSql = PSqlSql &
  Readonly<{
    end(): Promise<void>;
  }>;

type PostgresModule = Readonly<{
  default: (
    databaseUrl: string,
    options: Readonly<{ max: number; idle_timeout: number }>,
  ) => PostgresSql;
}>;

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
      const sql = await createSql(requireDatabaseUrl());
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

async function createSql(databaseUrl: string): Promise<PostgresSql> {
  const postgres = (await import('postgres')) as PostgresModule;
  return postgres.default(databaseUrl, { max: 1, idle_timeout: 1 });
}

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
