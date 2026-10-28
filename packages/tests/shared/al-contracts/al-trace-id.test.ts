import { describe, expect, it } from 'vitest';

import {
    AL_TRACE_ID_PATTERN,
    decodeALTraceId,
    newALTraceId,
    validateALTraceId
} from '@shared/al-contracts/trace/al-trace-id.ts';

describe('the trace id grammar', () => {
    it.each([
        ['a UUID', '0b6f1f7e-4c8a-4e0e-9a51-5d3f2c1b7a90'],
        ['letters, digits and an underscore', 'trace_01'],
        ['one character', 'a'],
        ['128 characters', 'a'.repeat(128)]
    ])('accepts %s', (_label, value) => {
        expect(AL_TRACE_ID_PATTERN.test(value)).toBe(true);
        expect(validateALTraceId(value)).toEqual([]);
        expect(decodeALTraceId(value).right).toBe(value);
    });

    it.each([
        ['an empty string', ''],
        ['129 characters', 'a'.repeat(129)],
        ['a space', 'trace 01'],
        ['a colon', 'trace:01']
    ])('refuses %s as malformed', (_label, value) => {
        const issues = validateALTraceId(value);

        expect(AL_TRACE_ID_PATTERN.test(value)).toBe(false);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.every((issue) => issue.path === '$.traceId' && issue.code === 'malformed')).toBe(true);
        expect(decodeALTraceId(value).left).toEqual(issues[0]);
    });

    it('reports every issue of a value that is both too long and carries a bad character', () => {
        expect(validateALTraceId(`${'a'.repeat(128)}:`).map((issue) => issue.message)).toEqual([
            'Trace id must be 1 to 128 characters',
            'Trace id must contain only letters, digits, underscores or hyphens'
        ]);
    });
});

describe('the trace id boundary decoder', () => {
    it('refuses an absent trace as missing', () => {
        expect(decodeALTraceId(undefined).left).toEqual({
            path: '$.traceId',
            code: 'missing',
            message: 'Trace id is required'
        });
    });

    it.each([['a number', 7], ['null', null], ['an object', { traceId: 'trace_01' }]])(
        'refuses %s as malformed',
        (_label, value) => {
            expect(decodeALTraceId(value).left).toEqual({
                path: '$.traceId',
                code: 'malformed',
                message: 'Trace id must be a string'
            });
        }
    );
});

describe('a minted trace id', () => {
    it('validates and differs on every mint', () => {
        const minted = Array.from({ length: 16 }, () => newALTraceId());

        expect(new Set(minted).size).toBe(minted.length);
        for (const traceId of minted) {
            expect(validateALTraceId(traceId)).toEqual([]);
        }
    });
});
