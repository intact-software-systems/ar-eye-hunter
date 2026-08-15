import { describe, expect, it } from 'vitest';

import { validateBranchReleaseConclusion } from '../../../../scripts/validation-evidence/branch-release-result.mjs';

describe('Branch Release Gate result', () => {
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
