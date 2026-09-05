import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import {
    analyzeTransactionWrites,
    isBlockingTransactionWriteFinding
} from '../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';
import {
    analyzeFixture,
    transactionForwardingSource,
    transactionSource
} from './transaction-write-check-fixture.ts';

describe('transaction write boundaries', () => {
    it('does not infer transaction provenance from broad type-name fragments', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
            interface SqlFormatter { format(value: object): void; }
            interface DatabaseRuntime { publish(value: object): void; }
            declare const database: PSqlSql;
            declare const formatter: SqlFormatter;
            declare const runtime: DatabaseRuntime;
            declare const computed: { readonly value: string };
            function inspect(transaction: SqlFormatter, tx: DatabaseRuntime): void {
                transaction.format({ value: computed.value });
                tx.publish({ value: computed.value });
            }
            export async function execute(): Promise<void> {
                await database.begin(async () => inspect(formatter, runtime));
            }
        `);

        expect(findings.filter(isBlockingTransactionWriteFinding)).toEqual([]);
        expect(findings.map((finding) => finding.operation)).toEqual([
            'transaction.format',
            'tx.publish'
        ]);
    });

    it('recognizes an aliased PostgreSQL transaction type', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            type TransactionSql = PSqlSql;
            export async function writeMutation(transaction: TransactionSql): Promise<void> {
                await transaction.query(JSON.stringify({ value: 1 }));
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('recognizes direct intersections and interfaces extending PostgreSQL transactions', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            type PGliteSql = PSqlSql & { readonly dialect: 'pglite' };
            interface ApiV1PostgresClient extends PSqlSql { readonly applicationName: string; }
            export async function writePGlite(transaction: PGliteSql): Promise<void> {
                await transaction.query(JSON.stringify({ value: 1 }));
            }
            export async function writePostgres(transaction: ApiV1PostgresClient): Promise<void> {
                await transaction.query(JSON.stringify({ value: 2 }));
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'JSON.stringify',
            'JSON.stringify'
        ]);
    });

    it('follows an immediately invoked inline callable', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                await transaction.query((() => JSON.stringify({ value: 1 }))());
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows inline call and apply invocations', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                await transaction.query((function () { return JSON.stringify({ value: 1 }); }).call(undefined));
                await transaction.query((function () { return JSON.stringify({ value: 2 }); }).apply(undefined));
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'JSON.stringify',
            'JSON.stringify'
        ]);
    });

    it('follows named, imported, and aliased call, apply, and Reflect.apply invocations', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile(
            '/packages/domain/serialize.ts',
            `export function serializeCall(value: object): string {
                 return JSON.stringify(value);
             }
             export function serializeApply(value: object): string {
                 return JSON.stringify(value);
             }
             export function serializeReflect(value: object): string {
                 return JSON.stringify(value);
             }`
        );
        const source = project.createSourceFile(
            '/packages/domain/write.ts',
            `import {
                 serializeApply,
                 serializeCall,
                 serializeReflect
             } from './serialize.ts';
             interface PSqlSql { query(value: string): Promise<void>; }
             declare const Reflect: {
                 apply<T>(target: (value: object) => T, receiver: undefined, args: [object]): T;
             };
             export async function writeMutation(
                 transaction: PSqlSql,
                 computed: object
             ): Promise<void> {
                 const encode = serializeApply;
                 await transaction.query(serializeCall.call(undefined, computed));
                 await transaction.query(encode.apply(undefined, [computed]));
                 await transaction.query(Reflect.apply(serializeReflect, undefined, [computed]));
             }`
        );

        const findings = analyzeTransactionWrites(project, [source]);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'JSON.stringify',
            'JSON.stringify',
            'JSON.stringify'
        ]);
    });

    it('follows IndexedDB request event handlers while the write transaction is active', () => {
        const findings = analyzeFixture(`
            declare const db: IDBDatabase;
            export function writeMutation(): void {
                const transaction = db.transaction('items', 'readwrite');
                const store = transaction.objectStore('items');
                const request = store.get('current');
                request.onsuccess = () => {
                    store.put(JSON.stringify({ value: request.result }));
                };
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows IndexedDB request listeners but not post-commit transaction handlers', () => {
        const findings = analyzeFixture(`
            declare const db: IDBDatabase;
            export function writeMutation(): void {
                const transaction = db.transaction('items', 'readwrite');
                const store = transaction.objectStore('items');
                const request = store.get('current');
                request.addEventListener('success', () => {
                    store.put(JSON.stringify({ value: request.result }));
                });
                transaction.oncomplete = () => {
                    JSON.stringify({ afterCommit: true });
                };
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('stops IndexedDB transaction analysis after awaiting its resolved completion', () => {
        const findings = analyzeFixture(`
            function waitForIndexedDbTransaction(transaction: IDBTransaction): Promise<void> {
                return new Promise((resolve) => {
                    transaction.oncomplete = () => resolve();
                });
            }
            declare const db: IDBDatabase;
            export async function writeMutation(): Promise<void> {
                const transaction = db.transaction('items', 'readwrite');
                const completed = waitForIndexedDbTransaction(transaction);
                transaction.objectStore('items').put('prepared');
                await completed;
                JSON.stringify({ afterCommit: true });
            }
        `);

        expect(findings).toEqual([]);
    });

    it('resolves named IndexedDB upgrade handlers and ignores unrelated properties', () => {
        const findings = analyzeFixture(`
            declare const request: IDBOpenDBRequest;
            declare const unrelated: { onupgradeneeded: (() => void) | null };
            function installCurrentSchema(): void {
                JSON.stringify({ currentSchema: true });
            }
            request.onupgradeneeded = installCurrentSchema;
            unrelated.onupgradeneeded = () => {
                JSON.stringify({ unrelated: true });
            };
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
    });

    it('follows IndexedDB upgrade listeners registered with addEventListener', () => {
        const findings = analyzeFixture(`
            declare const request: IDBOpenDBRequest;
            function installCurrentSchema(): void {
                JSON.stringify({ currentSchema: true });
            }
            request.addEventListener('upgradeneeded', installCurrentSchema);
        `);

        expect(findings.map((finding) => finding.operation)).toEqual(['JSON.stringify']);
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
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
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
            export async function writeEach(computed: readonly string[]): Promise<void> {
                for (const write of computed) {
                    await database.begin(async (transaction) => transaction.query(write));
                }
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }]);
    });

    it('reports transactions beneath ordinary for, while, and do loops', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
            declare const database: PSqlSql;
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

    it('reports an outer retry loop even when a valid for-of batch is nested inside it', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
            declare const values: readonly string[];
            export async function writeWithRetry(): Promise<void> {
                while (true) {
                    for (const value of values) {
                        await database.begin(async (transaction) => transaction.query(value));
                    }
                }
            }
        `);

        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }));
    });

    it('exempts exact PostgreSQL ResourceInbox owners but not browser QueueBox writes', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const specialized = project.createSourceFile(
            '/packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts',
            `interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
             export class PSqlResourceInboxEntryRepository {
                 constructor(private readonly sql: PSqlSql) {}
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

    it('allows for-of batches that open one transaction per prepared value', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const source = project.createSourceFile(
            '/packages/domain/write-prepared-batch.ts',
            `interface PSqlSql {
                 begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                 query(value: string): Promise<void>;
             }
             export class PreparedBatchWriter {
                 constructor(private readonly sql: PSqlSql) {}
                 async writeAll(values: readonly string[]): Promise<void> {
                     for (const value of values) {
                         await this.sql.begin(async (transaction) => transaction.query(value));
                     }
                 }
                 async writeAttempts(attempts: readonly string[]): Promise<void> {
                     for (const attempt of attempts) {
                         await this.sql.begin(async (transaction) => transaction.query(attempt));
                     }
                 }
                 async writeAliases(values: readonly string[]): Promise<void> {
                     for (const value of values) {
                         const persistedValue = value;
                         await this.sql.begin(async (transaction) => transaction.query(persistedValue));
                     }
                 }
             }`
        );

        expect(analyzeTransactionWrites(project, [source])).toEqual([]);
    });

    it('reports retry-shaped for-of transaction loops', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>; }
            declare const database: PSqlSql;
            declare const rounds: readonly number[];
            export async function writeWithRetry(): Promise<void> {
                for (const round of rounds) {
                    await database.begin(async () => { void round; });
                }
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }]);
    });

    it('reports for-of transactions when the item does not reach persisted data', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                begin<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                query(value: string): Promise<void>;
            }
            declare const database: PSqlSql;
            function ignoreValue(transaction: PSqlSql, value: string): Promise<void> {
                void value;
                return transaction.query('constant');
            }
            export async function writeEach(values: readonly string[]): Promise<void> {
                for (const value of values) {
                    await database.begin(async (transaction) => ignoreValue(transaction, value));
                }
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.inner-retry',
            operation: 'database.begin'
        }]);
    });

    it('checks callback-bearing ResourceInbox operations and neighboring methods', () => {
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

        expect(analyzeTransactionWrites(project, [source])).toMatchObject([
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'decide'
            },
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'update'
            },
            {
                rule: 'transaction.unresolved-provenance',
                operation: 'decide'
            }
        ]);
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

    it('keeps exact ResourceInbox operations opaque without exempting neighboring methods', () => {
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

        expect(analyzeTransactionWrites(project)).toMatchObject([{
            rule: 'transaction.precomputable-work',
            operation: 'JSON.stringify',
            path: 'packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts'
        }]);
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
