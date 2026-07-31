import assert from 'node:assert/strict';
import { createPGliteSqlClient } from '../../src/db/pglite-sql-adapter.ts';

Deno.test('PGlite SQL initializes UTC exactly once before concurrent query and transaction work', async () => {
  let releaseReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const calls: string[] = [];
  type FakeRaw = {
    waitReady: Promise<void>;
    query(query: string): Promise<{ rows: unknown[] }>;
    transaction<T>(write: (transaction: FakeRaw) => Promise<T>): Promise<T>;
    close(): Promise<void>;
    exec(): Promise<void>;
    listen(): Promise<() => Promise<void>>;
  };
  let raw: FakeRaw;
  raw = {
    waitReady: ready,
    query: async (query: string) => {
      calls.push(query);
      return { rows: [] };
    },
    transaction: async <T>(write: (transaction: typeof raw) => Promise<T>): Promise<T> =>
      await write(raw),
    close: async () => undefined,
    exec: async () => undefined,
    listen: async () => async () => undefined,
  };
  const sql = createPGliteSqlClient(raw as never);

  const direct = sql`select 'direct'`;
  const transaction = sql.begin(async (tx) => await tx`select 'transaction'`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);

  releaseReady?.();
  await Promise.all([direct, transaction]);
  assert.deepEqual(calls, ["set time zone 'UTC'", "select 'direct'", "select 'transaction'"]);
});
