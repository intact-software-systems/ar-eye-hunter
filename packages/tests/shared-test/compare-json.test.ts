import { describe, expect, it } from 'vitest';
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

    it('selects a comparison through the facade named input', () => {
        const result = CompareJson.compare(
            { id: 'integer' },
            { id: 7, extra: true },
            { comparison: COMPARISON.COMPATIBLE }
        );

        expect(result.isEqual).toBe(true);
    });

    it.each(['constructor', '__proto__'])('rejects inherited comparison key %s', (comparison) => {
        expect(() => toConfig(comparison)).toThrow(expect.objectContaining({
            error: 'Comparison unsupported: ' + comparison,
            comparisons: COMPARISON
        }));
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
