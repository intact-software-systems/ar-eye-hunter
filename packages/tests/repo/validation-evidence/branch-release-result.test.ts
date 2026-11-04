import { describe, expect, it } from 'vitest';

import { validateBranchReleaseConclusion } from '../../../../scripts/validation-evidence/branch-release-result.mjs';

describe('Branch Release Gate result', () => {
    // A superseded run cancels its jobs, leaving their outputs empty. The conclusion must name that
    // rather than reporting the chain of derived failures an empty reuse decision would produce.
    it.each([
        ['governance', 'cancelled', 'cancelled', 'skipped', 'cancelled', 'skipped'],
        ['release', 'success', 'success', 'cancelled', 'cancelled', 'skipped'],
        ['observation', 'success', 'success', 'skipped', 'skipped', 'cancelled']
    ])(
        'reports a cancelled %s run as cancelled, not as a failure',
        (
            _name,
            governanceResult,
            selectionResult,
            releaseResult,
            publicationResult,
            rtcObservationResult
        ) => {
            const issues = validateBranchReleaseConclusion({
                governanceResult,
                selectionResult,
                mode: '',
                reuse: '',
                releaseResult,
                publicationResult,
                rtcObservationResult,
                gamesResult: 'skipped'
            });

            expect(issues).toHaveLength(1);
            expect(issues[0]).toContain('run cancelled before it could conclude');
            expect(issues[0]).toContain('a superseding run decides this branch');
            expect(issues[0]).not.toContain('reuse decision must be true or false');
        }
    );

    it.each([
        ['fresh validation', 'broad', 'false', 'success', 'success', 'skipped', 'success'],
        ['same-PR content reuse', 'reuse', 'true', 'skipped', 'skipped', 'skipped', 'skipped'],
        ['RTC observation integrity', 'rtc-observation', 'false', 'skipped', 'skipped', 'success', 'skipped']
    ])(
        'accepts successful %s',
        (_name, mode, reuse, releaseResult, publicationResult, rtcObservationResult, gamesResult) => {
            expect(
                validateBranchReleaseConclusion({
                    governanceResult: 'success',
                    selectionResult: 'success',
                    mode,
                    reuse,
                    releaseResult,
                    publicationResult,
                    rtcObservationResult,
                    gamesResult
                })
            ).toEqual([]);
        }
    );

    it('accepts a platform-only pull request that skips the games gate', () => {
        expect(
            validateBranchReleaseConclusion({
                governanceResult: 'success',
                selectionResult: 'success',
                mode: 'broad',
                reuse: 'false',
                releaseResult: 'success',
                publicationResult: 'success',
                rtcObservationResult: 'skipped',
                gamesResult: 'skipped'
            })
        ).toEqual([]);
    });

    it('rejects every failed constituent without an external deviation', () => {
        expect(
            validateBranchReleaseConclusion({
                governanceResult: 'failure',
                selectionResult: 'failure',
                mode: 'broad',
                reuse: 'false',
                releaseResult: 'failure',
                publicationResult: 'failure',
                rtcObservationResult: 'failure',
                gamesResult: 'failure'
            })
        ).toEqual([
            'Governance Gate did not succeed',
            'validation-evidence selection did not succeed',
            'broad Release Gate did not succeed',
            'broad Games Release Gate did not succeed',
            'fresh validation evidence was not published',
            'broad validation requires RTC observation integrity to be skipped'
        ]);
    });

    it('rejects a malformed or contradictory selection mode', () => {
        expect(
            validateBranchReleaseConclusion({
                governanceResult: 'success',
                selectionResult: 'success',
                mode: 'unexpected',
                reuse: 'false',
                releaseResult: 'skipped',
                publicationResult: 'skipped',
                rtcObservationResult: 'skipped',
                gamesResult: 'skipped'
            })
        ).toContain('validation mode must be broad, reuse, or rtc-observation');
    });

    it('fails an invalid RTC observation change while all validation jobs remain skipped', () => {
        expect(
            validateBranchReleaseConclusion({
                governanceResult: 'success',
                selectionResult: 'success',
                mode: 'invalid-rtc-observation',
                reuse: 'false',
                releaseResult: 'skipped',
                publicationResult: 'skipped',
                rtcObservationResult: 'skipped',
                gamesResult: 'skipped'
            })
        ).toEqual(['RTC observation store change is not an exact verified append']);
    });
});
