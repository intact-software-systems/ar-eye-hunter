import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

  it('skips excluded symlink nodes before authored-path inspection', () => {
    const fixture = createRepositoryFixture();
    const outsideFile = path.join(fixture.root, 'outside-generated.ts');
    const outsideDirectory = path.join(fixture.root, 'outside-generated-directory');
    writeFileSync(outsideFile, 'export const outside = true;\n');
    mkdirSync(outsideDirectory);
    writeFileSync(path.join(outsideDirectory, 'module.ts'), 'export const outside = true;\n');
    for (const excludedDirectory of ['node_modules', 'dist', '.cache']) {
      symlinkSync(outsideDirectory, path.join(fixture.root, `apps/example/${excludedDirectory}`));
    }
    symlinkSync(outsideFile, path.join(fixture.root, 'apps/example/vite.config.ts'));
    symlinkSync(outsideFile, path.join(fixture.root, 'apps/example/value.generated.ts'));

    const result = runChecker(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
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

  it('uses authenticated gh API review lookup only for a nonempty exception registry', () => {
    const fixture = createRepositoryFixture();
    const fakeGitHub = createFakeGitHub(fixture.root);

    const noRegistryResult = runChecker(fixture, {
      environment: fakeGitHub.environment,
    });
    expect(noRegistryResult.status, noRegistryResult.stderr).toBe(0);
    expect(existsSync(fakeGitHub.logPath)).toBe(false);

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
                pullNumber: 42,
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
    const review = trustedReview(candidateHead);
    const environment = {
      ...fakeGitHub.environment,
      FAKE_GH_REVIEW: JSON.stringify(review),
    };

    const callerEvidenceResult = runChecker(fixture, {
      environment,
      extraArgs: ['--trusted-exception-reviews', 'caller-selected.json'],
    });
    expect(callerEvidenceResult.status).toBe(2);
    expect(callerEvidenceResult.stderr).toContain(
      'usage: node scripts/repo-structure-check.mjs [--base <git-ref>]',
    );
    expect(existsSync(fakeGitHub.logPath)).toBe(false);

    const failedLookup = runChecker(fixture, {
      environment: { ...environment, FAKE_GH_MODE: 'fail' },
    });
    expect(failedLookup.status).toBe(1);
    expect(failedLookup.stdout).toContain('authenticated GitHub review lookup failed');

    const malformedLookup = runChecker(fixture, {
      environment: { ...environment, FAKE_GH_MODE: 'malformed' },
    });
    expect(malformedLookup.status).toBe(1);
    expect(malformedLookup.stdout).toContain(
      'authenticated GitHub review lookup returned malformed evidence',
    );

    const result = runChecker(fixture, { environment });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = readFileSync(fakeGitHub.logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.at(-2)).toEqual([
      'api',
      '--method',
      'GET',
      'repos/example/repository/pulls/42/reviews/100',
    ]);
    expect(calls.at(-1)).toEqual([
      'api',
      '--method',
      'GET',
      '--paginate',
      '--slurp',
      'repos/example/repository/pulls/42/reviews',
    ]);

    writeFixture(
      fixture.root,
      'apps/approved-singleton/entry.ts',
      'export const approvedValue = false;\n',
    );
    const dirtyCandidateResult = runChecker(fixture, { environment });
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

function trustedReview(candidateHead: string): Record<string, unknown> {
  return {
    id: 100,
    state: 'APPROVED',
    commit_id: candidateHead,
    submitted_at: '2026-08-12T10:00:00Z',
    user: { type: 'User', login: 'fixture-human' },
    author_association: 'MEMBER',
    body: validReviewBody(candidateHead),
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

function createFakeGitHub(root: string) {
  const binPath = path.join(root, 'fake-bin');
  const logPath = path.join(root, 'fake-gh-calls.jsonl');
  mkdirSync(binPath);
  const executablePath = path.join(binPath, 'gh');
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_GH_MODE === 'fail') process.exit(1);
if (process.env.FAKE_GH_MODE === 'malformed') {
  process.stdout.write('{broken');
  process.exit(0);
}
const review = JSON.parse(process.env.FAKE_GH_REVIEW);
process.stdout.write(JSON.stringify(args.at(-1).endsWith('/reviews/100') ? review : [[review]]));
`,
  );
  chmodSync(executablePath, 0o755);
  return {
    logPath,
    environment: {
      PATH: `${binPath}:${process.env.PATH}`,
      FAKE_GH_LOG: logPath,
    },
  };
}
