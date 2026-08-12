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
  it('requires runner-supplied trusted GitHub review evidence', () => {
    const root = createRegistry(approval());

    const result = readStructureExceptions(root);

    expect(result.exceptions).toEqual([]);
    expect(result.issues[0]).toContain('trusted GitHub review evidence is required');
  });

  it('accepts only an approved named-human review bound to repository, head, rule, and target', () => {
    const root = createRegistry(approval());
    const result = readStructureExceptions(root, { trustedEvidence: trustedEvidence(root) });

    expect(result.issues).toEqual([]);
    expect(result.exceptions).toHaveLength(1);

    const mismatchedRuleEvidence = trustedEvidence(root);
    mismatchedRuleEvidence.reviews[0].body = String(mismatchedRuleEvidence.reviews[0].body).replace(
      'rule: topology.singleton-subtree',
      'rule: topology.redundant-chain',
    );
    const mismatch = readStructureExceptions(root, {
      trustedEvidence: mismatchedRuleEvidence,
    });
    expect(mismatch.exceptions).toEqual([]);
    expect(mismatch.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] trusted GitHub review does not bind ' +
        'the exact rule and target',
    );
  });

  it('rejects an approval superseded by a later substantive review from the same human', () => {
    const root = createRegistry(approval());
    const evidence = trustedEvidence(root);
    (evidence.reviews as Array<Record<string, unknown>>).push({
      id: 101,
      state: 'CHANGES_REQUESTED',
      commit_id: 'a'.repeat(40),
      submitted_at: '2026-08-12T11:00:00Z',
      user: { type: 'User', login: 'fixture-human' },
      author_association: 'MEMBER',
      body: 'The exception needs another review.',
    });

    const result = readStructureExceptions(root, {
      trustedEvidence: evidence,
    });

    expect(result.exceptions).toEqual([]);
    expect(result.issues).toContain(
      'docs/repo-structure-exceptions.json exceptions[0] trusted GitHub approval is superseded',
    );
  });

  it('does not follow a symlinked exception registry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
    fixtureRoots.push(root);
    const outside = path.join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ version: 2, exceptions: [] }));
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    symlinkSync(outside, path.join(root, 'docs/repo-structure-exceptions.json'));

    expect(() => readStructureExceptions(root, exceptionEvidenceInput())).toThrow(
      'repository structure exception registry must be a confined regular file',
    );

    unlinkRegistry(root);
    symlinkSync(
      path.join(root, 'missing.json'),
      path.join(root, 'docs/repo-structure-exceptions.json'),
    );
    expect(() => readStructureExceptions(root, exceptionEvidenceInput())).toThrow(
      'repository structure exception registry must be a confined regular file',
    );
  });
});

function createRegistry(approval: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'structure-exceptions-'));
  fixtureRoots.push(root);
  const file = path.join(root, 'docs/repo-structure-exceptions.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      exceptions: [
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
    reviewId: 100,
    reviewerLogin: 'fixture-human',
    approvedAt: '2026-08-12T10:00:00Z',
  };
}

function trustedEvidence(root: string): TrustedEvidenceFixture {
  const candidateHead = runGit(root, ['rev-parse', 'HEAD']).trim();
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
        body: [
          'REPOSITORY-STRUCTURE-EXCEPTION v2',
          'repository: example/repository',
          `candidate-head: ${candidateHead}`,
          'rule: topology.singleton-subtree',
          'target: apps/approved-singleton',
        ].join('\n'),
      },
    ],
  };
}

type TrustedEvidenceFixture = Record<string, unknown> & {
  readonly reviews: Array<Record<string, unknown>>;
};

function exceptionEvidenceInput(): Record<string, unknown> {
  return {
    trustedEvidence: trustedEvidence(),
    repository: 'example/repository',
    candidateHead: 'a'.repeat(40),
  };
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function unlinkRegistry(root: string): void {
  rmSync(path.join(root, 'docs/repo-structure-exceptions.json'));
}
