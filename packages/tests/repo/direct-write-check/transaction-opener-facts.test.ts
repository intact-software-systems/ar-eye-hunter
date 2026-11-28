import { describe, expect, it } from 'vitest';

import { computeTransactionOpenerFacts } from '../../../../scripts/direct-write-check/transaction-opener-facts.mjs';
import { createDirectWriteFixture, P_SQL_SQL_SOURCE } from './direct-write-check-fixture.ts';

const WORKER_PATH = 'packages/shared-server/maintenance/expiry-worker.ts';

describe('transaction opener facts', () => {
    it('counts begin, savepoint, transaction and runInPSqlTransaction openers by owner', () => {
        const facts = computeOpenerFacts(`
            import type { PSqlSql } from '../postgres/p-sql-sql.ts';
            declare function runInPSqlTransaction<T>(sql: PSqlSql, write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
            interface LedgerDriver { transaction<T>(write: (handle: unknown) => Promise<T>): Promise<T>; }
            export class ExpiryWorker {
                constructor(private readonly sql: PSqlSql, private readonly ledger: LedgerDriver) {}
                async sweep(): Promise<void> {
                    await this.sql.begin(async (transaction) => {
                        await transaction.savepoint(async () => undefined);
                    });
                }
                async settle(): Promise<void> { await this.ledger.transaction(async () => undefined); }
            }
            export async function compact(sql: PSqlSql): Promise<void> {
                await runInPSqlTransaction(sql, async () => undefined);
            }
        `);

        expect(facts).toEqual([
            { id: `${WORKER_PATH}#ExpiryWorker.settle`, count: 1 },
            { id: `${WORKER_PATH}#ExpiryWorker.sweep`, count: 2 },
            { id: `${WORKER_PATH}#compact`, count: 1 }
        ]);
    });

    it('records begin on a repository typed by an interface, which the transaction-write check does not resolve', () => {
        const facts = computeOpenerFacts(`
            interface RuntimeStateOptimisticTransactionalRepositoryLike {
                begin<T>(write: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>): Promise<T>;
            }
            export async function cleanReceipts(runtime: RuntimeStateOptimisticTransactionalRepositoryLike): Promise<void> {
                await runtime.begin(async () => undefined);
            }
        `);

        expect(facts).toEqual([{ id: `${WORKER_PATH}#cleanReceipts`, count: 1 }]);
    });

    it('ignores calls of those names that take no callback, and IndexedDB transactions', () => {
        const facts = computeOpenerFacts(`
            interface MatchLifecycle { begin(): void; }
            interface AppInboxTransactionWriter { begin(context: { readonly id: string }, deadline: number): void; }
            export function start(match: MatchLifecycle, writer: AppInboxTransactionWriter, database: IDBDatabase): void {
                match.begin();
                writer.begin({ id: 'command' }, 10);
                database.transaction('rows', 'readwrite');
            }
        `);

        expect(facts).toEqual([]);
    });
});

function computeOpenerFacts(workerSource: string) {
    const { project, scope } = createDirectWriteFixture({
        'packages/shared-server/postgres/p-sql-sql.ts': P_SQL_SQL_SOURCE,
        [WORKER_PATH]: workerSource
    });
    return computeTransactionOpenerFacts(project, scope);
}
