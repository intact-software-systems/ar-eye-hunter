import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, '.agents/skills');
const expectedSkills = [
  'adaptive-plan-execution',
  'building-rallar-apps',
  'organizing-repository-structure',
  'performance-analysis',
  'rallar-ai',
  'rallar-code-writing',
  'rallar-games',
  'rallar-hetzner-ops',
  'rallar-platform',
  'publishing-plan-progress',
  'rallar-realtime',
  'rallar-testing',
] as const;

describe('Rallar skill plugin and publication integrity', () => {
  it('uses one directly discoverable skill tree for the plugin', () => {
    const plugin = readJson('.codex-plugin/plugin.json') as {
      skills?: string;
      interface?: { defaultPrompt?: readonly string[] };
    };
    const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(plugin.skills).toBe('./.agents/skills/');
    expect(plugin.interface?.defaultPrompt?.length).toBeLessThanOrEqual(3);
    expect(skillDirectories).toEqual([...expectedSkills].sort());
    expect(existsSync(path.join(repoRoot, 'skills'))).toBe(false);
  });

  it('keeps skill frontmatter and local references valid', () => {
    for (const skillName of expectedSkills) {
      const skillPath = path.join(skillsRoot, skillName, 'SKILL.md');
      const source = readAbsolute(skillPath);
      const frontmatter = readFrontmatter(source, skillPath);

      expect(frontmatter.name, skillPath).toBe(skillName);
      expect(frontmatter.description.length, skillPath).toBeGreaterThan(20);
      expect(frontmatter.description, skillPath).toMatch(/^Use when\b/);

      for (const reference of source.matchAll(/`(references\/[a-z0-9./-]+\.md)`/g)) {
        expect(
          existsSync(path.join(skillsRoot, skillName, reference[1])),
          `${skillPath} -> ${reference[1]}`,
        ).toBe(true);
      }
    }
  });

  it('routes long-running written-plan execution to observable published progress', () => {
    const agents = readRepo('AGENTS.md');
    const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
    const normalizedAgents = normalizeWhitespace(agents);
    const normalizedProgressSkill = normalizeWhitespace(progressSkill);
    const plugin = readJson('.codex-plugin/plugin.json') as {
      keywords?: readonly string[];
      interface?: { defaultPrompt?: readonly string[]; longDescription?: string };
    };

    expectAll(agents, ['adaptive-plan-execution', 'publishing-plan-progress', 'publication']);
    expect(normalizedAgents).toContain(
      'Use `adaptive-plan-execution` for written or multi-slice plans, ' +
        '`organizing-repository-structure` for repository shape, `rallar-testing` for ' +
        'surface-specific commands, and `publishing-plan-progress` for publication.',
    );
    expectAll(normalizedAgents, [
      'No AI or agent may create or place a commit on `main`, `master`, or the local default branch',
      'permission immediately before the commit',
      'Each default-branch commit requires a new permission request and approval',
      'No AI or agent may push `main`, `master`, or the remote default branch',
      'the push is forced',
      'permission immediately before the push',
      'Each default-branch push requires a new permission request and approval',
      'Commit and push permissions are independent',
    ]);
    expectAll(normalizedProgressSkill, [
      '`codex/<topic>`',
      'draft pull request',
      'On a non-default branch',
      'completed capability slice',
      'without waiting for review',
      'Explicit user instructions',
      'installed GitHub publication workflow',
      'upstream tracking',
      'detached worktree',
      'Create branch here',
      'may narrow or disable publication',
      'Default Branch Commit and Push Permission',
      'Before every default-branch commit',
      'staged diff summary',
      'staged Git tree ID',
      '`git write-tree`',
      'full commit IDs',
      'proposed commit message',
      'commit, amend, merge, revert, cherry-pick, rebase, or squash',
      'silence is not approval',
      'Changed content, message, input, target, or conflict resolution invalidates approval',
      'Working directly on the default branch is not permission to commit',
      'Approval to commit is not approval to push',
      'approval to push is not approval to commit',
      'exact remote, destination ref and refspec',
      'resolved full old and new commit IDs',
      'A changed tip or range invalidates approval',
      'A force push requires separate disclosure and approval',
      'whenever any source branch targets the remote default ref',
      'pauses only that Git operation',
    ]);
    expect(plugin.keywords).toEqual(
      expect.arrayContaining([
        'implementation-plans',
        'observable-plan-progress',
        'draft-pull-requests',
      ]),
    );
    expect(plugin.interface?.longDescription).toContain('observable plan progress');
    expect(plugin.interface?.defaultPrompt).toHaveLength(3);
    expect(plugin.interface?.defaultPrompt).toContain(
      'Execute a long-running Rallar implementation plan with observable GitHub checkpoints.',
    );
  });

  it('keeps validation scope and completion publication with their canonical owners', () => {
    const agents = readRepo('AGENTS.md');
    const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
    const testingSkill = readRepo('.agents/skills/rallar-testing/SKILL.md');
    const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');
    const codeWritingSkill = readRepo('.agents/skills/rallar-code-writing/SKILL.md');

    expectAllNormalized(progressSkill, [
      'draft pull request',
      'Branch Release Gate',
      'Run Hetzner Supported Distributed Manifests',
      'build-affecting tree digest',
      'Pending, skipped, failed, expired, or unverifiable required publication evidence keeps publication incomplete',
      'An instruction not to commit or push postpones publication',
    ]);
    expectAllNormalized(testingSkill, [
      'adaptive-plan-execution',
      'plan-level validation scope',
      'test:api-v1:black-box:postgres:medium-scale',
      'test:api-v1:black-box:postgres:topology-replay',
      'perf:api-v1:state-write',
    ]);
    expectAllNormalized(testCommands, [
      'Plan-Level Validation Routing',
      'adaptive-plan-execution',
      'explicitly required high-risk proofs',
    ]);
    expectAllNormalized(codeWritingSkill, [
      'rallar-testing',
      'adaptive-plan-execution',
      'plan-level validation scope',
    ]);
    for (const source of [agents, progressSkill, testingSkill, testCommands]) {
      expect(source).not.toContain('npm run test:unit');
      expect(source).not.toContain('npm run test:ci');
      expect(source).not.toContain('npm run build');
    }
  });

  it('limits feature-branch release gates to changes that can affect builds', () => {
    const branchWorkflow = readRepo('.github/workflows/branch-release-gate.yml');
    const reusableWorkflow = readRepo('.github/workflows/release-gate.yml');
    const agents = readRepo('AGENTS.md');
    const progressSkill = readRepo('.agents/skills/publishing-plan-progress/SKILL.md');
    const testingSkill = readRepo('.agents/skills/rallar-testing/SKILL.md');
    const testCommands = readRepo('.agents/skills/rallar-testing/references/test-commands.md');

    expectAllNormalized(branchWorkflow, [
      'branches-ignore:',
      '- main',
      'paths-ignore:',
      "- 'docs/superpowers/plans/**'",
      "- 'plans/**'",
      "- '.agents/**'",
      "- 'AGENTS.md'",
    ]);
    expect(branchWorkflow).not.toContain('docs/superpowers/specs/**');
    expect(branchWorkflow).not.toContain('.codex-plugin/**');
    expect(reusableWorkflow).not.toContain('paths-ignore:');

    expectAllNormalized(progressSkill, [
      'Plan-only branches do not wait for Branch Release Gate when every changed path is excluded by the workflow',
      'Branch Release Gate remains required when its path contract includes changed code, workflows, scripts, tests, or plugin metadata',
    ]);
    for (const source of [agents, testingSkill, testCommands]) {
      expect(source).not.toContain('Plan-only branches do not wait for');
      expect(source).not.toContain('Branch Release Gate remains required');
    }
  });

  it('requires a Markdown learning-oriented command summary in every final handoff', () => {
    const agents = readRepo('AGENTS.md');

    expectAllNormalized(agents, [
      'Every final handoff ends with a Markdown `### Commands executed and what they taught us` section',
      'When commands or tool actions ran, include a concise grouped bullet for each repeated or consequential action',
      'If no commands or tool actions ran, write `No commands or tool actions were run.` in that section',
      'Group repeated or equivalent commands',
      'why the command or action was chosen',
      'what its result means',
      'useful lesson or reusable troubleshooting insight',
      'Never expose secrets, tokens, credentials, authorization headers',
    ]);
  });
});

function readRepo(filePath: string): string {
  return readAbsolute(path.join(repoRoot, filePath));
}

function readAbsolute(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function readJson(filePath: string): unknown {
  return JSON.parse(readRepo(filePath));
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}

function expectAllNormalized(haystack: string, needles: readonly string[]): void {
  const normalized = normalizeWhitespace(haystack);
  for (const needle of needles) {
    expect(normalized, needle).toContain(normalizeWhitespace(needle));
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function readFrontmatter(
  source: string,
  filePath: string,
): Readonly<{ name: string; description: string }> {
  const block = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  expect(block, filePath).toBeDefined();
  const name = block?.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = block?.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return { name, description };
}
