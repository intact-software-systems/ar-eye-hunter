import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { analyzeTransactionWrites } from '../../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';

describe('transaction write check', () => {
    it('reports named precomputable helpers in transaction callbacks', () => {
        const findings = analyzeFixture(`
            interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
            declare const database: Sql;
            declare const computed: { row: string };
            function computeRow(): string { return JSON.stringify(computed); }
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    const row = computeRow();
                    await transaction.begin(async () => row);
                });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['computeRow']);
    });

    it('reports clocks, randomness, hashing, and sorting in transaction write functions', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<void>; }
            export async function writeMutation(transaction: PSqlSql, computed: string[]): Promise<void> {
                const now = Date.now();
                const id = crypto.randomUUID();
                const sorted = computed.toSorted();
                const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
                await transaction.query({ now, sorted, bytes });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'Date.now',
            'crypto.randomUUID',
            'toSorted',
            'crypto.subtle.digest',
            'TextEncoder'
        ]);
    });

    it('allows executing computed writes and bounded database-result checks', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<{ rows: { id: number }[] }>; }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: readonly { sql: string }[]
            ): Promise<number> {
                for (const write of computed) await transaction.query(write.sql);
                const result = await transaction.query('returning id');
                const id = Number(result.rows[0].id);
                if (!Number.isSafeInteger(id)) throw new Error('Invalid database id');
                return id;
            }
        `);

        expect(findings).toEqual([]);
    });

    it('recognizes IndexedDB readwrite and upgrade callbacks but excludes readonly work', () => {
        const findings = analyzeFixture(`
            declare const db: IDBDatabase;
            declare const request: IDBOpenDBRequest;
            export function read(): void {
                const transaction = db.transaction('items', 'readonly');
                JSON.stringify(transaction.objectStore('items'));
            }
            export function write(): void {
                const transaction = db.transaction('items', 'readwrite');
                const encoded = JSON.stringify({ value: 1 });
                transaction.objectStore('items').put(encoded);
            }
            export function computedBeforeWrite(): void {
                const encoded = JSON.stringify({ value: 1 });
                const transaction = db.transaction('items', 'readwrite');
                transaction.objectStore('items').put(encoded);
            }
            request.onupgradeneeded = () => {
                const stores = ['items'].toSorted();
                request.result.createObjectStore(stores[0]);
            };
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'JSON.stringify',
            'toSorted'
        ]);
    });

    it('reports transaction loops without rejecting ordinary computed-write iteration', () => {
        const findings = analyzeFixture(`
            interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
            declare const database: Sql;
            export async function writeWithRetry(): Promise<void> {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    await database.begin(async () => undefined);
                }
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }]);
    });

    it('exempts exact PostgreSQL ResourceInbox owners but not browser QueueBox writes', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const specialized = project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
            transactionSource('Date.now()')
        );
        const browser = project.createSourceFile(
            '/packages/shared/queuebox/indexed-db-queue-box-write.ts',
            `declare const db: IDBDatabase;
             export function write(): void {
                 const transaction = db.transaction('items', 'readwrite');
                 transaction.objectStore('items').put(JSON.stringify({ value: 1 }));
             }`
        );

        const findings = analyzeTransactionWrites(project, [specialized, browser]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'packages/shared/queuebox/indexed-db-queue-box-write.ts',
            operation: 'JSON.stringify'
        });
    });
});

function analyzeFixture(source: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('/packages/domain/mutation.ts', source);
    return analyzeTransactionWrites(project, [sourceFile]);
}

function transactionSource(work: string): string {
    return `
        interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
        declare const database: Sql;
        export async function write(): Promise<void> {
            await database.begin(async () => { ${work}; });
        }
    `;
}
