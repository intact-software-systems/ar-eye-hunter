import {
    describe,
    expect,
    it
} from 'vitest';
import {
    compareJson,
    COMPARISON,
    toConfig,
    type JsonValue
} from '../../shared-test/json-compare/compare-json-values.ts';
import { CompareJson } from '../../shared-test/json-compare/json-compare.ts';

describe('CompareJson facade', () => {
    it('accepts unknown values captured at a native input boundary', () => {
        const expected: unknown = { type: 'message', payload: { id: 'integer' } };
        const actual: unknown = { type: 'message', payload: { id: 7, extra: true } };

        expect(compareJson(expected, actual, toConfig(COMPARISON.COMPATIBLE)).isEqual).toBe(true);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 1n, Symbol('value'), () => 1, new Date(0), new Map()])(
        'reports unsupported native values before comparison: %s',
        (value) => {
            const result = CompareJson.compatible({ value: 'any' }, { value });

            expect(result.isEqual).toBe(false);
            if (!result.isEqual) {
                expect(result.inputIssues).toEqual([
                    { input: 'actual', path: '$.value', reason: 'unsupported-value' }
                ]);
                expect(() => JSON.stringify(result)).not.toThrow();
            }
        }
    );

    it('rejects cyclic input while allowing shared non-cyclic JSON values', () => {
        const cyclic: Record<string, object> = {};
        cyclic.self = cyclic;
        const rejected = CompareJson.compatible({ self: 'any' }, cyclic);
        expect(rejected.isEqual).toBe(false);
        if (!rejected.isEqual) {
            expect(rejected.inputIssues).toEqual([
                { input: 'actual', path: '$.self', reason: 'cyclic-value' }
            ]);
        }
        const shared = Object.freeze({ id: 1 });
        expect(CompareJson.exact({ left: { id: 1 }, right: { id: 1 } }, { left: shared, right: shared }).isEqual).toBe(true);
    });

    it('does not execute accessors when validating native input', () => {
        let accesses = 0;
        const actual = {
            get value() {
                accesses++;
                return 1;
            }
        };

        const result = CompareJson.compatible({ value: 'integer' }, actual);

        expect(result.isEqual).toBe(false);
        expect(accesses).toBe(0);
        if (!result.isEqual) {
            expect(result.inputIssues).toEqual([
                { input: 'actual', path: '$.value', reason: 'accessor-property' }
            ]);
        }
    });

    it('preserves missing values and one-to-one array matching without changing frozen inputs', () => {
        const expected = Object.freeze({ values: Object.freeze([1, 1]), absent: undefined });
        const actual = Object.freeze({ values: Object.freeze([1]), absent: undefined });

        expect(CompareJson.compatible(undefined, undefined).isEqual).toBe(true);
        expect(CompareJson.compatible('any', undefined).isEqual).toBe(false);
        expect(CompareJson.compatible({ absent: undefined }, {}).isEqual).toBe(false);
        const result = CompareJson.compatible(expected, actual);
        expect(result.isEqual).toBe(false);
        if (!result.isEqual) {
            expect(result.expectedFound).toEqual([1]);
            expect(result.expectedNotFound).toEqual([1]);
            expect(result.actualNotFound).toEqual([]);
        }
        expect(expected).toEqual({ values: [1, 1], absent: undefined });
        expect(actual).toEqual({ values: [1], absent: undefined });
    });

    it('captures JSON data without hidden accessors, serialization hooks, or later input changes', () => {
        let accesses = 0;
        const actual = { id: 1 };
        Object.defineProperties(actual, {
            hidden: {
                get: () => {
                    accesses++;
                    return 7;
                }
            },
            toJSON: {
                value: () => {
                    throw new Error('native serialization hook');
                }
            }
        });

        const result = CompareJson.compatible({ hidden: 7 }, actual);
        actual.id = 2;

        expect(result.isEqual).toBe(false);
        expect(accesses).toBe(0);
        if (!result.isEqual) {
            expect(result.actual).toEqual({ id: 1 });
            expect(() => JSON.stringify(result)).not.toThrow();
        }
    });

    it('reports mismatches for JSON objects that cannot be converted to strings', () => {
        const nullPrototype = Object.create(null);
        nullPrototype.id = 1;

        for (const actual of [nullPrototype, { toString: 1, valueOf: 2 }]) {
            expect(CompareJson.compatible({ required: 1 }, actual).isEqual).toBe(false);
            expect(CompareJson.compatible('integer', actual).isEqual).toBe(false);
        }
    });

    it('rejects custom array prototypes instead of invoking their iterator', () => {
        let iterations = 0;
        const actual = [2];
        Object.setPrototypeOf(actual, {
            [Symbol.iterator]: function* () {
                iterations++;
                yield 1;
            }
        });

        const result = CompareJson.compatible([1], actual);

        expect(result.isEqual).toBe(false);
        expect(iterations).toBe(0);
        if (!result.isEqual) {
            expect(result.inputIssues).toEqual([{ input: 'actual', path: '$', reason: 'unsupported-value' }]);
        }
    });

    it('preserves sparse array length and reads hidden array data without invoking accessors', () => {
        const data = new Array<number>(2);
        Object.defineProperty(data, '1', { value: 7 });
        expect(CompareJson.compare([undefined, 7], data, { comparison: COMPARISON.EXACT_ORDERED }).isEqual).toBe(true);
        let accesses = 0;
        const accessor = new Array<number>(1);
        Object.defineProperty(accessor, '0', {
            get: () => {
                accesses++;
                return 7;
            }
        });

        const result = CompareJson.compatible([7], accessor);

        expect(result.isEqual).toBe(false);
        expect(accesses).toBe(0);
        if (!result.isEqual) {
            expect(result.inputIssues).toEqual([{ input: 'actual', path: '$[0]', reason: 'accessor-property' }]);
        }
    });

    it('captures shared subtrees without expanding every reference path', () => {
        let inspections = 0;
        let actual: object = {};
        for (let depth = 0; depth < 16; depth++) {
            actual = new Proxy({ left: actual, right: actual }, {
                ownKeys(target) {
                    inspections++;
                    return Reflect.ownKeys(target);
                }
            });
        }

        expect(CompareJson.compatible('any', actual).isEqual).toBe(true);
        expect(inspections).toBeLessThan(100);
    });

    it('preserves prototype-looking JSON keys as data and contains inspection failures', () => {
        const expected = JSON.parse('{"__proto__":{"role":"member"},"constructor":1}');
        const actual = JSON.parse('{"__proto__":{"role":"member"},"constructor":2}');
        const result = CompareJson.exact(expected, actual);
        expect(result.isEqual).toBe(false);
        expect(CompareJson.exact(expected, expected).isEqual).toBe(true);
        expect(Object.hasOwn({}, 'role')).toBe(false);

        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const rejected = CompareJson.compatible('any', revoked.proxy);
        expect(rejected.isEqual).toBe(false);
        if (!rejected.isEqual) {
            expect(rejected.inputIssues).toEqual([{ input: 'actual', path: '$', reason: 'uninspectable-value' }]);
        }
    });

    it('selects a comparison through the facade named input', () => {
        const result = CompareJson.compare(
            { id: 'integer' },
            { id: 7, extra: true },
            { comparison: COMPARISON.COMPATIBLE }
        );

        expect(result.isEqual).toBe(true);
    });

    it.each(['constructor', '__proto__'])('rejects inherited comparison key %s', (comparison) => {
        expect(() => toConfig(comparison)).toThrow(new TypeError('Comparison unsupported: ' + comparison));
    });

    it('compatible should allow extra actual fields', () => {
        const expected = {
            id: 'integer',
            name: 'string',
            status: 'ACTIVE|PENDING'
        };

        const actual = {
            id: 123,
            name: 'Alice',
            status: 'ACTIVE',
            createdAt: '2026-05-11T18:00:00Z',
            traceId: 'abc-123'
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should fail when a required field is missing', () => {
        const expected = {
            id: 'integer',
            name: 'string'
        };

        const actual = {
            id: 123
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(false);
        if (!result.isEqual) {
            expect(result.message).toContain('hasOwnProperty');
        }
    });

    it('compatibleStructure should compare structure and ignore values', () => {
        const expected = {
            id: 1,
            name: 'Alice',
            status: 'ACTIVE'
        };

        const actual = {
            id: 999,
            name: 'Bob',
            status: 'PENDING'
        };

        const result = CompareJson.compatibleStructure(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match string alternatives separated by pipe', () => {
        const expected = {
            status: 'ACTIVE|PENDING|DISABLED'
        };

        const actual = {
            status: 'PENDING'
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match integer wildcard for number values', () => {
        const expected = {
            id: 'integer'
        };

        const actual = {
            id: 123
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match integer wildcard for integer string values', () => {
        const expected = {
            id: 'integer'
        };

        const actual = {
            id: '123'
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should reject integer wildcard for non-integer strings', () => {
        const expected = {
            id: 'integer'
        };

        const actual = {
            id: '123.45'
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(false);
    });

    it('compatible should match float wildcard for non-integer number values', () => {
        const expected = {
            amount: 'float'
        };

        const actual = {
            amount: 42.75
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match any wildcard for any actual value', () => {
        const expected = {
            id: 'any',
            payload: 'any'
        };

        const actual = {
            id: 123,
            payload: {
                nested: true
            }
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('exact should fail when actual has extra fields', () => {
        const expected = {
            id: 'integer',
            name: 'string'
        };

        const actual = {
            id: 123,
            name: 'Alice',
            traceId: 'abc-123'
        };

        const result = CompareJson.exact(expected, actual);

        expect(result.isEqual).toBe(false);
        if (!result.isEqual) {
            expect(result.message).toContain('Not exact equal keys');
        }
    });

    it('exact should pass when dynamic fields are ignored by key', () => {
        const expected = {
            id: 123,
            name: 'Alice',
            traceId: 'expected-trace-id'
        };

        const actual = {
            id: 123,
            name: 'Alice',
            traceId: 'actual-trace-id'
        };

        const result = CompareJson.exact(expected, actual, {
            ignoreJsonKeys: ['traceId']
        });

        expect(result.isEqual).toBe(true);
    });

    it('compatible should ignore fields by path', () => {
        const expected = {
            id: 'integer',
            metadata: {
                createdAt: '2020-01-01T00:00:00Z',
                source: 'api'
            }
        };

        const actual = {
            id: 123,
            metadata: {
                createdAt: '2026-05-11T18:00:00Z',
                source: 'api'
            }
        };

        const result = CompareJson.compatible(expected, actual, {
            ignoreJsonPaths: ['metadata.createdAt']
        });

        expect(result.isEqual).toBe(true);
    });

    it('assertCompatible should throw on mismatch', () => {
        const expected = {
            id: 'integer'
        };

        const actual = {
            id: 'not-an-integer'
        };

        expect(() => CompareJson.assertCompatible(expected, actual)).toThrowError();
    });

    it('assertCompatible should not throw on match', () => {
        const expected = {
            id: 'integer',
            name: 'string'
        };

        const actual = {
            id: 123,
            name: 'Alice',
            createdAt: '2026-05-11T18:00:00Z'
        };

        expect(() => CompareJson.assertCompatible(expected, actual)).not.toThrow();
    });

    it('compatible should match arrays independently of ordering', () => {
        const expected = [
            {
                type: 'room.joined',
                clientId: 'string'
            },
            {
                type: 'room.left',
                clientId: 'string'
            }
        ];

        const actual = [
            {
                type: 'room.left',
                clientId: 'client-2',
                timestamp: '2026-05-11T18:00:00Z'
            },
            {
                type: 'room.joined',
                clientId: 'client-1',
                timestamp: '2026-05-11T18:00:01Z'
            }
        ];

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('exact should fail when an array contains extra unmatched actual values', () => {
        const expected = [
            {
                type: 'room.joined',
                clientId: 'string'
            }
        ];

        const actual = [
            {
                type: 'room.joined',
                clientId: 'client-1'
            },
            {
                type: 'room.left',
                clientId: 'client-2'
            }
        ];

        const result = CompareJson.exact(expected, actual);

        expect(result.isEqual).toBe(false);
    });
});

describe('CompareJson compatible-complete', () => {
    it('accepts arrays whose elements are exactly the expected ones', () => {
        const expected = {
            members: [
                { principalId: 'client-1', status: 'active' }
            ]
        };

        const actual = {
            members: [
                { principalId: 'client-1', status: 'active', joinedAtEpochMs: 1 }
            ],
            traceId: 'extra-object-fields-stay-allowed'
        };

        const result = CompareJson.compatibleComplete(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('rejects an unexpected extra array element that plain compatible accepts', () => {
        const expected = {
            members: [
                { principalId: 'client-1', status: 'active' }
            ]
        };

        const actual = {
            members: [
                { principalId: 'client-1', status: 'active' },
                { principalId: 'intruder', status: 'active' }
            ]
        };

        expect(CompareJson.compatible(expected, actual).isEqual).toBe(true);

        const result = CompareJson.compatibleComplete(expected, actual);
        expect(result.isEqual).toBe(false);
        if (!result.isEqual) {
            expect(result.message).toBe('Json array has unexpected elements');
            expect(result.actualNotFound).toEqual([
                { principalId: 'intruder', status: 'active' }
            ]);
        }
    });

    it('still reports missing expected elements', () => {
        const expected = {
            activeSessions: [
                { sessionId: 'session-1' },
                { sessionId: 'session-2' }
            ]
        };

        const actual = {
            activeSessions: [
                { sessionId: 'session-1' }
            ]
        };

        const result = CompareJson.compatibleComplete(expected, actual);

        expect(result.isEqual).toBe(false);
    });

    it('keeps object extra-key tolerance unlike exact', () => {
        const expected = {
            group: { groupId: 'g-1' },
            members: [
                { principalId: 'client-1' }
            ]
        };

        const actual = {
            group: { groupId: 'g-1', displayName: 'Group One' },
            members: [
                { principalId: 'client-1', status: 'active' }
            ]
        };

        expect(CompareJson.compatibleComplete(expected, actual).isEqual).toBe(true);
        expect(CompareJson.exact(expected, actual).isEqual).toBe(false);
    });

    it('supports wildcard tokens inside complete arrays', () => {
        const expected = {
            members: [
                { principalId: 'string', status: 'active|invited' }
            ]
        };

        const actual = {
            members: [
                { principalId: 'client-77', status: 'invited' }
            ]
        };

        expect(CompareJson.compatibleComplete(expected, actual).isEqual).toBe(true);
    });
});

describe('exact-ordered comparison', () => {
    function compare(expected: JsonValue, actual: JsonValue): boolean {
        return compareJson(expected, actual, toConfig(COMPARISON.EXACT_ORDERED, [], [])).isEqual;
    }

    // Every other mode, including `exact`, matches a reordered array. Asserting
    // a sequence — a delta chain, a stage walk — had no mode that could.
    it('rejects a reordered array that every other mode accepts', () => {
        expect(compare(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(false);
        expect(
            compareJson(['a', 'b', 'c'], ['c', 'b', 'a'], toConfig(COMPARISON.EXACT, [], []))
                .isEqual
        ).toBe(true);
    });

    it('accepts an array in the expected order', () => {
        expect(compare(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true);
    });

    it('rejects an array with extra elements', () => {
        expect(compare(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    });

    it('rejects an array missing elements', () => {
        expect(compare(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    });

    it('compares nested arrays positionally', () => {
        expect(compare({ events: [{ type: 'planned' }, { type: 'active' }] }, {
            events: [{ type: 'planned' }, { type: 'active' }]
        })).toBe(true);
        expect(compare({ events: [{ type: 'planned' }, { type: 'active' }] }, {
            events: [{ type: 'active' }, { type: 'planned' }]
        })).toBe(false);
    });

    it('still requires exact object equality', () => {
        expect(compare({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });
});
