import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { compareRuntimeStateKeys } from '@shared-server/runtime-state/read-batch/compare-runtime-state-keys.ts';
import { type RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { validateRuntimeStateReadBatchResult } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-result.ts';
import { validateRuntimeStateReadBatchSelectors } from '@shared-server/runtime-state/read-batch/validate-runtime-state-read-batch-selectors.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createPrefixSuffixReadBatchFixture } from '@shared-test/shared-server/prefix-suffix-read-batch-fixture.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../test-support/fake-runtime-state-repository.ts';

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

const PRINCIPAL_MEMBERS = {
    selectorId: 'principal-members',
    kind: 'prefix-suffix',
    namespace: 'group-state:members',
    keyPrefix: 'app=app:ws=workspace:',
    keySuffix: ':member=alice'
} as const satisfies RuntimeStateReadBatchSelector;

const LIVE_SESSIONS = {
    selectorId: 'live-sessions',
    kind: 'prefix-containing',
    namespace: 'client-state:sessions',
    keyPrefix: 'app=app:ws=workspace:principal=alice:',
    storedValueContains: { status: 'active', disconnectedAtEpochMs: null }
} as const satisfies RuntimeStateReadBatchSelector;

const UNPURGED_PRESENCE = {
    selectorId: 'unpurged-presence',
    kind: 'prefix-expiring-after',
    namespace: 'group-state:sessions',
    keyPrefix: `${ENTRY.key}:`,
    expiringAfterTimestamp: 5_000
} as const satisfies RuntimeStateReadBatchSelector;

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

    it('accepts a prefix-suffix selector with exactly its declared fields', () => {
        expect(validateRuntimeStateReadBatchSelectors([PRINCIPAL_MEMBERS])).toEqual([
            PRINCIPAL_MEMBERS
        ]);
    });

    it.each([
        ['empty prefix-suffix prefix', [{ ...PRINCIPAL_MEMBERS, keyPrefix: '' }]],
        ['empty prefix-suffix suffix', [{ ...PRINCIPAL_MEMBERS, keySuffix: '' }]],
        ['prefix-suffix suffix that starts outside the BMP', [{ ...PRINCIPAL_MEMBERS, keySuffix: '\u{1F7FF}:member=a' }]],
        ['prefix-suffix without a suffix', [{ ...SELECTORS[1], kind: 'prefix-suffix' }]],
        ['prefix selector carrying a suffix', [{ ...SELECTORS[1], keySuffix: ':member=alice' }]],
        ['prefix-suffix selector carrying an exact key', [{ ...PRINCIPAL_MEMBERS, key: ENTRY.key }]],
        ['empty suffix', [{ selectorId: 'tail', kind: 'suffix', namespace: 'group-state:sessions', keySuffix: '' }]],
        [
            'suffix that starts outside the BMP',
            [{ selectorId: 'tail', kind: 'suffix', namespace: 'group-state:sessions', keySuffix: '\u{10FFFF}:x' }]
        ],
        ['suffix selector carrying a prefix', [{ ...PRINCIPAL_MEMBERS, kind: 'suffix' }]]
    ])('rejects %s', (_label, input) => {
        expect(() => validateRuntimeStateReadBatchSelectors(input)).toThrow(
            /runtime state read batch/iu
        );
    });

    it.each([
        ['outside the prefix', 'app=app:ws=other:group=room:member=alice'],
        ['without the literal suffix', 'app=app:ws=workspace:group=room:member=alicex'],
        ['whose prefix and suffix overlap', 'app=app:ws=workspace:member=alice']
    ])('rejects a prefix-suffix result entry %s', (_label, key) => {
        expect(() =>
            validateRuntimeStateReadBatchResult([PRINCIPAL_MEMBERS], [{
                selectorId: 'principal-members',
                entries: [{ ...ENTRY, key }]
            }])
        ).toThrow(/does not match prefix-suffix/iu);
    });

    it('selects literal prefix-suffix matches in memory in caller order and UTF-8 key order', async () => {
        const namespace = 'read-batch-memory';
        const fixture = createPrefixSuffixReadBatchFixture(namespace);
        const repository = new FakeRuntimeStateRepository();
        for (const [index, entry] of fixture.entries.entries()) {
            await repository.upsert(
                entry.namespace,
                entry.key,
                `value-${index}`,
                ENTRY.expireAtTimestamp
            );
        }

        const selections = await repository.readRuntimeStateBatch(fixture.selectors);

        expect(selections.map((selection) => ({
            selectorId: selection.selectorId,
            keys: selection.entries.map((entry) => entry.key)
        }))).toEqual(fixture.expectedSelections);
    });

    it('rejects sparse selectors and mismatched results', () => {
        const sparseSelectors = new Array(2);
        sparseSelectors[0] = SELECTORS[0];
        expect(() => validateRuntimeStateReadBatchSelectors(sparseSelectors))
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

    it('rejects exact-result cardinality and prefix mismatches', () => {
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

    it('orders keys by code point, as C collation orders their UTF-8 bytes, astral characters after U+E000-U+FFFF', () => {
        const keys = ['b', '\u{1F600}', '\uFFFF', 'a\u{10000}', '\uE000', 'a', 'a\uFFFD', ''];

        expect([...keys].sort(compareRuntimeStateKeys)).toEqual(
            [...keys].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        );
        expect(compareRuntimeStateKeys('\uE000', '\u{1F600}')).toBeLessThan(0);
        expect(compareRuntimeStateKeys('\u{1F600}', '\uFFFF')).toBeGreaterThan(0);
        expect(compareRuntimeStateKeys('prefix:a', 'prefix:a')).toBe(0);
        expect(compareRuntimeStateKeys('prefix:', 'prefix:a')).toBeLessThan(0);
    });

    it('accepts a U+E000 key before an astral key and rejects them reversed', () => {
        const privateUse = { ...ENTRY, key: `${ENTRY.key}:member=\uE000` };
        const astral = { ...ENTRY, key: `${ENTRY.key}:member=\u{1F600}` };
        const selection = (entries: readonly RuntimeStateEntry[]) => [
            { selectorId: 'group', entries: [ENTRY] },
            { selectorId: 'members', entries }
        ];

        expect(validateRuntimeStateReadBatchResult(SELECTORS, selection([privateUse, astral]))).toEqual(
            selection([privateUse, astral])
        );
        expect(() => validateRuntimeStateReadBatchResult(SELECTORS, selection([astral, privateUse])))
            .toThrow(/uniquely ordered/iu);
    });

    it('accepts value-containing and expiring-after prefix selectors with exactly their declared fields', () => {
        expect(validateRuntimeStateReadBatchSelectors([LIVE_SESSIONS, UNPURGED_PRESENCE])).toEqual([
            LIVE_SESSIONS,
            UNPURGED_PRESENCE
        ]);
    });

    it.each([
        ['containment without fields', [{ ...LIVE_SESSIONS, storedValueContains: {} }]],
        ['containment of a nested object', [{ ...LIVE_SESSIONS, storedValueContains: { status: { value: 'active' } } }]],
        ['containment of an array', [{ ...LIVE_SESSIONS, storedValueContains: ['active'] }]],
        ['containment carrying an expiry floor', [{ ...LIVE_SESSIONS, expiringAfterTimestamp: 1 }]],
        ['containment without a prefix', [{ ...LIVE_SESSIONS, keyPrefix: '' }]],
        ['an expiry floor that is not an integer', [{ ...UNPURGED_PRESENCE, expiringAfterTimestamp: 1.5 }]],
        ['an expiry floor carrying a containment', [{ ...UNPURGED_PRESENCE, storedValueContains: { status: 'active' } }]],
        ['an expiry floor without a prefix', [{ ...UNPURGED_PRESENCE, keyPrefix: '' }]]
    ])('rejects %s', (_label, input) => {
        expect(() => validateRuntimeStateReadBatchSelectors(input)).toThrow(/runtime state read batch/iu);
    });

    it('selects in memory only the prefix rows whose stored object holds the fields, and only rows expiring after the floor', async () => {
        const repository = new FakeRuntimeStateRepository();
        const sessionKey = (sessionId: string) => `${LIVE_SESSIONS.keyPrefix}session=${sessionId}`;
        await repository.upsert(
            LIVE_SESSIONS.namespace,
            sessionKey('active'),
            JSON.stringify({ status: 'active', disconnectedAtEpochMs: null }),
            ENTRY.expireAtTimestamp
        );
        await repository.upsert(
            LIVE_SESSIONS.namespace,
            sessionKey('disconnected'),
            JSON.stringify({ status: 'disconnected', disconnectedAtEpochMs: 2 }),
            ENTRY.expireAtTimestamp
        );
        await repository.upsert(LIVE_SESSIONS.namespace, sessionKey('unset'), JSON.stringify({ status: 'active' }), ENTRY.expireAtTimestamp);
        await repository.upsert(
            LIVE_SESSIONS.namespace,
            'app=app:ws=workspace:principal=bob:session=active',
            JSON.stringify({ status: 'active', disconnectedAtEpochMs: null }),
            ENTRY.expireAtTimestamp
        );
        await repository.upsert(UNPURGED_PRESENCE.namespace, `${UNPURGED_PRESENCE.keyPrefix}session=at-floor`, '{}', 5_000);
        await repository.upsert(UNPURGED_PRESENCE.namespace, `${UNPURGED_PRESENCE.keyPrefix}session=after-floor`, '{}', 5_001);

        const selections = await repository.readRuntimeStateBatch([LIVE_SESSIONS, UNPURGED_PRESENCE]);

        expect(selections.map((selection) => selection.entries.map((entry) => entry.key))).toEqual([
            [sessionKey('active')],
            [`${UNPURGED_PRESENCE.keyPrefix}session=after-floor`]
        ]);
    });

    it.each([
        [
            'misordered',
            [toDriverRow(2, { ...ENTRY, key: `${ENTRY.key}:member=b` }), toDriverRow(2, { ...ENTRY, key: `${ENTRY.key}:member=a` })],
            /uniquely ordered/iu
        ],
        [
            'duplicated',
            [toDriverRow(2, { ...ENTRY, key: `${ENTRY.key}:member=a` }), toDriverRow(2, { ...ENTRY, key: `${ENTRY.key}:member=a` })],
            /uniquely ordered/iu
        ],
        ['foreign to its prefix selector', [toDriverRow(2, { ...ENTRY, key: 'app=app:ws=other:group=room:member=a' })], /does not match prefix/iu],
        ['foreign to its exact selector', [toDriverRow(1, { ...ENTRY, key: 'other' })], /exact key does not match/iu],
        ['of no selector', [toDriverRow(3, ENTRY)], /no selector at ordinal 3/iu],
        ['carrying a negative revision', [toDriverRow(1, { ...ENTRY, revision: -1 })], /revision is invalid/iu],
        ['carrying an unsafe expiry', [{ ...toDriverRow(1, ENTRY), expire_at_timestamp: '9007199254740993' }], /expiry is invalid/iu],
        ['carrying an invalid update time', [{ ...toDriverRow(1, ENTRY), updated_timestamp: 'never' }], /updated timestamp is invalid/iu],
        ['carrying no value', [{ ...toDriverRow(1, ENTRY), store_value: null }], /value must be a string/iu]
    ])('rejects a database result %s at the repository', async (_label, rows, message) => {
        const repository = new PSqlRuntimeStateRepository(captureSql([], rows));

        await expect(repository.readRuntimeStateBatch(SELECTORS)).rejects.toThrow(message);
        await expect(repository.readRuntimeStateBatchWithVersion(SELECTORS)).rejects.toThrow(message);
    });

    it('maps driver rows straight to entries, normalising the update time to milliseconds', async () => {
        const repository = new PSqlRuntimeStateRepository(captureSql([], [{
            ...toDriverRow(1, ENTRY),
            updated_timestamp: '2026-07-21T02:00:00.123456+02:00'
        }]));

        await expect(repository.readRuntimeStateBatch([SELECTORS[0]])).resolves.toEqual([{
            selectorId: 'group',
            entries: [{ ...ENTRY, updatedTimestamp: '2026-07-21T00:00:00.123Z' }]
        }]);
    });

    it('binds a value containment and an expiry floor as filters on the prefix range of the same statement', async () => {
        const captured: CapturedQuery[] = [];

        await new PSqlRuntimeStateRepository(captureSql(captured, [])).readRuntimeStateBatch([
            LIVE_SESSIONS,
            UNPURGED_PRESENCE
        ]);

        expect(captured).toHaveLength(1);
        expect(captured[0].source).toContain('containing_entry.store_key collate "C" >= selector.key_prefix');
        expect(captured[0].source).toContain('containing_entry.store_key collate "C" < selector.prefix_end');
        expect(captured[0].source).toContain('containing_entry.store_value::jsonb @> selector.stored_value_contains');
        expect(captured[0].source).toContain('expiring_entry.store_key collate "C" >= selector.key_prefix');
        expect(captured[0].source).toContain(
            'extract(epoch from expiring_entry.expire_at_ts) * 1000 > selector.expiring_after_timestamp'
        );
        expect(captured[0].values.find(Array.isArray)).toEqual([{
            ...NO_SQL_SELECTOR_FIELDS,
            ...LIVE_SESSIONS,
            prefixEnd: 'app=app:ws=workspace:principal=alice;'
        }, {
            ...NO_SQL_SELECTOR_FIELDS,
            ...UNPURGED_PRESENCE,
            prefixEnd: `${ENTRY.key};`
        }]);
    });

    it('uses one fixed parameterized SELECT and returns one driver row per selected entry', async () => {
        const memberEntry = { ...ENTRY, key: 'app=app:ws=workspace:group=room:member=alice' };
        const captured: CapturedQuery[] = [];
        const sql = captureSql(captured, [toDriverRow(1, ENTRY), toDriverRow(3, memberEntry)]);
        const repository = new PSqlRuntimeStateRepository(sql);

        await expect(repository.readRuntimeStateBatch([...SELECTORS, PRINCIPAL_MEMBERS])).resolves
            .toEqual([{
                selectorId: 'group',
                entries: [ENTRY]
            }, {
                selectorId: 'members',
                entries: []
            }, {
                selectorId: 'principal-members',
                entries: [memberEntry]
            }]);

        expect(captured).toHaveLength(1);
        const [query] = captured;
        expect(query.source).toMatch(/^select\b/iu);
        expect(query.source).toMatch(/jsonb_array_elements/iu);
        expect(query.source).toMatch(/with ordinality/iu);
        expect(query.source).toMatch(/store_key\s*=\s*/iu);
        expect(query.source).toMatch(/store_key collate "C"\s*>=/iu);
        expect(query.source).toMatch(/store_key collate "C"\s*</iu);
        expect(query.source).toContain(
            'reverse(suffix_entry.store_key) collate "C" >= selector.reversed_suffix'
        );
        expect(query.source).toContain(
            'reverse(suffix_entry.store_key) collate "C" < selector.reversed_suffix_end'
        );
        expect(query.source).toContain(
            'char_length(suffix_entry.store_key) >= char_length(selector.key_prefix) + char_length(selector.key_suffix)'
        );
        expect(query.source).not.toMatch(/\blike\b|\bsimilar\b|~/iu);
        expect(query.source).not.toMatch(/jsonb_agg/iu);
        expect(query.values.filter((value) => typeof value === 'boolean')).toEqual([true]);
        expect(query.source).not.toMatch(/for\s+update|pg_advisory|lock\s+table/iu);
        for (
            const secret of [
                ENTRY.key,
                'group-state:groups',
                'group-state:members',
                ':member=alice'
            ]
        ) {
            expect(query.source).not.toContain(secret);
        }
        expect(query.values.find(Array.isArray)).toEqual([
            {
                selectorId: 'group',
                kind: 'key',
                namespace: 'group-state:groups',
                key: ENTRY.key,
                keyPrefix: null,
                keySuffix: null,
                prefixEnd: null,
                reversedSuffix: null,
                reversedSuffixEnd: null,
                storedValueContains: null,
                expiringAfterTimestamp: null
            },
            {
                selectorId: 'members',
                kind: 'prefix',
                namespace: 'group-state:members',
                key: null,
                keyPrefix: `${ENTRY.key}:`,
                keySuffix: null,
                prefixEnd: `${ENTRY.key};`,
                reversedSuffix: null,
                reversedSuffixEnd: null,
                storedValueContains: null,
                expiringAfterTimestamp: null
            },
            {
                selectorId: 'principal-members',
                kind: 'prefix-suffix',
                namespace: 'group-state:members',
                key: null,
                keyPrefix: 'app=app:ws=workspace:',
                keySuffix: ':member=alice',
                prefixEnd: 'app=app:ws=workspace;',
                reversedSuffix: 'ecila=rebmem:',
                reversedSuffixEnd: 'ecila=rebmem;',
                storedValueContains: null,
                expiringAfterTimestamp: null
            }
        ]);
    });

    it('binds a suffix selector as the range of its reversed key', async () => {
        const captured: CapturedQuery[] = [];
        const sql = captureSql(captured, []);

        await new PSqlRuntimeStateRepository(sql).readRuntimeStateBatch([{
            selectorId: 'session',
            kind: 'suffix',
            namespace: 'group-state:sessions',
            keySuffix: ':session=a%3Ab'
        }]);

        expect(captured[0].source).toContain('reverse(reversed_entry.store_key) collate "C" >= selector.reversed_suffix');
        expect(captured[0].values.find(Array.isArray)).toEqual([{
            selectorId: 'session',
            kind: 'suffix',
            namespace: 'group-state:sessions',
            key: null,
            keyPrefix: null,
            keySuffix: ':session=a%3Ab',
            prefixEnd: null,
            reversedSuffix: 'bA3%a=noisses:',
            reversedSuffixEnd: 'bA3%a=noisses;',
            storedValueContains: null,
            expiringAfterTimestamp: null
        }]);
    });
});

const NO_SQL_SELECTOR_FIELDS = {
    key: null,
    keyPrefix: null,
    keySuffix: null,
    storedValueContains: null,
    expiringAfterTimestamp: null,
    prefixEnd: null,
    reversedSuffix: null,
    reversedSuffixEnd: null
} as const;

function toDriverRow(selectorOrdinal: number, entry: RuntimeStateEntry): PSqlRows[number] {
    return {
        selector_ordinal: selectorOrdinal,
        store_key: entry.key,
        store_value: entry.value,
        expire_at_timestamp: String(entry.expireAtTimestamp),
        updated_timestamp: entry.updatedTimestamp,
        revision: String(entry.revision),
        row_version: '1/(0,1)'
    };
}

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
