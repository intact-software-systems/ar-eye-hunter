import {describe, expect, it} from 'vitest';
import {CompareJson} from '../../shared-test/json-compare/json-compare.ts';

describe('CompareJson facade', () => {
    it('compatible should allow extra actual fields', () => {
        const expected = {
            id: 'integer',
            name: 'string',
            status: 'ACTIVE|PENDING',
        };

        const actual = {
            id: 123,
            name: 'Alice',
            status: 'ACTIVE',
            createdAt: '2026-05-11T18:00:00Z',
            traceId: 'abc-123',
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should fail when a required field is missing', () => {
        const expected = {
            id: 'integer',
            name: 'string',
        };

        const actual = {
            id: 123,
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
            status: 'ACTIVE',
        };

        const actual = {
            id: 999,
            name: 'Bob',
            status: 'PENDING',
        };

        const result = CompareJson.compatibleStructure(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match string alternatives separated by pipe', () => {
        const expected = {
            status: 'ACTIVE|PENDING|DISABLED',
        };

        const actual = {
            status: 'PENDING',
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match integer wildcard for number values', () => {
        const expected = {
            id: 'integer',
        };

        const actual = {
            id: 123,
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match integer wildcard for integer string values', () => {
        const expected = {
            id: 'integer',
        };

        const actual = {
            id: '123',
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should reject integer wildcard for non-integer strings', () => {
        const expected = {
            id: 'integer',
        };

        const actual = {
            id: '123.45',
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(false);
    });

    it('compatible should match float wildcard for non-integer number values', () => {
        const expected = {
            amount: 'float',
        };

        const actual = {
            amount: 42.75,
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('compatible should match any wildcard for any actual value', () => {
        const expected = {
            id: 'any',
            payload: 'any',
        };

        const actual = {
            id: 123,
            payload: {
                nested: true,
            },
        };

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('exact should fail when actual has extra fields', () => {
        const expected = {
            id: 'integer',
            name: 'string',
        };

        const actual = {
            id: 123,
            name: 'Alice',
            traceId: 'abc-123',
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
            traceId: 'expected-trace-id',
        };

        const actual = {
            id: 123,
            name: 'Alice',
            traceId: 'actual-trace-id',
        };

        const result = CompareJson.exact(expected, actual, {
            ignoreJsonKeys: ['traceId'],
        });

        expect(result.isEqual).toBe(true);
    });

    it('compatible should ignore fields by path', () => {
        const expected = {
            id: 'integer',
            metadata: {
                createdAt: '2020-01-01T00:00:00Z',
                source: 'api',
            },
        };

        const actual = {
            id: 123,
            metadata: {
                createdAt: '2026-05-11T18:00:00Z',
                source: 'api',
            },
        };

        const result = CompareJson.compatible(expected, actual, {
            ignoreJsonPaths: ['metadata.createdAt'],
        });

        expect(result.isEqual).toBe(true);
    });

    it('assertCompatible should throw on mismatch', () => {
        const expected = {
            id: 'integer',
        };

        const actual = {
            id: 'not-an-integer',
        };

        expect(() => CompareJson.assertCompatible(expected, actual)).toThrowError();
    });

    it('assertCompatible should not throw on match', () => {
        const expected = {
            id: 'integer',
            name: 'string',
        };

        const actual = {
            id: 123,
            name: 'Alice',
            createdAt: '2026-05-11T18:00:00Z',
        };

        expect(() => CompareJson.assertCompatible(expected, actual)).not.toThrow();
    });

    it('compatible should match arrays independently of ordering', () => {
        const expected = [
            {
                type: 'room.joined',
                clientId: 'string',
            },
            {
                type: 'room.left',
                clientId: 'string',
            },
        ];

        const actual = [
            {
                type: 'room.left',
                clientId: 'client-2',
                timestamp: '2026-05-11T18:00:00Z',
            },
            {
                type: 'room.joined',
                clientId: 'client-1',
                timestamp: '2026-05-11T18:00:01Z',
            },
        ];

        const result = CompareJson.compatible(expected, actual);

        expect(result.isEqual).toBe(true);
    });

    it('exact should fail when an array contains extra unmatched actual values', () => {
        const expected = [
            {
                type: 'room.joined',
                clientId: 'string',
            },
        ];

        const actual = [
            {
                type: 'room.joined',
                clientId: 'client-1',
            },
            {
                type: 'room.left',
                clientId: 'client-2',
            },
        ];

        const result = CompareJson.exact(expected, actual);

        expect(result.isEqual).toBe(false);
    });
});
