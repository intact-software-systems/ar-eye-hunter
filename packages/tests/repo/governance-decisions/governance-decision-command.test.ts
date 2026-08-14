import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeSha256,
  toCanonicalJson,
} from '../../../../scripts/governance-decisions/canonical-json.mjs';
import { decodeGovernanceDecisionCommand } from '../../../../scripts/governance-decisions/governance-decision-command.mjs';
import { toGovernanceDecisionFixturePlanMarkdown } from './governance-decision-fixture';

const fixtureRoots: string[] = [];
const commandPath = path.resolve('scripts/governance-decisions.mjs');

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('governance decision command', () => {
  it('decodes the four current command names with exact options', () => {
    expect(
      decodeGovernanceDecisionCommand(['preview', '--request', 'request.json', '--repo', '/repo']),
    ).toEqual({ command: 'preview', requestPath: 'request.json', repoRoot: '/repo' });
    expect(
      decodeGovernanceDecisionCommand([
        'verify-commit',
        '--commit',
        '1'.repeat(40),
        '--repo',
        '/repo',
      ]),
    ).toEqual({
      command: 'verify-commit',
      commitOid: '1'.repeat(40),
      repoRoot: '/repo',
    });
    expect(decodeGovernanceDecisionCommand(['apply', '--request', 'request.json'])).toEqual({
      command: 'apply',
      requestPath: 'request.json',
      repoRoot: process.cwd(),
    });
    expect(
      decodeGovernanceDecisionCommand(['publish-request', '--request', 'request.json']),
    ).toEqual({
      command: 'publish-request',
      requestPath: 'request.json',
      repoRoot: process.cwd(),
    });
    expect(() => decodeGovernanceDecisionCommand(['preview', '--unknown', 'value'])).toThrow(
      'unsupported option: --unknown',
    );
  });

  it('rejects active plan mutations while historical verification remains available', () => {
    const fixture = createRepositoryFixture();
    const planContent = readFileSync(path.join(fixture.root, fixture.planPath));
    const requestPath = path.join(fixture.root, 'request.json');
    writeFileSync(
      requestPath,
      JSON.stringify({
        schemaVersion: 'governance-decision-request-v1',
        operation: 'plan.cancel',
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: fixture.headOid,
        force: true,
        reason: 'Administrator cancellation is required.',
        target: { planPath: fixture.planPath, planDigest: computeSha256(planContent) },
        payload: {},
      }),
    );
    const preview = spawnSync(
      process.execPath,
      [commandPath, 'preview', '--request', requestPath, '--repo', fixture.root],
      { encoding: 'utf8' },
    );

    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain('active plan governance operations are retired');
  });

  it.each([
    {
      operation: 'gate.accept-deviation',
      target: {
        workflowRunId: 81,
        runAttempt: 2,
        gateName: 'Governance Gate / Governance Gate',
        candidateSha: '2'.repeat(40),
      },
      payload: {},
    },
    toRepositoryStructureException(),
  ])('rejects retired ordinary-delivery operation $operation', ({ operation, target, payload }) => {
    const fixture = createRepositoryFixture();
    const requestPath = path.join(fixture.root, 'request.json');
    writeFileSync(
      requestPath,
      JSON.stringify({
        schemaVersion: 'governance-decision-request-v1',
        operation,
        repository: 'intact-software-systems/ar-eye-hunter',
        defaultBranch: 'main',
        expectedHeadOid: fixture.headOid,
        force: true,
        reason: 'Historical decoder compatibility test.',
        target,
        payload,
      }),
    );
    const preview = spawnSync(
      process.execPath,
      [commandPath, 'preview', '--request', requestPath, '--repo', fixture.root],
      { encoding: 'utf8' },
    );

    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain('ordinary pull request governance operations are retired');
  });

  it('keeps permanent fixtures independent from the disposable tactical plan', () => {
    const disposablePlanPath = ['plans/authenticated', 'governance-decisions-plan.md'].join('-');
    for (const testFile of [
      'governance-decision-command.test.ts',
      'governance-decision-commit-verification.test.ts',
      'governance-decision-transitions.test.ts',
    ]) {
      expect(readFileSync(path.join(import.meta.dirname, testFile), 'utf8')).not.toContain(
        disposablePlanPath,
      );
    }
  });
});

function createRepositoryFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'governance-command-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  const planPath = 'plans/authenticated-governance-decisions.md';
  writeFileSync(path.join(root, planPath), toGovernanceDecisionFixturePlanMarkdown());
  writeFileSync(path.join(root, 'plans/README.md'), '# Active adaptive plans\n\nBefore.\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-q', '-m', 'fixture']);
  return { root, planPath, headOid: runGit(root, ['rev-parse', 'HEAD']).trim() };
}

function runGit(root: string, arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
}

function toRepositoryStructureException() {
  const projection = {
    ruleId: 'topology.singleton-subtree',
    target: 'scripts/example',
    owner: 'Example maintainers',
    reviewOrRemovalCondition: 'Remove when another sibling owner exists.',
  };
  return {
    operation: 'exception.decide',
    target: {
      action: 'approve',
      exceptionKind: 'repository-structure',
      candidateHead: '2'.repeat(40),
      projectionSha256: computeSha256(toCanonicalJson(projection)),
    },
    payload: { projection },
  };
}
