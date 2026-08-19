import { describe, expect, it } from 'vitest';

import { validateBranchReleaseConclusion } from '../../../../scripts/validation-evidence/branch-release-result.mjs';

describe('Branch Release Gate result', () => {
  // A superseded run cancels its jobs, leaving their outputs empty. The conclusion must name that
  // rather than reporting the chain of derived failures an empty reuse decision would produce.
  it.each([
    ['governance', 'cancelled', 'cancelled', 'skipped', 'cancelled'],
    ['release', 'success', 'success', 'cancelled', 'cancelled'],
  ])(
    'reports a cancelled %s run as cancelled, not as a failure',
    (_name, governanceResult, selectionResult, releaseResult, publicationResult) => {
      const issues = validateBranchReleaseConclusion({
        governanceResult,
        selectionResult,
        reuse: '',
        releaseResult,
        publicationResult,
      });

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('run cancelled before it could conclude');
      expect(issues[0]).toContain('a superseding run decides this branch');
      expect(issues[0]).not.toContain('reuse decision must be true or false');
    },
  );

  it.each([
    ['fresh validation', 'false', 'success', 'success'],
    ['same-PR content reuse', 'true', 'skipped', 'skipped'],
  ])('accepts successful %s', (_name, reuse, releaseResult, publicationResult) => {
    expect(
      validateBranchReleaseConclusion({
        governanceResult: 'success',
        selectionResult: 'success',
        reuse,
        releaseResult,
        publicationResult,
      }),
    ).toEqual([]);
  });

  it('rejects every failed constituent without an external deviation', () => {
    expect(
      validateBranchReleaseConclusion({
        governanceResult: 'failure',
        selectionResult: 'failure',
        reuse: 'false',
        releaseResult: 'failure',
        publicationResult: 'failure',
      }),
    ).toEqual([
      'Governance Gate did not succeed',
      'validation-evidence selection did not succeed',
      'broad Release Gate did not succeed',
      'fresh validation evidence was not published',
    ]);
  });
});
