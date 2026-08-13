import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const skillRoot = '.agents/skills/organizing-repository-structure';

describe('organizing repository structure skill contract', () => {
  it('publishes one concise discoverable skill through the repository skill tree', () => {
    const skill = readRepo(`${skillRoot}/SKILL.md`);
    const frontmatter = readFrontmatter(skill);
    const agentMetadata = load(readRepo(`${skillRoot}/agents/openai.yaml`)) as {
      interface?: Readonly<Record<string, string>>;
    };

    expect(frontmatter.name).toBe('organizing-repository-structure');
    expect(frontmatter.description).toMatch(/^Use when\b/u);
    expect(frontmatter.description).not.toMatch(/\b(I|my|we|our)\b/iu);
    expect(agentMetadata.interface?.display_name).toBe('Organizing Repository Structure');
    expect(agentMetadata.interface?.short_description?.length).toBeGreaterThanOrEqual(25);
    expect(agentMetadata.interface?.short_description?.length).toBeLessThanOrEqual(64);
    expect(agentMetadata.interface?.default_prompt).toContain('$organizing-repository-structure');
    expect(readSkillFiles(skillRoot)).toEqual(['SKILL.md', 'agents/openai.yaml']);
    expect(skill.split(/\s+/u).length).toBeLessThanOrEqual(500);
  });

  it('routes facts, dispositions, and cold navigation to their canonical owners', () => {
    const skill = normalizeWhitespace(readRepo(`${skillRoot}/SKILL.md`));

    expect(existsSync(path.join(repoRoot, 'scripts/repo-structure-check.mjs'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'scripts/repo-structure-check/README.md'))).toBe(true);
    expectAll(skill, [
      'npm run check:repo-structure',
      'scripts/repo-structure-check/README.md',
      'scripts/repo-style-check/structural-facts.mjs',
      'keep',
      'split',
      'move',
      'consolidate',
      'navigation evidence',
      'structuralDispositions',
      'node scripts/repo-structure-check.mjs --navigation-evidence <capability-owner>',
    ]);
  });

  it('uses generated evidence instead of requiring agents to transcribe exact facts', () => {
    const skill = normalizeWhitespace(readRepo(`${skillRoot}/SKILL.md`));

    expectAll(skill, [
      'entry',
      'result',
      'Do not make a current disposition permanent',
      'generated navigation-evidence record',
      'do not transcribe facts the checker already owns',
      'actual structural pressure',
    ]);
    expect(skill).not.toContain('exact applicable `repository/path#symbol`');
    expect(skill).not.toContain('declared `package.json` focused command');
    expect(skill).not.toContain(
      'why neither flat dumping nor singleton nesting controls the decision',
    );
  });

  it('keeps structural facts separate from human architectural judgment', () => {
    const skill = normalizeWhitespace(readRepo(`${skillRoot}/SKILL.md`));

    expectAll(skill, [
      'separation of concerns',
      'single responsibility',
      'owner-to-result',
      'Do not mechanically split',
      'meaningless singleton',
      'flat dumping',
      'does not choose',
    ]);
    expect(skill).not.toMatch(/(?:always|must) (?:create|use) (?:a )?(?:src|feature|domain)\//iu);
  });
});

function readRepo(repositoryPath: string): string {
  return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
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
