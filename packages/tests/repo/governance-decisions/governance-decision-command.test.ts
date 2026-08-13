import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSha256 } from '../../../../scripts/governance-decisions/canonical-json.mjs';
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
  it('decodes all five public command names with exact options', () => {
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
    expect(decodeGovernanceDecisionCommand(['publish-blob', '--file', 'plan.md'])).toEqual({
      command: 'publish-blob',
      path: 'plan.md',
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

  it('previews a deterministic local transition without mutating the repository', () => {
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
    const beforeStatus = runGit(fixture.root, ['status', '--short']);

    const preview = spawnSync(
      process.execPath,
      [commandPath, 'preview', '--request', requestPath, '--repo', fixture.root],
      { encoding: 'utf8' },
    );

    expect(preview.status).toBe(0);
    const transition = JSON.parse(preview.stdout);
    expect(transition.result).toEqual({ acceptanceStatus: 'not-achieved' });
    expect(transition.deletions).toEqual([fixture.planPath]);
    expect(runGit(fixture.root, ['status', '--short'])).toBe(beforeStatus);
  });

  it.each(['apply', 'publish-blob', 'publish-request'])(
    'fails %s at the one explicit trusted-publication boundary',
    (command) => {
      const arguments_ =
        command === 'publish-blob'
          ? [commandPath, command, '--file', 'plan.md']
          : [commandPath, command, '--request', 'request.json'];
      const result = spawnSync(process.execPath, arguments_, { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'trusted publication is not configured; authenticated publication belongs to Task 2',
      );
    },
  );

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
