import { describe, expect, it } from 'vitest';

import {
    AL_PUBLICATION_STAGE_LIMITS,
    decodeALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';

const VALID = { maxStreams: 2, maxStagedValues: 3, maxStagedBytes: 4_096 };

describe('AL_PUBLICATION_STAGE_LIMITS (D477)', () => {
    it('names the volatile ledger\'s figures and stays frozen for every session that shares it', () => {
        expect(AL_PUBLICATION_STAGE_LIMITS).toEqual({
            maxStreams: 64,
            maxStagedValues: 1_000,
            maxStagedBytes: 4 * 1024 * 1024
        });
        expect(Object.isFrozen(AL_PUBLICATION_STAGE_LIMITS)).toBe(true);
    });
});

describe('decodeALPublicationStageLimits (D477)', () => {
    it('returns limits whose three fields are positive safe integers', () => {
        const decoded = decodeALPublicationStageLimits(VALID);

        expect(decoded.left).toBeUndefined();
        expect(decoded.right).toEqual(VALID);
    });

    it('names a missing field at its path', () => {
        const missing = { maxStreams: VALID.maxStreams, maxStagedValues: VALID.maxStagedValues };

        expect(decodeALPublicationStageLimits(missing).left).toEqual([{
            path: '$.almPublicationLimits.maxStagedBytes',
            code: 'invalid-max-staged-bytes',
            message: 'Expected a positive safe integer.'
        }]);
    });

    it('returns every field that is not a positive safe integer', () => {
        const decoded = decodeALPublicationStageLimits({ maxStreams: 1.5, maxStagedValues: 0, maxStagedBytes: '4096' });

        expect(decoded.left?.map((issue) => [issue.path, issue.code])).toEqual([
            ['$.almPublicationLimits.maxStreams', 'invalid-max-streams'],
            ['$.almPublicationLimits.maxStagedValues', 'invalid-max-staged-values'],
            ['$.almPublicationLimits.maxStagedBytes', 'invalid-max-staged-bytes']
        ]);
    });

    it('refuses a field the limits do not name', () => {
        expect(decodeALPublicationStageLimits({ ...VALID, maxStagedAgeMs: 1_000 }).left).toEqual([{
            path: '$.almPublicationLimits.maxStagedAgeMs',
            code: 'unknown-field',
            message: 'Expected only maxStreams, maxStagedValues and maxStagedBytes.'
        }]);
    });

    it.each([null, [], 'limits', 64])('refuses %j as a limits object', (value) => {
        expect(decodeALPublicationStageLimits(value).left).toEqual([{
            path: '$.almPublicationLimits',
            code: 'invalid-publication-limits',
            message: 'Expected a publication stage limits object.'
        }]);
    });
});
