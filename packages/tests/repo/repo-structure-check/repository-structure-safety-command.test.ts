import { chmodSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupRepositoryFixtures,
  createRecord,
  createRepositoryFixture,
  fixtureScripts,
  recordBlock,
  runChecker,
  runGit,
  writeFixture,
  writePlanRecord,
} from './repository-structure-command-fixture.ts';

afterEach(cleanupRepositoryFixtures);

describe('repository structure command safety', () => {
  it('requires exactly one schema-valid active record with a diff base', () => {
    const fixture = createRepositoryFixture();

    writeFixture(fixture.root, 'plans/fixture-plan.md', '# No adaptive record\n');
    const zeroResult = runChecker(fixture);
    expect(zeroResult.status).toBe(2);
    expect(zeroResult.stderr).toContain('repository structure requires exactly one active plan');

    writeFixture(
      fixture.root,
      'plans/fixture-plan.md',
      '# Malformed\n\n```plan-adaptation-v1\n{broken}\n```\n',
    );
    const malformedResult = runChecker(fixture);
    expect(malformedResult.status).toBe(2);
    expect(malformedResult.stderr).toContain('contains invalid JSON');

    writePlanRecord(fixture.root, createRecord());
    const secondRecord = { ...createRecord(), planId: 'second-plan' };
    writeFixture(
      fixture.root,
      'plans/second-plan.md',
      `# Second plan\n\n${recordBlock(secondRecord)}\n`,
    );
    const multipleResult = runChecker(fixture);
    expect(multipleResult.status).toBe(2);
    expect(multipleResult.stderr).toContain(
      'repository structure requires exactly one active plan',
    );
    rmSync(path.join(fixture.root, 'plans/second-plan.md'));

    const missingBaseRecord = createRecord();
    delete (missingBaseRecord.facts as Record<string, unknown>).diffBase;
    writeFixture(
      fixture.root,
      'plans/fixture-plan.md',
      `# Fixture plan\n\n${recordBlock(missingBaseRecord)}\n`,
    );
    const missingBaseResult = runChecker(fixture);
    expect(missingBaseResult.status).toBe(2);
    expect(missingBaseResult.stderr).toContain('record.facts.diffBase must be a non-empty string');
  });

  it('fails closed on authored symlinks and unreadable directories without following them', () => {
    const fixture = createRepositoryFixture();
    const outsideFile = path.join(fixture.root, 'outside.ts');
    const outsideDirectory = path.join(fixture.root, 'outside-directory');
    writeFileSync(outsideFile, 'export const outside = true;\n');
    mkdirSync(outsideDirectory);
    writeFileSync(path.join(outsideDirectory, 'module.ts'), 'export const outside = true;\n');

    const symlinkedFile = path.join(fixture.root, 'apps/symlinked.ts');
    symlinkSync(outsideFile, symlinkedFile);
    const fileResult = runChecker(fixture);
    expect(fileResult.status).toBe(2);
    expect(fileResult.stderr).toContain(
      'authored code path apps/symlinked.ts must not be a symlink',
    );
    unlinkSync(symlinkedFile);

    const symlinkedDirectory = path.join(fixture.root, 'apps/symlinked-directory');
    symlinkSync(outsideDirectory, symlinkedDirectory);
    const directoryResult = runChecker(fixture);
    expect(directoryResult.status).toBe(2);
    expect(directoryResult.stderr).toContain(
      'authored code path apps/symlinked-directory must not be a symlink',
    );
    unlinkSync(symlinkedDirectory);

    const unreadableDirectory = path.join(fixture.root, 'apps/example');
    chmodSync(unreadableDirectory, 0o000);
    const unreadableResult = runChecker(fixture);
    chmodSync(unreadableDirectory, 0o755);
    expect(unreadableResult.status).toBe(2);
    expect(unreadableResult.stderr).toContain(
      'authored code directory apps/example is not readable',
    );
  });

  it('trusts only GitHub review evidence bound to the exact singleton and candidate', () => {
    const fixture = createRepositoryFixture();
    writeFixture(
      fixture.root,
      'apps/approved-singleton/entry.ts',
      'export const approvedValue = true;\n',
    );
    writeFixture(
      fixture.root,
      'docs/repo-structure-exceptions.json',
      `${JSON.stringify(
        {
          version: 2,
          exceptions: [
            {
              ruleId: 'topology.singleton-subtree',
              target: 'apps/approved-singleton',
              owner: 'Repository maintainers',
              reviewOrRemovalCondition: 'Review when the public integration gains another module.',
              approval: {
                reviewId: 100,
                reviewerLogin: 'fixture-human',
                approvedAt: '2026-08-12T10:00:00Z',
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    runGit(fixture.root, [
      'add',
      'apps/approved-singleton/entry.ts',
      'docs/repo-structure-exceptions.json',
    ]);
    runGit(fixture.root, ['commit', '--quiet', '-m', 'candidate singleton']);
    const candidateHead = runGit(fixture.root, ['rev-parse', 'HEAD']).trim();
    const validEvidence = trustedExceptionEvidence(candidateHead);
    const invalidCases = [
      { label: 'missing trusted input', evidence: undefined },
      { label: 'missing review ID', evidence: { ...validEvidence, reviews: [] } },
      {
        label: 'mismatched repository',
        evidence: { ...validEvidence, repository: 'forged/repository' },
      },
      {
        label: 'mismatched reviewer',
        evidence: withReview(validEvidence, { user: { type: 'User', login: 'other-human' } }),
      },
      {
        label: 'mismatched head',
        evidence: withReview(
          { ...validEvidence, candidateHead: 'f'.repeat(40) },
          { commit_id: 'f'.repeat(40) },
        ),
      },
      {
        label: 'mismatched target',
        evidence: withReview(validEvidence, {
          body: validReviewBody(candidateHead).replace(
            'target: apps/approved-singleton',
            'target: apps/other-singleton',
          ),
        }),
      },
      {
        label: 'unapproved state',
        evidence: withReview(validEvidence, { state: 'CHANGES_REQUESTED' }),
      },
    ];
    for (const invalidCase of invalidCases) {
      const evidencePath = invalidCase.evidence
        ? writeTrustedEvidence(fixture.root, invalidCase.evidence)
        : undefined;
      const result = runChecker(fixture, { evidencePath });
      expect(result.status, `${invalidCase.label}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.stdout).toContain('apps/approved-singleton [topology.singleton-subtree]');
    }

    const evidencePath = writeTrustedEvidence(fixture.root, validEvidence);
    const result = runChecker(fixture, { evidencePath });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    writeFixture(
      fixture.root,
      'apps/approved-singleton/entry.ts',
      'export const approvedValue = false;\n',
    );
    const dirtyCandidateResult = runChecker(fixture, { evidencePath });
    expect(
      dirtyCandidateResult.status,
      `${dirtyCandidateResult.stdout}\n${dirtyCandidateResult.stderr}`,
    ).not.toBe(0);
    expect(dirtyCandidateResult.stdout).toContain(
      'trusted GitHub review does not cover dirty candidate paths',
    );
  });

  it('enforces active-plan declaration reality through the command boundary', () => {
    const fixture = createRepositoryFixture();
    writeFixture(fixture.root, 'scripts/other.mjs', 'export function otherEntry() {}\n');
    writeFixture(
      fixture.root,
      'packages/not-tests/example/helper.ts',
      'export const helper = 1;\n',
    );
    writeFixture(
      fixture.root,
      'package.json',
      JSON.stringify({
        scripts: {
          ...fixtureScripts(),
          'test:fake-example': 'vitest run packages/not-tests/example',
        },
      }),
    );
    const invalidRecord = createRecord();
    invalidRecord.capabilities[0] = {
      ...invalidRecord.capabilities[0],
      entry: 'scripts/other.mjs',
      testRoot: 'packages/not-tests/example',
      focusedCommand: 'npm run test:fake-example',
      controlFlowFamilies: ['scan', 'classify', 'report'],
    };
    invalidRecord.coldNavigationEvidence = {
      status: 'passed',
      summary: 'The probe names a missing top-level owner.',
      probes: [
        {
          capabilityOwner: 'example capability',
          path: 'scripts/example/first.mjs',
          symbol: 'missingOwner',
        },
      ],
    };
    writePlanRecord(fixture.root, invalidRecord);

    const result = runChecker(fixture);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(
      'entry scripts/other.mjs must be inside scripts/example or its exact thin sibling entry',
    );
    expect(result.stdout).toContain('must use a recognized mirrored test hierarchy');
    expect(result.stdout).toContain('contains no authored .test/.spec modules');
    expect(result.stdout).toContain('requires a navigation map');
    expect(result.stdout).toContain(
      'cold-navigation probe symbol missingOwner is not a navigable top-level owner',
    );
  });
});

function trustedExceptionEvidence(candidateHead: string): TrustedEvidenceFixture {
  return {
    version: 2,
    repository: 'example/repository',
    candidateHead,
    reviews: [
      {
        id: 100,
        state: 'APPROVED',
        commit_id: candidateHead,
        submitted_at: '2026-08-12T10:00:00Z',
        user: { type: 'User', login: 'fixture-human' },
        author_association: 'MEMBER',
        body: validReviewBody(candidateHead),
      },
    ],
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

function withReview(
  evidence: TrustedEvidenceFixture,
  reviewPatch: Record<string, unknown>,
): TrustedEvidenceFixture {
  return { ...evidence, reviews: [{ ...evidence.reviews[0], ...reviewPatch }] };
}

type TrustedEvidenceFixture = Record<string, unknown> & {
  readonly reviews: readonly Record<string, unknown>[];
};

function writeTrustedEvidence(root: string, evidence: Record<string, unknown>): string {
  const file = path.join(root, 'trusted-exception-reviews.json');
  writeFileSync(file, JSON.stringify(evidence));
  return file;
}
