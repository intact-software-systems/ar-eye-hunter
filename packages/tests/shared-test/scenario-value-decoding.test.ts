import { buildSync } from 'esbuild';
import {
    describe,
    expect,
    it
} from 'vitest';
import { decodeScenarioPositiveInteger } from '../../shared-test/black-box-runner/scenario-value-decoding.ts';

describe('scenario value decoding browser boundary', () => {
    it('bundles the decoder for a browser without Node external modules', () => {
        const result = buildSync({
            entryPoints: ['packages/shared-test/black-box-runner/scenario-value-decoding.ts'],
            bundle: true,
            platform: 'browser',
            format: 'esm',
            write: false,
            logLevel: 'silent'
        });
        expect(result.outputFiles[0].text).toContain('decodeScenarioPositiveInteger');
    });

    it('preserves first positive scalar selection and decimal truncation', () => {
        expect(decodeScenarioPositiveInteger([undefined, null, '', 0, -2, 'invalid', ' 12.9items', 30])).toBe(12);
        expect(decodeScenarioPositiveInteger([3.8, '12'])).toBe(3);
        expect(decodeScenarioPositiveInteger([Number.NaN, Infinity, '-2', '0', ''])).toBeUndefined();
    });

    it('rejects opaque values without reading their coercion accessors', () => {
        const opaque = {
            get toString(): never {
                throw new Error('Opaque coercion must not be observed.');
            },
            get [Symbol.toPrimitive](): never {
                throw new Error('Opaque coercion must not be observed.');
            }
        };
        expect(decodeScenarioPositiveInteger([opaque, true, false, [], Symbol('value'), 2n, '7'])).toBe(7);
    });
});
