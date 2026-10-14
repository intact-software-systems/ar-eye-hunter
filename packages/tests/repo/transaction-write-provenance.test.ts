import { runInNewContext } from 'node:vm';
import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { analyzeTransactionWrites } from '../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';
import { analyzeFixture } from './transaction-write-check-fixture.ts';

describe('transaction write provenance', () => {
    it.each([
        { usage: 'void clock;', invoked: false },
        { usage: 'clock.call(undefined);', invoked: true },
        { usage: 'clock.apply(undefined, []);', invoked: true },
        { usage: '[1].map(clock);', invoked: true },
        { usage: 'new ImmediateWriter(clock);', invoked: true },
        { usage: 'clock();', invoked: true },
        { usage: 'invoke(clock);', invoked: true },
        { usage: 'Reflect.apply(invoke, undefined, [clock]);', invoked: true },
        { usage: 'const args = [clock]; invoke.apply(undefined, args);', invoked: true },
        { usage: 'const callbacks = { clock }; callbacks.clock();', invoked: true },
        { usage: 'const callbacks = { clock: clock }; callbacks.clock();', invoked: true },
        { usage: 'const callbacks = { clock }; void callbacks;', invoked: false },
        { usage: 'const args = [clock]; void args;', invoked: false },
        { usage: 'writer.readTime();', invoked: true }
    ])('follows reached clock execution for $usage', async ({ usage, invoked }) => {
        const source = `
            interface PSqlSql {
                begin<T>(work: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
            declare function recordClockCall(): void;
            class Writer {
                private readonly clock: () => Date;
                constructor(clock: () => Date) { this.clock = clock; }
                async persist(transaction: PSqlSql, value: string): Promise<void> {
                    await transaction.query(value);
                }
                readTime(): Date { return this.clock(); }
            }
            class ImmediateWriter {
                private readonly clock: () => Date;
                constructor(clock: () => Date) {
                    this.clock = clock;
                    this.clock();
                }
            }
            function invoke(clock: () => Date): Date { return clock(); }
            async function apply(transaction: PSqlSql, value: string, clock: () => Date): Promise<void> {
                const writer = new Writer(clock);
                await writer.persist(transaction, value);
                ${usage}
            }
            async function execute(): Promise<void> {
                await database.begin(async transaction => {
                    await apply(transaction, 'prepared', () => {
                        recordClockCall();
                        return new Date(Date.now());
                    });
                });
            }
            execute();
        `;
        let clockCalls = 0;
        const persisted: string[] = [];
        const transaction = {
            query: async (value: string) => {
                persisted.push(value);
            }
        };
        const runtimeSource = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 }
        }).outputText;
        await runInNewContext(runtimeSource, {
            database: { begin: async (work: (sql: typeof transaction) => Promise<void>) => await work(transaction) },
            recordClockCall: () => {
                clockCalls += 1;
            }
        });
        expect(persisted).toEqual(['prepared']);
        expect(clockCalls).toBe(invoked ? 1 : 0);

        const prohibited = analyzeFixture(source)
            .filter((finding) => finding.rule === 'transaction.precomputable-work')
            .map((finding) => finding.operation);
        expect(prohibited).toEqual(invoked ? ['Date', 'Date.now'] : []);
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
             interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
             declare const database: PSqlSql;
             export async function execute(): Promise<void> {
                 await database.begin(writeComputed);
             }`
        );

        const findings = analyzeTransactionWrites(project);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it.each(['invoke.apply', 'Reflect.apply'])('keeps opaque argument arrays unresolved at %s', (operation) => {
        const invocation = operation === 'Reflect.apply'
            ? 'Reflect.apply(invoke, undefined, argumentsFromPort)'
            : 'invoke.apply(undefined, argumentsFromPort)';
        const findings = analyzeFixture(`
            interface PSqlSql { begin<T>(work: (sql: PSqlSql) => Promise<T>): Promise<T>; }
            declare const database: PSqlSql;
            declare const argumentsFromPort: [() => number];
            function invoke(clock: () => number) { return clock(); }
            async function execute() {
                await database.begin(async sql => { ${invocation}; });
            }
        `);

        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.unresolved-provenance',
            operation
        }));
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
             interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: PSqlSql;
             function persist(transaction: PSqlSql, computed: object): Promise<void> {
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
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
            class Writer {
                persist(transaction: PSqlSql, computed: object): Promise<void> {
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
             interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: PSqlSql;
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
             interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             declare const database: PSqlSql;
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

    it('reports unresolved transaction-bound write ports for review', () => {
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

        expect(findings).toMatchObject([
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'serviceA.write'
            },
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'serviceB.finish'
            }
        ]);
    });

    it('does not treat a callable SQL transaction argument as callback provenance', () => {
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

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'writer.write'
        }]);
    });

    it('does not analyze a callback that is only constructed in the transaction', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
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
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
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
             interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: unknown): Promise<void>;
             }
             declare const database: PSqlSql;
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

        expect(findings.map((finding) => finding.operation)).toEqual([
            'JSON.stringify',
            'writer.write'
        ]);
    });

    it('terminates recursive local helper graphs at a fixed point', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
            declare const database: PSqlSql;
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
            interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
            interface Writer {
                write(transaction: PSqlSql, materialize: () => string): Promise<void>;
            }
            declare const database: PSqlSql;
            declare const writer: Writer;
            declare const callbacks: { materialize: () => string };
            export async function execute(): Promise<void> {
                await database.begin(async (transaction) => {
                    await writer.write(transaction, callbacks.materialize);
                });
            }
        `);

        expect(findings).toMatchObject([
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'writer.write',
                boundary: 'packages/domain/mutation.ts:10'
            },
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'callbacks.materialize',
                boundary: 'packages/domain/mutation.ts:10'
            }
        ]);
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
                 interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
                 declare const database: PSqlSql;
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
             interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: unknown): Promise<void>;
             }
             declare const database: PSqlSql;
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

    it('does not infer a transaction from a self-referential begin signature', () => {
        const findings = analyzeFixture(`
            interface Coordinator {
                begin<Result>(work: (coordinator: Coordinator) => Result): Result;
            }
            declare const coordinator: Coordinator;
            export function execute(): void {
                coordinator.begin(() => JSON.stringify({ value: 1 }));
            }
        `);

        expect(findings).toEqual([]);
    });

    it('uses the canonical PostgreSQL type declaration when the project contains it', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/shared-server/postgres/p-sql-sql.ts',
            'export interface PSqlSql {}'
        );
        project.createSourceFile(
            '/packages/domain/fake.ts',
            `interface PSqlSql {}
             export function write(transaction: PSqlSql): void {
                 void transaction;
                 JSON.stringify({ fake: true });
             }`
        );
        project.createSourceFile(
            '/packages/domain/real.ts',
            `import type { PSqlSql } from '../shared-server/postgres/p-sql-sql.ts';
             export function write(transaction: PSqlSql): void {
                 void transaction;
                 JSON.stringify({ real: true });
             }`
        );

        expect(analyzeTransactionWrites(project).map((finding) => finding.path)).toEqual([
            'packages/domain/real.ts'
        ]);
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
});
