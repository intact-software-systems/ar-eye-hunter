import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillRoot = '.agents/skills/adaptive-plan-execution';
const planCommands = ['apply', 'check', 'close', 'complete-slice', 'init', 'prepare'] as const;

describe('adaptive plan execution skill contract', () => {
  it('publishes one concise discoverable skill through the repository skill tree', () => {
    const skillPath = path.join(repoRoot, skillRoot, 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8');
    const frontmatter = readFrontmatter(skill);
    const agentMetadata = load(
      readFileSync(path.join(repoRoot, skillRoot, 'agents/openai.yaml'), 'utf8'),
    ) as { interface?: Readonly<Record<string, string>> };

    expect(frontmatter.name).toBe('adaptive-plan-execution');
    expect(frontmatter.description).toMatch(/^Use when\b/);
    expect(frontmatter.description).not.toMatch(/\b(I|my|we|our)\b/iu);
    expect(agentMetadata.interface?.display_name).toBe('Adaptive Plan Execution');
    expect(agentMetadata.interface?.short_description?.length).toBeGreaterThanOrEqual(25);
    expect(agentMetadata.interface?.short_description?.length).toBeLessThanOrEqual(64);
    expect(agentMetadata.interface?.default_prompt).toContain('$adaptive-plan-execution');

    expect(readSkillFiles(skillRoot)).toEqual(['SKILL.md', 'agents/openai.yaml']);
  });

  it('routes every lifecycle operation to the canonical plan-adaptation command owner', () => {
    const skill = readRepo(`${skillRoot}/SKILL.md`);
    const packageJson = JSON.parse(readRepo('package.json')) as {
      scripts?: Readonly<Record<string, string>>;
    };
    const routedCommands = [
      ...new Set([...skill.matchAll(/npm run plan:adapt -- ([a-z-]+)/gu)].map((match) => match[1])),
    ].sort();

    expect(packageJson.scripts?.['plan:adapt']).toBe('node scripts/plan-adaptation.mjs');
    expect(routedCommands).toEqual([...planCommands].sort());
    expect(existsSync(path.join(repoRoot, 'scripts/plan-adaptation.mjs'))).toBe(true);
    expect(skill).toContain('`plan-adaptation-v1`');
    expect(skill).toContain('npm run plan:adapt -- init --plan <plan-path>');
    expect(skill).toContain('npm run plan:adapt -- complete-slice --slice <slice-name>');
    expect(skill).toContain(
      'npm run plan:adapt -- close --final-pr-evidence <pull-request-evidence>',
    );
    expect(skill).toContain('npm run check:adaptive-governance');
    expect(skill).not.toContain('npm run test:repo-governance');
  });

  it('keeps consolidation as the only active slice until its cold probe passes', () => {
    const skill = normalizeWhitespace(readRepo(`${skillRoot}/SKILL.md`));

    expect(skill).toContain(
      '`consolidate` must expose exactly one consolidation slice in `nextSlices`',
    );
    expect(skill).toContain('Feature work stays inactive until the post-consolidation checkpoint');
  });

  it('routes authenticated plan disposition through one exact approval', () => {
    const skill = normalizeWhitespace(readRepo(`${skillRoot}/SKILL.md`));

    expect(skill).toContain('exact canonical request and expected main head');
    expect(skill).toContain('one just-in-time approval before `apply`');
    expect(skill).toContain('A changed request or head invalidates the approval');
    expect(skill).toContain('Never hand-write a receipt');
    expect(skill).toContain('directly edit/delete a plan');
    expect(skill).toContain('generated active-plan registry');
  });
});

function readRepo(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function readFrontmatter(source: string): Readonly<{ name: string; description: string }> {
  const block = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  expect(block).toBeDefined();
  const name = block?.match(/^name:\s*(.+)$/mu)?.[1]?.trim() ?? '';
  const description = block?.match(/^description:\s*(.+)$/mu)?.[1]?.trim() ?? '';
  return { name, description };
}

function readSkillFiles(root: string): readonly string[] {
  const files: string[] = [];
  visit(root, '');
  return files.sort();

  function visit(repositoryPath: string, relativePath: string): void {
    for (const entry of readdirSync(path.join(repoRoot, repositoryPath), { withFileTypes: true })) {
      const childRelativePath = path.posix.join(relativePath, entry.name);
      const childRepositoryPath = path.posix.join(repositoryPath, entry.name);
      if (entry.isDirectory()) {
        visit(childRepositoryPath, childRelativePath);
      } else {
        files.push(childRelativePath);
      }
    }
  }
}
