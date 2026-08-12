import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readStructureExceptions } from '../../../../scripts/repo-structure-check/structure-exceptions.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('repository structure singleton exceptions', () => {
  it('looks up the registry review from its origin-derived repository, pull, and review IDs', () => {
    const root = createRegistry(approval());
    const lookupInputs: Array<Record<string, unknown>> = [];
    const reviewLookup = (input: Record<string, unknown>) => {
      lookupInputs.push(input);
      return trustedReviews(root);
    };

    const result = readStructureExceptions(root, { reviewLookup });

    expect(result.issues).toEqual([]);
    expect(result.exceptions).toHaveLength(1);
    expect(lookupInputs).toEqual([
      {
        repoRoot: root,
        repository: 'example/repository',
        pullNumber: 42,
        reviewId: 100,
      },
    ]);
  });

  it('accepts only an approved named-human review bound to repository, head, rule, and target', () => {
    const root = createRegistry(approval());
    const result = readStructureExceptions(root, {
      reviewLookup: () => trustedReviews(root),
    });

    expect(result.issues).toEqual([]);
    expect(result.exceptions).toHaveLength(1);

    const mismatchedRuleEvidence = trustedReviews(root);
    mismatchedRuleEvidence.review.body = String(mismatchedRuleEvidence.review.body).replace(
      'rule: topology.singleton-subtree',
      'rule: topology.redundant-chain',
    );
    const mismatch = readStructureExceptions(root, {
      reviewLookup: () => mismatchedRuleEvidence,
    });
    expect(mismatch.exceptions).toEqual([]);
    expect(mismatch.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] trusted GitHub review does not bind ' +
        'the exact rule and target',
    );
  });

  it('rejects an approval superseded by a later substantive review from the same human', () => {
    const root = createRegistry(approval());
    const evidence = trustedReviews(root);
    evidence.reviews.push({
      id: 101,
      state: 'CHANGES_REQUESTED',
      commit_id: 'a'.repeat(40),
      submitted_at: '2026-08-12T11:00:00Z',
      user: { type: 'User', login: 'fixture-human' },
      author_association: 'MEMBER',
      body: 'The exception needs another review.',
    });

    const result = readStructureExceptions(root, {
      reviewLookup: () => evidence,
    });

    expect(result.exceptions).toEqual([]);
    expect(result.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] trusted GitHub approval is superseded',
    );
  });

  it('rejects mismatched review identity, state, association, head, and body bindings', () => {
    const root = createRegistry(approval());
    const candidateHead = runGit(root, ['rev-parse', 'HEAD']).trim();
    const cases = [
      { user: { type: 'User', login: 'other-human' } },
      { state: 'CHANGES_REQUESTED' },
      { author_association: 'CONTRIBUTOR' },
      { commit_id: 'f'.repeat(40) },
      {
        body: validReviewBody(candidateHead).replace(
          'repository: example/repository',
          'repository: forged/repository',
        ),
      },
      {
        body: validReviewBody(candidateHead).replace(
          'target: apps/approved-singleton',
          'target: apps/other-singleton',
        ),
      },
    ];

    for (const reviewPatch of cases) {
      const evidence = trustedReviews(root);
      evidence.review = { ...evidence.review, ...reviewPatch };
      evidence.reviews = [evidence.review];
      const result = readStructureExceptions(root, { reviewLookup: () => evidence });
      expect(result.exceptions, JSON.stringify(reviewPatch)).toEqual([]);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('fails closed when authenticated review lookup fails or returns malformed evidence', () => {
    const root = createRegistry(approval());

    const failed = readStructureExceptions(root, {
      reviewLookup: () => {
        throw new Error('credential details must not escape');
      },
    });
    expect(failed.exceptions).toEqual([]);
    expect(failed.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] authenticated GitHub review lookup failed',
    );

    const malformed = readStructureExceptions(root, {
      reviewLookup: () => ({ review: null, reviews: 'not-an-array' }),
    });
    expect(malformed.exceptions).toEqual([]);
    expect(malformed.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] authenticated GitHub review lookup returned malformed evidence',
    );

    const malformedReviewShape = readStructureExceptions(root, {
      reviewLookup: () => ({ review: {}, reviews: [{}] }),
    });
    expect(malformedReviewShape.exceptions).toEqual([]);
    expect(malformedReviewShape.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] authenticated GitHub review lookup returned malformed evidence',
    );
  });

  it('does not require GitHub or invoke review lookup for an empty registry', () => {
    const root = createRegistry(undefined);

    const result = readStructureExceptions(root, {
      reviewLookup: () => {
        throw new Error('empty registry must not look up reviews');
      },
    });

    expect(result).toEqual({ exceptions: [], issues: [] });
  });

  it('does not follow a symlinked exception registry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
    fixtureRoots.push(root);
    const outside = path.join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ version: 2, exceptions: [] }));
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    symlinkSync(outside, path.join(root, 'docs/repo-structure-exceptions.json'));

    expect(() => readStructureExceptions(root)).toThrow(
      'repository structure exception registry must be a confined regular file',
    );

    unlinkRegistry(root);
    symlinkSync(
      path.join(root, 'missing.json'),
      path.join(root, 'docs/repo-structure-exceptions.json'),
    );
    expect(() => readStructureExceptions(root)).toThrow(
      'repository structure exception registry must be a confined regular file',
    );
  });
});

function createRegistry(approval: Record<string, unknown> | undefined): string {
  const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
  fixtureRoots.push(root);
  const file = path.join(root, 'docs/repo-structure-exceptions.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      exceptions:
        approval === undefined
          ? []
          : [
              {
                ruleId: 'topology.singleton-subtree',
                target: 'apps/approved-singleton',
                owner: 'Repository maintainers',
                reviewOrRemovalCondition: 'Review when another module is required.',
                approval,
              },
            ],
    }),
  );
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['remote', 'add', 'origin', 'git@github.com:example/repository.git']);
  runGit(root, ['add', 'docs/repo-structure-exceptions.json']);
  runGit(root, ['commit', '--quiet', '-m', 'registry candidate']);
  return root;
}

function approval(): Record<string, unknown> {
  return {
    pullNumber: 42,
    reviewId: 100,
    reviewerLogin: 'fixture-human',
    approvedAt: '2026-08-12T10:00:00Z',
  };
}

function trustedReviews(root: string): TrustedReviewsFixture {
  const candidateHead = runGit(root, ['rev-parse', 'HEAD']).trim();
  const review = {
    id: 100,
    state: 'APPROVED',
    commit_id: candidateHead,
    submitted_at: '2026-08-12T10:00:00Z',
    user: { type: 'User', login: 'fixture-human' },
    author_association: 'MEMBER',
    body: [
      'REPOSITORY-STRUCTURE-EXCEPTION v2',
      'repository: example/repository',
      `candidate-head: ${candidateHead}`,
      'rule: topology.singleton-subtree',
      'target: apps/approved-singleton',
    ].join('\n'),
  };
  return {
    review,
    reviews: [review],
  };
}

function validReviewBody(candidateHead: string): string {
  return [
    'REPOSITORY-STRUCTURE-EXCEPTION v2',
    'repository: example/repository',
    `candidate-head: ${candidateHead}`,
    'rule: topology.singleton-subtree',
    'target: apps/approved-singleton',
  ].join('\n');
}

type TrustedReviewsFixture = {
  review: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
};

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function unlinkRegistry(root: string): void {
  rmSync(path.join(root, 'docs/repo-structure-exceptions.json'));
}
