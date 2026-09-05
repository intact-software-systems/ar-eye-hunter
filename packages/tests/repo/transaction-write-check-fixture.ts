import { Project } from 'ts-morph';

import { analyzeTransactionWrites } from '../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';

export function analyzeFixture(source: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('/packages/domain/mutation.ts', source);
    return analyzeTransactionWrites(project, [sourceFile]);
}

export function transactionSource(work: string): string {
    return `
        interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
        declare const database: PSqlSql;
        export async function write(): Promise<void> {
            await database.begin(async () => { ${work}; });
        }
    `;
}

export function transactionForwardingSource(functionName: string, parameterName: string): string {
    return `
        interface PSqlSql {}
        declare function runInPSqlTransaction<T>(
            database: PSqlSql,
            write: (transaction: PSqlSql) => Promise<T>
        ): Promise<T>;
        declare const database: PSqlSql;
        export function ${functionName}(
            ${parameterName}: (transaction: PSqlSql) => Promise<void>
        ): Promise<void> {
            return runInPSqlTransaction(database, ${parameterName});
        }
    `;
}
