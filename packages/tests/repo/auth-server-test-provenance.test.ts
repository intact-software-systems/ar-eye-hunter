import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  type ReviewedSourceSnapshot,
  authTestFinalOwnerSnapshot,
  authTestPredecessorSnapshot,
  authTestProvenanceBaseCommit,
  validateReviewedSourceSnapshot,
} from './auth-server-reviewed-source-snapshot.ts';

const repoRoot = process.cwd();
const expectedOwnerMappings = [
  [
    'packages/tests/shared-server/app-auth-conflict-inbox.test.ts',
    ['packages/tests/shared-server/auth/auth-ticket-conflict.test.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-inbox-service.test.ts',
    [
      'packages/tests/shared-server/auth/auth-command-and-result-codecs.test.ts',
      'packages/tests/shared-server/auth/auth-inbox-registration-and-routing.test.ts',
    ],
  ],
  [
    'packages/tests/shared-server/app-auth-inbox-test-harness.ts',
    ['packages/tests/shared-server/auth/auth-app-inbox-test-runtime.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-legacy-cutoff.test.ts',
    ['packages/tests/shared-server/auth/auth-legacy-cutoff.test.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-legacy-replay-inbox.test.ts',
    ['packages/tests/shared-server/auth/auth-legacy-replay.test.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-persistence-inbox.test.ts',
    ['packages/tests/shared-server/auth/auth-persistence-security.test.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-public-routing-inbox.test.ts',
    ['packages/tests/shared-server/auth/auth-public-command-routing.test.ts'],
  ],
  [
    'packages/tests/shared-server/app-auth-transaction-inbox.test.ts',
    ['packages/tests/shared-server/auth/auth-transaction-boundary.test.ts'],
  ],
  [
    'packages/tests/shared-server/auth-fixture.ts',
    ['packages/tests/shared-server/auth/auth-test-fixtures.ts'],
  ],
  [
    'packages/tests/shared-server/auth-login-service.test.ts',
    [
      'packages/tests/shared-server/auth/auth-credential-login.test.ts',
      'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts',
    ],
  ],
  [
    'packages/tests/shared-server/request-auth-service.test.ts',
    ['packages/tests/shared-server/auth/auth-request-proof.test.ts'],
  ],
] as const;
const expectedFinalOwnerCases = [
  ['packages/tests/shared-server/auth/auth-ticket-conflict.test.ts', 2],
  ['packages/tests/shared-server/auth/auth-command-and-result-codecs.test.ts', 2],
  ['packages/tests/shared-server/auth/auth-inbox-registration-and-routing.test.ts', 3],
  ['packages/tests/shared-server/auth/auth-app-inbox-test-runtime.ts', 0],
  ['packages/tests/shared-server/auth/auth-legacy-cutoff.test.ts', 3],
  ['packages/tests/shared-server/auth/auth-legacy-replay.test.ts', 3],
  ['packages/tests/shared-server/auth/auth-persistence-security.test.ts', 9],
  ['packages/tests/shared-server/auth/auth-public-command-routing.test.ts', 3],
  ['packages/tests/shared-server/auth/auth-transaction-boundary.test.ts', 3],
  ['packages/tests/shared-server/auth/auth-test-fixtures.ts', 0],
  ['packages/tests/shared-server/auth/auth-credential-login.test.ts', 5],
  ['packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts', 6],
  ['packages/tests/shared-server/auth/auth-request-proof.test.ts', 4],
] as const;

// Temporary PR C migration evidence owned by the auth child. Exact blobs are
// supplementary to the semantic suites. The later ledger may remove this only
// after PR C's resulting-main workflow publishes equivalent ownership evidence.
it('binds the exact predecessor-to-final-owner and case-count inventory', () => {
  expect(authTestProvenanceBaseCommit).toBe('8152de39faf2d630158143366596d61346e20457');
  expect(
    authTestPredecessorSnapshot.map(({ path: predecessorPath, finalOwners }) => [
      predecessorPath,
      finalOwners,
    ]),
  ).toEqual(expectedOwnerMappings);
  expect(
    authTestFinalOwnerSnapshot.map(({ path: ownerPath, caseCount }) => [ownerPath, caseCount]),
  ).toEqual(expectedFinalOwnerCases);

  const mappedOwners = new Set(
    authTestPredecessorSnapshot.flatMap(({ finalOwners }) => finalOwners),
  );
  expect([...mappedOwners]).toEqual(authTestFinalOwnerSnapshot.map(({ path }) => path));
  expect(authTestFinalOwnerSnapshot.reduce((total, owner) => total + owner.caseCount, 0)).toBe(43);
});

it('binds every predecessor to its exact base path, blob, and source bytes', () => {
  expect(readGit(['rev-parse', `${authTestProvenanceBaseCommit}^{commit}`])).toBe(
    authTestProvenanceBaseCommit,
  );
  for (const predecessor of authTestPredecessorSnapshot) {
    expect(
      readGit(['rev-parse', `${authTestProvenanceBaseCommit}:${predecessor.path}`]),
      predecessor.path,
    ).toBe(predecessor.blob);
  }

  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authTestPredecessorSnapshot,
      actualSources: readBaseSources(),
    }),
  ).toEqual([]);
});

it('binds every final owner and support file to its exact reviewed source bytes', () => {
  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authTestFinalOwnerSnapshot,
      actualSources: readWorktreeSources(authTestFinalOwnerSnapshot),
    }),
  ).toEqual([]);
});

it('rejects changed source bytes even when the path inventory is unchanged', () => {
  const actualSources = readWorktreeSources(authTestFinalOwnerSnapshot);
  const changed = authTestFinalOwnerSnapshot[0];
  actualSources.set(changed.path, `${actualSources.get(changed.path)}\n// changed`);

  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authTestFinalOwnerSnapshot,
      actualSources,
    }),
  ).toContainEqual(expect.stringContaining(`source.changed:${changed.path}`));
});

it('rejects a missing reviewed source', () => {
  const actualSources = readWorktreeSources(authTestFinalOwnerSnapshot);
  const missing = authTestFinalOwnerSnapshot[0];
  actualSources.delete(missing.path);

  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authTestFinalOwnerSnapshot,
      actualSources,
    }),
  ).toContain(`source.missing:${missing.path}`);
});

it('rejects an extra unreviewed source', () => {
  const actualSources = readWorktreeSources(authTestFinalOwnerSnapshot);
  const extraPath = 'packages/tests/shared-server/auth/unreviewed.test.ts';
  actualSources.set(extraPath, "it.todo('unreviewed');");

  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authTestFinalOwnerSnapshot,
      actualSources,
    }),
  ).toContain(`source.extra:${extraPath}`);
});

function readBaseSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const predecessor of authTestPredecessorSnapshot) {
    sources.set(
      predecessor.path,
      readGit(['show', `${authTestProvenanceBaseCommit}:${predecessor.path}`], false),
    );
  }
  return sources;
}

function readWorktreeSources(snapshots: readonly ReviewedSourceSnapshot[]): Map<string, string> {
  return new Map(
    snapshots.map((snapshot) => [
      snapshot.path,
      readFileSync(path.join(repoRoot, snapshot.path), 'utf8'),
    ]),
  );
}

function readGit(arguments_: readonly string[], trim = true): string {
  const output = execFileSync('git', arguments_, { encoding: 'utf8' });
  return trim ? output.trim() : output;
}
