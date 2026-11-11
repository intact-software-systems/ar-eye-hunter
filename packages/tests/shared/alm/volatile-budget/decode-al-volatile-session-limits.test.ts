import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_MAX_AGE_MS,
    AL_VOLATILE_SESSION_MAX_TRACKS
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { decodeALVolatileSessionLimits } from '@shared/alm/volatile-budget/decode-al-volatile-session-limits.ts';

const PATH = '$.v';

describe('decodeALVolatileSessionLimits', () => {
    it('decodes the four bounds', () => {
        const input = { maxAdmissions: 2, maxBytes: 4_096, maxAgeMs: 1_000, maxTracks: 3 };
        expect(decodeALVolatileSessionLimits(input, PATH).fold(() => undefined, (limits) => limits)).toEqual(input);
    });

    it('reads a left-out age or track bound as its constant', () => {
        const decoded = decodeALVolatileSessionLimits({ maxAdmissions: 2, maxBytes: 4_096 }, PATH);
        expect(decoded.fold(() => undefined, (limits) => limits)).toEqual({
            maxAdmissions: 2,
            maxBytes: 4_096,
            maxAgeMs: AL_VOLATILE_SESSION_MAX_AGE_MS,
            maxTracks: AL_VOLATILE_SESSION_MAX_TRACKS
        });
    });

    it('names every field issue under its path', () => {
        const decoded = decodeALVolatileSessionLimits({ maxAdmissions: 0, maxBytes: 1.5, maxWindowMs: 1 }, PATH);
        const issues = decoded.fold((left) => left, () => []);
        expect(issues.map((issue) => [issue.path, issue.code])).toEqual([
            ['$.v.maxAdmissions', 'invalid-max-admissions'],
            ['$.v.maxBytes', 'invalid-max-bytes'],
            ['$.v.maxWindowMs', 'unknown-field']
        ]);
    });

    it('refuses a value that is not an object', () => {
        for (const value of ['small', null, []]) {
            const issues = decodeALVolatileSessionLimits(value, PATH).fold((left) => left, () => []);
            expect(issues.map((issue) => [issue.path, issue.code])).toEqual([[PATH, 'invalid-volatile-limits']]);
        }
    });
});
