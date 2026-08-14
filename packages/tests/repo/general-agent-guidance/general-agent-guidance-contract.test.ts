import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const deliveryGuidancePaths = [
  'AGENTS.md',
  '.agents/skills/adaptive-plan-execution/SKILL.md',
  '.agents/skills/organizing-repository-structure/SKILL.md',
  '.agents/skills/publishing-plan-progress/SKILL.md',
  '.agents/skills/rallar-code-writing/SKILL.md',
  '.agents/skills/rallar-testing/SKILL.md',
  '.agents/skills/rallar-testing/references/test-commands.md',
] as const;

describe('general agent guidance routing', () => {
  it('uses the pull request as the remote delivery entity', () => {
    const agents = normalize(readRepo('AGENTS.md'));
    const adaptive = normalize(readRepo('.agents/skills/adaptive-plan-execution/SKILL.md'));
    const publishing = normalize(readRepo('.agents/skills/publishing-plan-progress/SKILL.md'));

    expect(agents).toContain('The GitHub pull request is the remote delivery entity.');
    expect(adaptive).toContain('Keep at most the next two independently testable slices concrete.');
    expect(adaptive).toContain('Base-branch movement alone is not work.');
    expect(publishing).toContain('npm run pr:delivery -- status');
    expect(publishing).toContain('before broad final validation');
    expect(publishing).toContain('npm run pr:delivery -- ready');
    expect(publishing).toContain('`DONE` permits no post-merge governance work');
  });

  it('does not route ordinary delivery through tracked governance bookkeeping', () => {
    const sources = Object.fromEntries(
      deliveryGuidancePaths.map((repositoryPath) => [repositoryPath, readRepo(repositoryPath)]),
    );

    for (const [repositoryPath, source] of Object.entries(sources)) {
      expect(source, repositoryPath).not.toContain('npm run plan:adapt');
      expect(source, repositoryPath).not.toContain('plan-adaptation-v1');
      expect(source, repositoryPath).not.toContain('PR Human Review Record');
      expect(source, repositoryPath).not.toContain('build-affecting tree digest');
      expect(source, repositoryPath).not.toMatch(/close(?:d|) plan|closure receipt/iu);
    }
  });

  it('detects real conflicts before validation and ignores harmless base movement', () => {
    const adaptive = normalize(readRepo('.agents/skills/adaptive-plan-execution/SKILL.md'));
    const publishing = normalize(readRepo('.agents/skills/publishing-plan-progress/SKILL.md'));

    expect(adaptive).toContain('`REPAIR_CONFLICT`');
    expect(adaptive).toContain('`BEHIND`');
    expect(publishing).toContain('`REPAIR_CONFLICT`');
    expect(publishing).toContain('Do not update the branch, merge `main`, or rebase');
  });

  it('preserves default-branch safety, meaningful legacy review, and high-risk proofs', () => {
    const agents = normalize(readRepo('AGENTS.md'));
    const testing = normalize(readRepo('.agents/skills/rallar-testing/SKILL.md'));
    const testCommands = normalize(
      readRepo('.agents/skills/rallar-testing/references/test-commands.md'),
    );

    expectAll(agents, [
      'No AI or agent may create or place a commit on `main`',
      'No AI or agent may push `main`',
      'Retained production legacy',
      'Report commands that passed, failed, or were skipped',
    ]);
    expect(readRepo('AGENTS.md')).toContain(
      '- Every final handoff ends with a Markdown\n' +
        '  `### Commands executed and what they taught us` section.',
    );
    expectAll(testing, [
      'test:api-v1:black-box:postgres:medium-scale',
      'test:api-v1:black-box:postgres:topology-replay',
      'perf:api-v1:state-write',
      'UI Behavior Rule',
    ]);
    expectAll(testCommands, [
      'test:api-v1:black-box:postgres:medium-scale',
      'test:api-v1:black-box:postgres:topology-replay',
      'perf:api-v1:state-write',
      'UI Workflow Testing',
    ]);
  });

  it('keeps authenticated exception authority separate from pull request completion', () => {
    const agents = normalize(readRepo('AGENTS.md'));

    expect(agents).toContain(
      'Authenticated governance exceptions are separate from ordinary pull request delivery',
    );
    expect(agents).toContain('cannot be used as pull request completion evidence');
  });
});

function readRepo(repositoryPath: string): string {
  return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}
