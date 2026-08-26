import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { type RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-selectors.ts';
import { describe, expect, it } from 'vitest';

const ENTRY = {
    key: 'app=app:ws=workspace:group=room',
    value: '{"value":1}',
    expireAtTimestamp: Date.parse('9999-12-31T23:59:59.999Z'),
    updatedTimestamp: '2026-07-21T00:00:00.000Z',
    revision: 3
} as const;

const SELECTORS = [{
    selectorId: 'group',
    kind: 'key',
    namespace: 'group-state:groups',
    key: ENTRY.key
}, {
    selectorId: 'members',
    kind: 'prefix',
    namespace: 'group-state:members',
    keyPrefix: `${ENTRY.key}:`
}] as const satisfies readonly RuntimeStateReadBatchSelector[];

describe('runtime-state read batches', () => {
    it('accepts dense mandatory key and prefix selectors with caller-ordered results', () => {
        expect(validateRuntimeStateReadBatchSelectors(SELECTORS)).toEqual(SELECTORS);
        expect(validateRuntimeStateReadBatchResult(SELECTORS, [{
            selectorId: 'group',
            entries: [ENTRY]
        }, {
            selectorId: 'members',
            entries: []
        }])).toEqual([{
            selectorId: 'group',
            entries: [ENTRY]
        }, {
            selectorId: 'members',
            entries: []
        }]);
    });

    it.each([
        ['empty selectors', []],
        ['duplicate caller IDs', [SELECTORS[0], { ...SELECTORS[1], selectorId: 'group' }]],
        ['ambiguous selector', [{ ...SELECTORS[0], keyPrefix: 'app=' }]],
        ['unknown selector kind', [{ ...SELECTORS[0], kind: 'all' }]],
        ['empty caller ID', [{ ...SELECTORS[0], selectorId: '' }]],
        ['empty namespace', [{ ...SELECTORS[0], namespace: '' }]],
        ['empty exact key', [{ ...SELECTORS[0], key: '' }]],
        ['empty prefix', [{ ...SELECTORS[1], keyPrefix: '' }]]
    ])('rejects %s', (_label, input) => {
        expect(() => validateRuntimeStateReadBatchSelectors(input)).toThrow(
            /runtime state read batch/iu
        );
    });

    it('rejects sparse selectors and sparse or mismatched results', () => {
        const sparseSelectors = new Array(2);
        sparseSelectors[0] = SELECTORS[0];
        expect(() => validateRuntimeStateReadBatchSelectors(sparseSelectors))
            .toThrow(/sparse|dense/iu);

        const sparseResults = new Array(2);
        sparseResults[0] = { selectorId: 'group', entries: [ENTRY] };
        expect(() => validateRuntimeStateReadBatchResult(SELECTORS, sparseResults))
            .toThrow(/sparse|dense/iu);
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'members',
                entries: []
            }, {
                selectorId: 'group',
                entries: [ENTRY]
            }])
        ).toThrow(/caller order/iu);
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'group',
                entries: [ENTRY]
            }])
        ).toThrow(/expected 2/iu);
    });

    it('rejects malformed entries, exact-result cardinality, and prefix mismatches', () => {
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'group',
                entries: [ENTRY, ENTRY]
            }, {
                selectorId: 'members',
                entries: []
            }])
        ).toThrow(/exact key/iu);
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'group',
                entries: [ENTRY]
            }, {
                selectorId: 'members',
                entries: [{ ...ENTRY, key: 'other' }]
            }])
        ).toThrow(/prefix/iu);
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'group',
                entries: [{ ...ENTRY, key: 'other' }]
            }, {
                selectorId: 'members',
                entries: []
            }])
        ).toThrow(/exact key/iu);
        expect(() =>
            validateRuntimeStateReadBatchResult(SELECTORS, [{
                selectorId: 'group',
                entries: [{ ...ENTRY, revision: -1 }]
            }, {
                selectorId: 'members',
                entries: []
            }])
        ).toThrow(/revision/iu);
    });

    it('rejects duplicate or non-bytewise prefix result ordering', () => {
        const memberA = { ...ENTRY, key: `${ENTRY.key}:member=a` };
        const memberB = { ...ENTRY, key: `${ENTRY.key}:member=b` };
        for (
            const entries of [
                [memberB, memberA],
                [memberA, memberA]
            ]
        ) {
            expect(() =>
                validateRuntimeStateReadBatchResult(SELECTORS, [{
                    selectorId: 'group',
                    entries: [ENTRY]
                }, {
                    selectorId: 'members',
                    entries
                }])
            ).toThrow(/uniquely ordered/iu);
        }
    });

    it('uses one fixed parameterized SELECT and returns one packed driver row', async () => {
        const captured: CapturedQuery[] = [];
        const sql = captureSql(captured, [{
            selections: [{
                selectorId: 'group',
                entries: [{
                    ...ENTRY,
                    expireAtTimestamp: String(ENTRY.expireAtTimestamp),
                    revision: String(ENTRY.revision)
                }]
            }, {
                selectorId: 'members',
                entries: []
            }]
        }]);
        const repository = new PSqlRuntimeStateRepository(sql);

        await expect(repository.readRuntimeStateBatch(SELECTORS)).resolves.toEqual([{
            selectorId: 'group',
            entries: [ENTRY]
        }, {
            selectorId: 'members',
            entries: []
        }]);

        expect(captured).toHaveLength(1);
        const [query] = captured;
        expect(query.source).toMatch(/^select\b/iu);
        expect(query.source).toMatch(/jsonb_array_elements/iu);
        expect(query.source).toMatch(/with ordinality/iu);
        expect(query.source).toMatch(/store_key\s*=\s*/iu);
        expect(query.source).toMatch(/store_key collate "C"\s*>=/iu);
        expect(query.source).toMatch(/store_key collate "C"\s*</iu);
        expect(query.source).toMatch(/jsonb_agg/iu);
        expect(query.source).not.toMatch(/for\s+update|pg_advisory|lock\s+table/iu);
        for (const secret of [ENTRY.key, 'group-state:groups', 'group-state:members']) {
            expect(query.source).not.toContain(secret);
        }
        expect(query.values).toEqual([[
            {
                selectorId: 'group',
                kind: 'key',
                namespace: 'group-state:groups',
                key: ENTRY.key,
                keyPrefix: null,
                prefixEnd: null
            },
            {
                selectorId: 'members',
                kind: 'prefix',
                namespace: 'group-state:members',
                key: null,
                keyPrefix: `${ENTRY.key}:`,
                prefixEnd: `${ENTRY.key};`
            }
        ]]);
    });
});

type CapturedQuery = Readonly<{
    source: string;
    values: readonly PSqlParameter[];
}>;

function captureSql(
    captured: CapturedQuery[],
    rows: PSqlRows
): PSqlSql {
    function sql<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (Array.isArray(stringsOrValues) && !Object.hasOwn(stringsOrValues, 'raw')) {
            return {};
        }
        const strings = stringsOrValues as TemplateStringsArray;
        captured.push({
            source: Array.from(strings).join('?').replaceAll(/\s+/gu, ' ').trim(),
            values
        });
        return Promise.resolve(rows) as Promise<Result>;
    }
    return Object.assign(sql, {
        begin: async <T>(fn: (transaction: PSqlSql) => Promise<T>): Promise<T> => await fn(captureSql(captured, rows))
    });
}
