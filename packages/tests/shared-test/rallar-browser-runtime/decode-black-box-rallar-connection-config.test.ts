import { describe, expect, it } from 'vitest';

import {
    decodeBlackBoxRallarConnectionConfig
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';

const SHAPE = 'rallar.almVolatileLimits must name maxAdmissions and maxBytes and may name maxAgeMs and maxTracks, ' +
    'each a positive integer.';

function decodeWithLimits(almVolatileLimits: string | readonly number[] | Record<string, number> | null) {
    return decodeBlackBoxRallarConnectionConfig({
        connection: 'alice',
        rallar: { apiBaseUrl: 'https://api.example.test', almVolatileLimits }
    });
}

describe('decodeBlackBoxRallarConnectionConfig volatile limits (D616)', () => {
    it('refuses an integer above the safe range, which the shared decoder reads as not a safe integer', () => {
        expect(() => decodeWithLimits({ maxAdmissions: 2, maxBytes: 2 ** 53 })).toThrow(new TypeError(SHAPE));
    });

    it('refuses a value that is not an object with the documented shape sentence', () => {
        for (const value of ['small', null, [1]]) {
            expect(() => decodeWithLimits(value)).toThrow(new TypeError(SHAPE));
        }
    });
});
