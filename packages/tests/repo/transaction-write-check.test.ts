import { describe, expect, it } from 'vitest';
import { isBlockingTransactionWriteFinding } from '../../../scripts/transaction-write-check/analyze-transaction-writes.mjs';
import { analyzeFixture } from './transaction-write-check-fixture.ts';

describe('transaction write purity', () => {
    it('reports persisted values returned by authored helpers', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                insert(value: object): Promise<void>;
                update(value: number): Promise<void>;
            }
            declare const computed: { row: string };
            function deriveRow(): object { return { resource: computed.row }; }
            function materializeWinnerRevision(): number { return 7; }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                const row = deriveRow();
                await transaction.insert(row);
                await transaction.update(materializeWinnerRevision());
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'deriveRow',
            'materializeWinnerRevision'
        ]);
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

    it('reports candidate-derived values only for proven direct transaction operations', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { store(value: object): Promise<void>; }
            interface Writer { persist(transaction: PSqlSql, value: object): Promise<void>; }
            declare const writer: Writer;
            export async function writeMutation(
                transaction: PSqlSql,
                validatedComputed: { readonly resource: string }
            ): Promise<void> {
                await transaction.store({ resource: validatedComputed.resource });
                await writer.persist(transaction, { resource: validatedComputed.resource });
            }
        `);

        expect(findings.filter(isBlockingTransactionWriteFinding)).toMatchObject([{
            rule: 'transaction.precomputable-work',
            operation: 'transaction.store argument'
        }]);
        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.unresolved-provenance',
            operation: 'writer.persist'
        }));
    });

    it('does not treat a transaction-bearing dependency bundle as persisted data', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {}
            interface Writer {
                run(
                    transaction: PSqlSql,
                    input: { readonly computed: object; readonly outboxWriter: object }
                ): Promise<void>;
            }
            declare const writer: Writer;
            export async function writeMutation(
                transaction: PSqlSql,
                computed: object,
                outboxWriter: object
            ): Promise<void> {
                await writer.run(transaction, { computed, outboxWriter });
            }
        `);

        expect(findings.filter(isBlockingTransactionWriteFinding)).toEqual([]);
        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.unresolved-provenance',
            operation: 'writer.run'
        }));
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

    it('reports authored helper output persisted through SQL tags and destructuring', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                <Result>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<Result>;
                insert(value: object): Promise<void>;
            }
            function composeResource(): string { return 'resource'; }
            function composeRow(): { row: object } { return { row: { value: 1 } }; }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                await transaction\`insert into item(resource) values (\${composeResource()})\`;
                const { row } = composeRow();
                await transaction.insert(row);
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'composeResource',
            'composeRow'
        ]);
    });

    it('reports helper output persisted through later simple and destructuring assignments', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { update(value: object): Promise<void>; }
            function compose(): { readonly row: object } { return { row: { value: 1 } }; }
            export async function writeMutation(transaction: PSqlSql): Promise<void> {
                let direct: object;
                let row: object;
                direct = compose();
                ({ row } = compose());
                await transaction.update(direct);
                await transaction.update(row);
            }
        `);

        expect(findings.map((finding) => finding.operation)).toEqual([
            'compose',
            'compose'
        ]);
    });

    it('reports candidate computation performed directly in a SQL interpolation', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                <Result>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<Result>;
            }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: { readonly revision: number; readonly optional: string | undefined }
            ): Promise<void> {
                await transaction\`insert into item(revision) values (\${computed.revision + 1})\`;
                await transaction\`insert into item(value) values (\${computed.optional ?? null})\`;
            }
        `);

        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.precomputable-work',
            operation: 'transaction interpolation'
        }));
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

    it('reports a symbol-less dynamic call in transaction work', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            export async function writeMutation(
                transaction: PSqlSql,
                callbacks: unknown
            ): Promise<void> {
                await transaction.query((callbacks as any).materialize());
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: '(callbacks as any).materialize'
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

    it('allows database results returned through authored PostgreSQL and IndexedDB readers', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                select(): Promise<{ readonly revision: number }>;
                update(value: object): Promise<void>;
            }
            function readCurrent(transaction: PSqlSql): Promise<{ readonly revision: number }> {
                return transaction.select();
            }
            function readRequest<T>(request: IDBRequest<T>): Promise<T> {
                return Promise.resolve(request.result);
            }
            function refineRevision(value: { readonly revision: number }): number {
                return Number(value.revision);
            }
            export async function writePostgres(transaction: PSqlSql): Promise<void> {
                const current = await readCurrent(transaction);
                await transaction.update({ revision: refineRevision(current) });
            }
            declare const db: IDBDatabase;
            export async function writeIndexedDb(): Promise<void> {
                const transaction = db.transaction('items', 'readwrite');
                const store = transaction.objectStore('items');
                const current = await readRequest(store.get('current'));
                store.put({ value: current });
            }
        `);

        expect(findings).toEqual([]);
    });

    it('does not treat transaction-control callback results as database data', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                savepoint<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
                update(value: object): Promise<void>;
            }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: { readonly value: string }
            ): Promise<void> {
                const laundered = await transaction.savepoint(async () => computed.value);
                await transaction.update({ value: laundered });
            }
        `);

        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.precomputable-work',
            operation: 'transaction.update argument'
        }));
    });

    it('does not let an authored helper launder candidate data through an unused database result', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                select(): Promise<{ readonly revision: number }>;
                update(value: object): Promise<void>;
            }
            function chooseCandidate(
                current: { readonly revision: number },
                computed: { readonly value: string }
            ): string {
                void current;
                return computed.value;
            }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: { readonly value: string }
            ): Promise<void> {
                const current = await transaction.select();
                const laundered = chooseCandidate(current, computed);
                await transaction.update({ value: laundered });
            }
        `);

        expect(findings).toContainEqual(expect.objectContaining({
            rule: 'transaction.precomputable-work',
            operation: 'transaction.update argument'
        }));
    });

    it('does not let one database field launder a separate candidate refinement', () => {
        const findings = analyzeFixture(`
            interface PSqlSql {
                select(): Promise<{ readonly revision: number }>;
                update(value: object): Promise<void>;
            }
            function combine(
                current: { readonly revision: number },
                computed: { readonly value: string }
            ): object {
                return { revision: current.revision, value: computed.value.trim() };
            }
            export async function writeMutation(
                transaction: PSqlSql,
                computed: { readonly value: string; readonly revision: number }
            ): Promise<void> {
                const current = await transaction.select();
                await transaction.update({
                    revision: current.revision,
                    nextRevision: computed.revision + 1
                });
                await transaction.update(combine(current, computed));
            }
        `);

        expect(findings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                rule: 'transaction.precomputable-work',
                operation: 'transaction.update argument'
            }),
            expect.objectContaining({
                rule: 'transaction.precomputable-work',
                operation: 'combine'
            })
        ]));
    });

    it('does not treat an IndexedDB object store adapter as returned database data', () => {
        const findings = analyzeFixture(`
            declare const db: IDBDatabase;
            declare const computed: { readonly value: string };
            function deriveRow(store: IDBObjectStore): object {
                void store;
                return { value: computed.value };
            }
            export function writeMutation(): void {
                const transaction = db.transaction('items', 'readwrite');
                const store = transaction.objectStore('items');
                store.put(deriveRow(store));
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.precomputable-work',
            operation: 'deriveRow'
        }]);
    });

    it('does not mistake a transaction type nested in a writer type for the transaction', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            interface TransactionBoundWriter<T> { materialize(): string; }
            export async function writeMutation(
                transaction: PSqlSql,
                writer: TransactionBoundWriter<PSqlSql>
            ): Promise<void> {
                await transaction.query(writer.materialize());
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'writer.materialize'
        }]);
    });

    it('does not treat an unrelated parameter named transaction as a database transaction', () => {
        const findings = analyzeFixture(`
            interface PSqlSql { query(value: string): Promise<void>; }
            interface Worker { materialize(): void; }
            function inspect(transaction: Worker): void {
                transaction.materialize();
            }
            export async function writeMutation(transaction: PSqlSql, worker: Worker): Promise<void> {
                inspect(worker);
                await transaction.query('written');
            }
        `);

        expect(findings).toMatchObject([{
            rule: 'transaction.unresolved-provenance',
            operation: 'transaction.materialize'
        }]);
    });
});
