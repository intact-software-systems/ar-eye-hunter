import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import {
    analyzeTransactionWrites,
    isBlockingTransactionWriteFinding
} from '../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';

describe('transaction write check', () => {
    it('reports named precomputable helpers in transaction callbacks', () => {
        const findings = analyzeFixture(`
            interface Sql {
                begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: Sql;
            declare const computed: { row: string };
            function computeRow(): string { return JSON.stringify(computed); }
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    const row = computeRow();
                    await transaction.query(row);
                });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['computeRow']);
    });

    it('follows imported transaction callback aliases', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/write-callback.ts',
            `export async function persist(): Promise<void> { JSON.stringify({ value: 1 }); }`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { persist as writeComputed } from './write-callback.ts';
             interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
             declare const database: Sql;
             export async function execute(): Promise<void> {
                 await database.begin(writeComputed);
             }`
        );

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows imported authored helpers reached from a transaction callback', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/write-helper.ts',
            `export function bindRow(value: object): string { return JSON.stringify(value); }`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { bindRow } from './write-helper.ts';
             interface Sql {
                 begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: Sql;
             function persist(transaction: Sql, computed: object): Promise<void> {
                 return transaction.query(bindRow(computed));
             }
             export async function execute(computed: object): Promise<void> {
                 await database.begin(async (transaction) => await persist(transaction, computed));
             }`
        );

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows authored method bodies reached through a typed owner', () => {
        const findings = analyzeFixture(`
            interface Sql {
                begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: Sql;
            class Writer {
                persist(transaction: Sql, computed: object): Promise<void> {
                    return transaction.query(JSON.stringify(computed));
                }
            }
            const writer = new Writer();
            export async function execute(computed: object): Promise<void> {
                await database.begin(async (transaction) => await writer.persist(transaction, computed));
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('fails closed for authored declarations without an inspectable body', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/external.d.ts',
            `export function materialize(value: object): string;`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { materialize } from './external.ts';
             interface Sql {
                 begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: Sql;
             export async function execute(computed: object): Promise<void> {
                 await database.begin(async (transaction) => {
                     await transaction.query(materialize(computed));
                 });
             }`
        );

        expect(analyzeTransactionWrites(project)).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'materialize'
        }]);
    });

    it('fails closed for external helpers without an inspectable body', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/node_modules/external/index.d.ts',
            `export function refine(value: object): string;`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { refine } from 'external';
             interface Sql {
                 begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: Sql;
             export async function execute(computed: object): Promise<void> {
                 await database.begin(async (transaction) => {
                     await transaction.query(refine(computed));
                 });
             }`
        );

        expect(analyzeTransactionWrites(project)).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'refine'
        }]);
    });

    it('allows dispatching prepared subsets through transaction-bound write ports', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {}
            interface ServiceA { write(transaction: PSqlSql, computed: string): Promise<void>; }
            interface ServiceB { finish(transaction: PSqlSql, computed: number): Promise<void>; }
            declare const serviceA: ServiceA;
            declare const serviceB: ServiceB;
            export async function write(
                transaction: PSqlSql,
                computed: { readonly forServiceA: string; readonly forServiceB: number }
            ): Promise<void> {
                await serviceA.write(transaction, computed.forServiceA);
                await serviceB.finish(transaction, computed.forServiceB);
            }
        `);

        expect(findings).toEqual([]);
    });

    it('does not treat a callable SQL transaction argument as a callback', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
            }
            interface Writer { write(transaction: PSqlSql, computed: string): Promise<void>; }
            declare const writer: Writer;
            export async function writeMutation(
                transaction: PSqlSql,
                computed: string
            ): Promise<void> {
                await writer.write(transaction, computed);
            }
        `);

        expect(findings).toEqual([]);
    });

    it('does not analyze a callback that is only constructed in the transaction', () => {
        const findings = analyzeFixture(`
            interface Sql {
                begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: Sql;
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    const later = () => JSON.stringify({ value: 1 });
                    await transaction.query('prepared');
                    void later;
                });
            }
        `);

        expect(findings).toEqual([]);
    });

    it('analyzes immediately invoked collection callbacks', () => {
        const findings = analyzeFixture(`
            interface Sql {
                begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: Sql;
            export async function execute(values: readonly object[]): Promise<void> {
                await database.begin(async (transaction) => {
                    const encoded = values.map((value) => JSON.stringify(value));
                    await transaction.query(encoded[0]);
                });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('discovers only resolved AppInbox writeComputedMutation callbacks', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<void>; }
            interface AppInboxMutationTransactionWriter {
                writeComputedMutation<Result>(
                    context: object,
                    computed: Result,
                    write: (transaction: PSqlSql) => Promise<void>
                ): Promise<Result>;
            }
            interface UnrelatedWriter {
                writeComputedMutation<Result>(
                    context: object,
                    computed: Result,
                    write: (transaction: PSqlSql) => Promise<void>
                ): Promise<Result>;
            }
            declare const transactionWriter: AppInboxMutationTransactionWriter;
            declare const unrelatedWriter: UnrelatedWriter;
            declare const context: object;
            declare const computed: { value: number };
            export async function process(): Promise<void> {
                await transactionWriter.writeComputedMutation(
                    context,
                    computed,
                    async (transaction) => {
                        await transaction.query(JSON.stringify(computed));
                    }
                );
                await unrelatedWriter.writeComputedMutation(
                    context,
                    computed,
                    async () => {
                        Math.random();
                    }
                );
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows transitive local helpers from the transaction boundary', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/materialize-row.ts',
            `export function collectRow(): unknown { return materializeRow(); }
             function materializeRow(): unknown {
                 const createdAt = Date.now();
                 const nonce = Math.random();
                 const values = [nonce].toSorted();
                 const serialized = JSON.stringify({ createdAt, values });
                 return crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
             }`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { collectRow } from './materialize-row.ts';
             interface Sql {
                 begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                 query(value: unknown): Promise<void>;
             }
             declare const database: Sql;
             export async function execute(): Promise<void> {
                 await database.begin(
                     async (transaction) => transaction.query(collectRow())
                 );
             }`
        );

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'Date.now',
            'Math.random',
            'toSorted',
            'JSON.stringify',
            'crypto.subtle.digest',
            'TextEncoder'
        ]);
        expect([...new Set(findings.map((finding) => finding.path))]).toEqual([
            'packages/domain/materialize-row.ts'
        ]);
        expect([...new Set(findings.map((finding) => finding.boundary))]).toEqual([
            'packages/domain/mutation.ts:8'
        ]);
    });

    it('analyzes locally resolved callbacks passed to transaction-bound helpers', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: unknown): Promise<void>;
            }
            interface Writer {
                write(transaction: PSqlSql, materialize: () => string): Promise<void>;
            }
            declare const database: PSqlSql;
            declare const writer: Writer;
            function materialize(): string { return JSON.stringify({ value: 1 }); }
            const materializeCallback = materialize as () => string;
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    await writer.write(transaction, materializeCallback);
                });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('terminates recursive local helper graphs at a fixed point', () => {
        const findings = analyzeFixture(`
            interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
            declare const database: Sql;
            function first(depth: number): string {
                return depth > 0 ? second(depth - 1) : JSON.stringify(depth);
            }
            function second(depth: number): string { return first(depth); }
            export async function execute(): Promise<void> {
                await database.begin(async () => { first(1); });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('fails closed when transaction-bound callback provenance is unresolved', () => {
        const findings = analyzeFixture(`
            interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
            interface Writer {
                write(transaction: Sql, materialize: () => string): Promise<void>;
            }
            declare const database: Sql;
            declare const writer: Writer;
            declare const callbacks: { materialize: () => string };
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    await writer.write(transaction, callbacks.materialize);
                });
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'callbacks.materialize',
            boundary: 'packages/domain/mutation.ts:10'
        }]);
    });

    it('fails closed when a transaction write invokes a callback parameter', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
            }
            export async function writeInside(
                transaction: PSqlSql,
                external: () => string
            ): Promise<void> {
                external();
                await transaction\`select 1\`;
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'external',
            boundary: 'packages/domain/mutation.ts:5'
        }]);
    });

    it('reports a shared helper once for each originating transaction boundary', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/shared-write.ts',
            `export function persist(): string { return JSON.stringify({ value: 1 }); }`
        );
        for (const owner of ['first', 'second']) {
            project.createSourceFile(
                `/packages/domain/${owner}-owner.ts`,
                `import { persist } from './shared-write.ts';
                 interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
                 declare const database: Sql;
                 export async function execute(): Promise<void> {
                     await database.begin(async () => { persist(); });
                 }`
            );
        }

        const findings = analyzeTransactionWrites(project);

        expect(findings).toHaveLength(2);
        expect(findings.map((finding) => finding.boundary).sort()).toEqual([
            'packages/domain/first-owner.ts:5',
            'packages/domain/second-owner.ts:5'
        ]);
    });

    it('does not follow unrelated helpers with the same name', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/safe-work.ts',
            `export function collectRow(): number { return Date.now(); }`
        );
        project.createSourceFile(
            '/packages/domain/unrelated-work.ts',
            `export function collectRow(): string { return JSON.stringify({ value: 1 }); }`
        );
        project.createSourceFile(
            '/packages/domain/mutation.ts',
            `import { collectRow } from './safe-work.ts';
             interface Sql {
                 begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                 query(value: unknown): Promise<void>;
             }
             declare const database: Sql;
             export async function execute(): Promise<void> {
                 await database.begin(async (transaction) => {
                     await transaction.query(collectRow());
                 });
             }`
        );

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => ({
            path: finding.path,
            operation: finding.operation
        }))).toEqual([
            {
                path: 'packages/domain/safe-work.ts',
                operation: 'Date.now'
            }
        ]);
    });

    it('inspects inferred object-property write implementations', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<void>; }
            interface MutationWriter {
                write(transaction: PSqlSql, computed: { value: number }): Promise<void>;
            }
            export const writer: MutationWriter = {
                write: async (transaction, computed) => {
                    await transaction.query(JSON.stringify(computed));
                }
            };
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('does not treat unrelated begin methods as transaction boundaries', () => {
        const findings = analyzeFixture(`
            interface Status { begin(work: () => void): void; }
            declare const status: Status;
            export function start(): void {
                status.begin(() => JSON.stringify({ value: 1 }));
            }
        `);

        expect(findings).toEqual([]);
    });

    it('does not recognize an unrelated function from its wrapper name alone', () => {
        const findings = analyzeFixture(`
            interface Coordinator {}
            declare function runInPSqlTransaction(
                coordinator: Coordinator,
                work: (value: string) => void
            ): void;
            declare const coordinator: Coordinator;
            export function execute(): void {
                runInPSqlTransaction(coordinator, () => {
                    JSON.stringify({ value: 1 });
                });
            }
        `);

        expect(findings).toEqual([]);
    });

    it('recognizes the canonical PostgreSQL transaction wrapper', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<void>; }
            declare function runInPSqlTransaction<T>(
                database: PSqlSql,
                write: (transaction: PSqlSql) => Promise<T>
            ): Promise<T>;
            declare const database: PSqlSql;
            export async function execute(): Promise<void> {
                await runInPSqlTransaction(database, async (transaction) => {
                    await transaction.query(JSON.stringify({ value: 1 }));
                });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('reports clocks, randomness, hashing, and sorting in transaction write functions', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: unknown): Promise<void>; }
            export async function writeMutation(transaction: PSqlSql, computed: string[]): Promise<void> {
                const now = Date.now();
                const expireAt = new Date(0);
                const id = crypto.randomUUID();
                const sorted = computed.toSorted();
                const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
                await transaction.query({ now, expireAt, sorted, bytes });
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'Date.now',
            'Date',
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

    it('reports parameter-only persisted-value construction inside a write', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                insert(value: object): Promise<void>;
                update(value: number): Promise<void>;
            }
            export async function writeMutation(
                transaction: PSqlSql,
                validatedComputed: { readonly resource: string; readonly revision: number }
            ): Promise<void> {
                await transaction.insert({ resource: validatedComputed.resource });
                await transaction.update(validatedComputed.revision + 1);
            }
        `);

        expect(findings).toMatchObject([
            {
                rule: 'transaction.precomputable-work',
                operation: 'transaction.insert argument'
            },
            {
                rule: 'transaction.precomputable-work',
                operation: 'transaction.update argument'
            }
        ]);
    });

    it('reports candidate-derived rows materialized in a local variable', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { insert(value: object): Promise<void>; }
            export async function writeMutation(
                transaction: PSqlSql,
                validatedComputed: { readonly resource: string }
            ): Promise<void> {
                const row = { resource: validatedComputed.resource };
                await transaction.insert(row);
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.precomputable-work',
            operation: 'transaction.insert argument'
        }]);
    });

    it('reports candidate-derived row materialization while iterating prepared writes', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { insert(value: object): Promise<void>; }
            export async function writeMutation(
                transaction: PSqlSql,
                validatedComputed: readonly { readonly resource: string }[]
            ): Promise<void> {
                for (const computed of validatedComputed) {
                    const row = { resource: computed.resource };
                    await transaction.insert(row);
                }
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.precomputable-work',
            operation: 'transaction.insert argument'
        }]);
    });

    it('allows direct prepared values and database-result refinements as write arguments', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                insert(value: object): Promise<{ id: number }>;
                update(value: object): Promise<void>;
            }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: { readonly row: object; readonly status: string }
            ): Promise<void> {
                const inserted = await transaction.insert(computed.row);
                await transaction.update({
                    id: Number(inserted.id),
                    status: computed.status
                });
            }
        `);

        expect(findings).toEqual([]);
    });

    it('fails closed when transaction work invokes a callable parameter', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            export async function writeMutation(
                transaction: PSqlSql,
                materialize: () => string
            ): Promise<void> {
                await transaction.query(materialize());
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'materialize'
        }]);
    });

    it('reports a callable parameter hidden behind a type assertion', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            export async function writeMutation(
                transaction: PSqlSql,
                callback: () => string
            ): Promise<void> {
                await transaction.query((callback as any)());
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: '(callback as any)'
        }]);
    });

    it('allows named computation that refines an actual database result', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                query(value: string): Promise<{ rows: readonly { revision: number }[] }>;
                update(value: number): Promise<void>;
            }
            function computeWinnerRevision(row: { revision: number }): number {
                return Number(row.revision);
            }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                const result = await transaction.query('returning revision');
                await transaction.update(computeWinnerRevision(result.rows[0]));
            }
        `);

        expect(findings).toEqual([]);
    });

    it('keeps unresolved provenance advisory while blocking proven transaction work', () => {
        expect(isBlockingTransactionWriteFinding({
            rule: 'transaction.unresolved-provenance'
        })).toBe(false);
        expect(isBlockingTransactionWriteFinding({
            rule: 'transaction.precomputable-work'
        })).toBe(true);
        expect(isBlockingTransactionWriteFinding({
            rule: 'transaction.inner-retry'
        })).toBe(true);
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
            interface Sql {
                begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: Sql;
            export async function writeWithRetry(): Promise<void> {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    await database.begin(async () => undefined);
                }
            }
            export async function writeComputed(computed: readonly string[]): Promise<void> {
                await database.begin(async (transaction) => {
                    for (const write of computed) await transaction.query(write);
                });
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }]);
    });

    it('reports transactions beneath ordinary for, while, and do loops', () => {
        const findings = analyzeFixture(`
            interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
            declare const database: Sql;
            export async function repeatWithFor(): Promise<void> {
                for (let index = 0; index < 2; index += 1) {
                    await database.begin(async () => undefined);
                }
            }
            export async function repeatWithWhile(): Promise<void> {
                while (true) {
                    await database.begin(async () => undefined);
                }
            }
            export async function repeatWithDo(): Promise<void> {
                do {
                    await database.begin(async () => undefined);
                } while (false);
            }
        `);

        expect(findings.map((finding) => finding.rule)).toEqual([
            'transaction.inner-retry',
            'transaction.inner-retry',
            'transaction.inner-retry'
        ]);
    });

    it('exempts exact PostgreSQL ResourceInbox owners but not browser QueueBox writes', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const specialized = project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
            `interface Sql { begin<T>(write: (transaction: Sql) => Promise<T>): Promise<T>; }
             export class PSqlResourceInboxEntryRepository {
                 constructor(private readonly sql: Sql) {}
                 async writeMaterializedIfAbsentOrReplaceExpired(): Promise<void> {
                     await this.sql.begin(async () => { Date.now(); });
                 }
             }`
        );
        const browser = project.createSourceFile(
            '/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts',
            `declare const db: IDBDatabase;
             export function write(): void {
                 const transaction = db.transaction('items', 'readwrite');
                 transaction.objectStore('items').put(JSON.stringify({ value: 1 }));
             }`
        );

        const findings = analyzeTransactionWrites(project, [specialized, browser]);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            path: 'packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts',
            operation: 'JSON.stringify'
        });
    });

    it('exempts exact conditional ResourceInbox owners and fails closed for neighboring methods', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const source = project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/p-sql-queue-box.ts',
            `interface Repository {
                 transaction<T>(write: (transaction: Repository) => Promise<T>): Promise<T>;
             }
             export class PSqlQueueBox {
                 constructor(private readonly repository: Repository) {}
                 async enqueueIf(decide: (current: string) => boolean): Promise<void> {
                     await this.repository.transaction(async () => {
                         decide('current');
                     });
                 }
                 async enqueueOrUpdate(update: (current: string) => string): Promise<void> {
                     await this.repository.transaction(async () => {
                         update('current');
                     });
                 }
                 async unreviewed(decide: (current: string) => boolean): Promise<void> {
                     await this.repository.transaction(async () => {
                         decide('current');
                     });
                 }
             }`
        );

        expect(analyzeTransactionWrites(project, [source])).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'decide'
        }]);
    });

    it('does not exempt new files merely because they share the ResourceInbox directory', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const source = project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/unreviewed-domain-write.ts',
            transactionSource('Date.now()')
        );

        const findings = analyzeTransactionWrites(project, [source]);

        expect(findings.map((finding) => finding.operation)).toEqual(['Date.now']);
    });

    it('does not transfer ResourceInbox transaction ownership into another owner transaction', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
            `interface PSqlSql {}
             export class PSqlResourceInboxEntryRepository {
                 constructor(transaction: PSqlSql) { void transaction; }
                 async replacePendingIfMatch(computed: object): Promise<void> {
                     JSON.stringify(computed);
                 }
                 async unreviewedReplace(computed: object): Promise<void> {
                     JSON.stringify(computed);
                 }
             }`
        );
        project.createSourceFile(
            '/packages/domain/write.ts',
            `import { PSqlResourceInboxEntryRepository } from
                 '../shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
             interface PSqlSql {}
             export async function write(transaction: PSqlSql, computed: object): Promise<void> {
                 const repository = new PSqlResourceInboxEntryRepository(transaction);
                 await repository.replacePendingIfMatch(computed);
                 await repository.unreviewedReplace(computed);
             }`
        );

        expect(analyzeTransactionWrites(project)).toMatchObject([
            {
                rule: 'transaction.precomputable-work',
                operation: 'JSON.stringify',
                path: 'packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts'
            },
            {
                rule: 'transaction.precomputable-work',
                operation: 'JSON.stringify',
                path: 'packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts'
            }
        ]);
    });

    it('allows only reviewed transaction-forwarding callback parameters', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const forwardingSources = [
            [
                '/apps/api-v1/src/db/pglite-sql-adapter.ts',
                'attachPGliteBegin',
                'fn'
            ],
            [
                '/packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts',
                'inTransaction',
                'write'
            ],
            [
                '/packages/shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts',
                'begin',
                'fn'
            ],
            [
                '/packages/shared-server/postgres/run-in-p-sql-transaction.ts',
                'runInPSqlTransaction',
                'write'
            ],
            ['/packages/domain/unreviewed-transaction-forwarder.ts', 'inTransaction', 'write']
        ] as const;
        for (const [path, functionName, parameterName] of forwardingSources) {
            project.createSourceFile(
                path,
                transactionForwardingSource(functionName, parameterName)
            );
        }

        const findings = analyzeTransactionWrites(project);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            path: 'packages/domain/unreviewed-transaction-forwarder.ts',
            operation: 'write'
        }]);
    });

    it('excludes final non-production source classes from analysis', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const excludedPaths = [
            '/packages/tests/domain/write.ts',
            '/packages/shared-test/domain/write.ts',
            '/packages/shared-rtc-bench/domain/write.ts',
            '/packages/domain/generated/write.ts',
            '/packages/domain/vendor/write.ts',
            '/packages/domain/fixtures/write.ts',
            '/packages/domain/mocks/write.ts',
            '/packages/domain/write.test.ts',
            '/packages/domain/write.spec.ts'
        ];
        for (const path of excludedPaths) {
            project.createSourceFile(path, transactionSource('Date.now()'));
        }
        project.createSourceFile('/packages/domain/write.ts', transactionSource('Date.now()'));

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => finding.path)).toEqual(['packages/domain/write.ts']);
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

function transactionForwardingSource(functionName: string, parameterName: string): string {
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
