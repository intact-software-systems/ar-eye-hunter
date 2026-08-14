import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCurrentPlanContext } from '../../../../scripts/pr-human-review/review-freshness.mjs';

const repoRoot = process.cwd();
const validatorPath = path.join(repoRoot, 'scripts/pr-human-review.mjs');
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('PR human review CLI', () => {
  it('reads current plan and build-tree evidence from Git for a v2 draft', () => {
    const fixture = createFixture();

    const result = runValidator(fixture);

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: PR Human Review Record v2 evidence is current');
  });

  it('rejects an existing v1 body on its next synchronization', () => {
    const fixture = createFixture();
    writeFileSync(
      path.join(fixture.root, 'body.md'),
      ['```pr-human-review-record-v1', '{"version":1}', '```'].join('\n'),
    );

    const result = runValidator(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'PR Human Review Record v2 must contain exactly one metadata fence',
    );
  });

  it('rejects a body that names a different plan than the supplied plan evidence', () => {
    const fixture = createFixture();
    const bodyPath = path.join(fixture.root, 'body.md');
    const body = execFileSync('sed', ['s#plans/example-plan.md#plans/other-plan.md#g', bodyPath], {
      encoding: 'utf8',
    });
    writeFileSync(bodyPath, body);

    const result = runValidator(fixture);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      'review adaptive plan path must match the supplied plan evidence',
    );
  });
});

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-human-review-cli-'));
  fixtureRoots.push(root);
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'PR Review CLI Test']);
  runGit(root, ['config', 'user.email', 'pr-review-cli@example.invalid']);
  writeFixture(root, 'README.md', 'base\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'base']);
  const mergeBaseSha = runGit(root, ['rev-parse', 'HEAD']).trim();
  const planSource = adaptivePlan();
  writeFixture(root, 'plans/example-plan.md', planSource);
  writeFixture(root, 'scripts/example.mjs', 'export const example = true;\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'candidate']);
  const headSha = runGit(root, ['rev-parse', 'HEAD']).trim();
  const plan = readCurrentPlanContext({ path: 'plans/example-plan.md', source: planSource });
  writeFixture(root, 'body.md', draftBody({ mergeBaseSha, headSha, planDigest: plan.digest }));
  writeFixture(root, 'changed-paths.txt', 'plans/example-plan.md\nscripts/example.mjs\n');
  writeFixture(root, 'registry.md', '# Production Legacy Exception Registry\n');
  writeFixture(root, 'reviews.json', '[]\n');
  return { root, mergeBaseSha, headSha };
}

function runValidator(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(
    process.execPath,
    [
      validatorPath,
      '--body',
      'body.md',
      '--changed-paths',
      'changed-paths.txt',
      '--registry',
      'registry.md',
      '--reviews',
      'reviews.json',
      '--merge-base',
      fixture.mergeBaseSha,
      '--head',
      fixture.headSha,
      '--draft',
      'true',
      '--pr-author',
      'pull-request-author',
      '--plan',
      'plans/example-plan.md',
    ],
    { cwd: fixture.root, encoding: 'utf8' },
  );
}

function adaptivePlan(): string {
  const record = {
    version: 1,
    status: 'active',
    goal: 'Keep the change reviewable.',
    acceptanceCriteria: ['The capability owner is recoverable.'],
    capabilities: [{ owner: 'example', entry: 'scripts/example.mjs' }],
    architecture: { intendedHypothesis: 'One command owns the reviewable result.' },
    checkpoint: {
      structure: 'Keep one direct example owner.',
      nextSlices: ['example-slice'],
    },
  };
  return ['# Plan', '```plan-adaptation-v1', JSON.stringify(record, null, 2), '```'].join('\n');
}

function draftBody(input: {
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly planDigest: string;
}): string {
  const initialReview = {
    status: 'complete',
    reviewer: 'Fresh reviewer',
    independence: 'separate-agent-or-human',
    adaptivePlanDigest: input.planDigest,
    mergeBaseSha: input.mergeBaseSha,
    headSha: input.headSha,
    goal: 'Keep the change reviewable.',
    acceptanceCriteria: ['The capability owner is recoverable.'],
    capabilityTreeHypothesis: 'One command owns the reviewable result.',
    canonicalOwnerEntries: [{ owner: 'example', entry: 'scripts/example.mjs' }],
    firstSlices: ['example-slice'],
    completeFindings: 'No Critical or Important findings remain.',
    automationGaps: 'Automation cannot approve semantic quality.',
    unresolvedFindings: { critical: 0, important: 0 },
    verdict: 'pass',
    legacy: { candidateCount: 0, items: [] },
  };
  const record = {
    version: 2,
    scope: 'code-changing',
    exemption: null,
    plan: { path: 'plans/example-plan.md' },
    initialReview,
    checkpointReview: { adaptivePlanDigest: input.planDigest },
    finalReview: null,
    retainedLegacy: [],
  };
  return [
    '## PR Human Review Record v2',
    '### Initial architecture review',
    '- Record status: complete',
    '- Reviewer and independence (separate agent or human): Fresh reviewer — separate-agent-or-human',
    `- Reviewed adaptive-plan digest: ${input.planDigest}`,
    '- Goal: Keep the change reviewable.',
    '- Acceptance criteria: ["The capability owner is recoverable."]',
    '- Capability-tree hypothesis: One command owns the reviewable result.',
    '- Canonical owners and entries: [{"owner":"example","entry":"scripts/example.mjs"}]',
    '- First two slices: ["example-slice"]',
    '- Complete review findings and resolution/status: No Critical or Important findings remain.',
    '- Behavior and judgment not proven by automation: Automation cannot approve semantic quality.',
    '- Legacy candidate count: 0',
    '- Legacy ledger and dispositions: []',
    '- Critical findings unresolved: 0',
    '- Important findings unresolved: 0',
    '- Verdict: pass',
    '### Current checkpoint review',
    `- Current adaptive-plan digest: ${input.planDigest}`,
    '### Complete code, structure, tests, and legacy review',
    '```pr-human-review-record-v2',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
