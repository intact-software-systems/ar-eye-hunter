import assert from 'node:assert/strict';
import { createPGliteSqlClient } from '../../src/db/pglite-sql-adapter.ts';

Deno.test('PGlite SQL waits for readiness without mutating the existing session', async () => {
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
        releaseReady = resolve;
    });
    const calls: string[] = [];
    type FakeRaw = {
        waitReady: Promise<void>;
        query(query: string): Promise<{ rows: object[]; }>;
        transaction<T>(write: (transaction: FakeRaw) => Promise<T>): Promise<T>;
        close(): Promise<void>;
        exec(): Promise<void>;
        listen(): Promise<() => Promise<void>>;
    };
    const raw: FakeRaw = {
        waitReady: ready,
        query: (query: string) => {
            calls.push(query);
            return Promise.resolve({ rows: [] });
        },
        transaction: async <T>(write: (transaction: typeof raw) => Promise<T>): Promise<T> => await write(raw),
        close: () => Promise.resolve(),
        exec: () => Promise.resolve(),
        listen: () => Promise.resolve(() => Promise.resolve())
    };
    const sql = createPGliteSqlClient(raw as never);

    const direct = sql`select 'direct'`;
    const transaction = sql.begin(async (tx) => await tx`select 'transaction'`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, []);

    releaseReady?.();
    await Promise.all([direct, transaction]);
    assert.deepEqual(calls, ['select \'direct\'', 'select \'transaction\'']);
});
