import {
    describe,
    expect,
    it
} from 'vitest';

import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

describe('live RTC JSON evidence boundary', () => {
    it('copies validated JSON while preserving object keys and canonical zero', () => {
        const source = { frames: [{ sequence: 1 }], zero: -0 };
        const normalized = normalizeJson(source);
        source.frames[0]!.sequence = 2;
        expect(normalized).toEqual({ frames: [{ sequence: 1 }], zero: 0 });
        const keyed = normalizeJson(JSON.parse('{"__proto__":{"safe":true}}'));
        expect(Object.getOwnPropertyDescriptor(keyed, '__proto__')?.value).toEqual({ safe: true });
        expect(Object.getPrototypeOf(keyed)).toBe(Object.prototype);
    });

    it.each([
        { value: { missing: undefined }, path: '$.missing' },
        { value: { nested: [Infinity] }, path: '$.nested[0]' },
        { value: { nested: [NaN] }, path: '$.nested[0]' },
        { value: { nested: Array(1) }, path: '$.nested[0]' },
        { value: { nested: new Date(0) }, path: '$.nested' },
        { value: { nested: () => 1 }, path: '$.nested' },
        { value: { nested: 1n }, path: '$.nested' }
    ])('rejects non-JSON input at its exact boundary path %#', ({ value, path }) => {
        expect(() => normalizeJson(value)).toThrow(path);
    });
});
