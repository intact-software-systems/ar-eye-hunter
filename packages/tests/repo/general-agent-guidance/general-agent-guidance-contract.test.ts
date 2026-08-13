import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const generalGuidancePaths = [
  'AGENTS.md',
  '.agents/skills/publishing-plan-progress/SKILL.md',
  '.agents/skills/rallar-code-writing/SKILL.md',
  '.agents/skills/rallar-testing/SKILL.md',
  '.agents/skills/rallar-testing/references/test-commands.md',
] as const;

describe('general agent guidance routing', () => {
  it('routes adaptation, structure, testing, and publication to one owner each', () => {
    const agents = normalize(readRepo('AGENTS.md'));
    const codeWriting = normalize(readRepo('.agents/skills/rallar-code-writing/SKILL.md'));
    const testing = normalize(readRepo('.agents/skills/rallar-testing/SKILL.md'));
    const testCommands = normalize(
      readRepo('.agents/skills/rallar-testing/references/test-commands.md'),
    );
    const publishing = normalize(readRepo('.agents/skills/publishing-plan-progress/SKILL.md'));

    expect(agents).toContain(
      'Use `adaptive-plan-execution` for written or multi-slice plans, ' +
        '`organizing-repository-structure` for repository shape, `rallar-testing` for ' +
        'surface-specific commands, and `publishing-plan-progress` for publication.',
    );
    expect(codeWriting).toContain(
      '**REQUIRED SUB-SKILL:** Use `organizing-repository-structure` for repository shape decisions.',
    );
    expect(codeWriting).toContain(
      '**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` when code work qualifies for an adaptive plan.',
    );
    expect(testing).toContain(
      '`adaptive-plan-execution` owns plan-level validation scope and checkpoint decisions.',
    );
    expect(testCommands).toContain('`adaptive-plan-execution` owns plan-level validation scope.');
    expect(publishing).toContain(
      '**REQUIRED SUB-SKILL:** Use `adaptive-plan-execution` for plan adaptation and checkpoint decisions.',
    );
  });

  it('does not duplicate adaptive, structural, startup, or unconditional local-suite policy', () => {
    const sources = Object.fromEntries(
      generalGuidancePaths.map((repositoryPath) => [repositoryPath, readRepo(repositoryPath)]),
    );
    const publishing = sources['.agents/skills/publishing-plan-progress/SKILL.md'];

    expect(publishing).not.toContain('plan-adaptation-v1');
    expect(publishing).not.toContain('complete-slice');
    expect(publishing).not.toContain('structuralDispositions');
    expect(publishing).not.toContain('Plan Authoring And Production Legacy Closure');
    expect(publishing).not.toContain('Active-Plan Boundary');

    expect(sources['AGENTS.md']).not.toMatch(/During every task, first search[\s\S]*?Issues/iu);
    for (const [repositoryPath, source] of Object.entries(sources)) {
      expect(source, repositoryPath).not.toContain('npm run test:unit');
      expect(source, repositoryPath).not.toContain('npm run test:ci');
      expect(source, repositoryPath).not.toContain('npm run build');
    }

    for (const repositoryPath of [
      'AGENTS.md',
      '.agents/skills/rallar-code-writing/SKILL.md',
      '.agents/skills/rallar-testing/SKILL.md',
      '.agents/skills/rallar-testing/references/test-commands.md',
    ]) {
      const source = sources[repositoryPath];
      expect(source, repositoryPath).not.toContain('exact head SHA');
      expect(source, repositoryPath).not.toContain('exact commit SHA');
      expect(source, repositoryPath).not.toContain('attached to an older commit');
    }
  });

  it('preserves publication safety, completion publication, and high-risk proofs', () => {
    const agents = normalize(readRepo('AGENTS.md'));
    const publishing = normalize(readRepo('.agents/skills/publishing-plan-progress/SKILL.md'));
    const testing = normalize(readRepo('.agents/skills/rallar-testing/SKILL.md'));
    const testCommands = normalize(
      readRepo('.agents/skills/rallar-testing/references/test-commands.md'),
    );

    expectAll(publishing, [
      'draft pull request',
      'Compatibility Review',
      'Follow-Up Issue Handoff',
      'Default Branch Commit and Push Permission',
      'Branch Release Gate',
      'Run Hetzner Supported Distributed Manifests',
      'build-affecting tree digest',
    ]);
    expectAll(agents, [
      'No AI or agent may create or place a commit on `main`',
      'No AI or agent may push `main`',
      'When adding or changing REST API behavior',
      'For shared-web public surface work',
      'For game/realtime changes',
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
      'test:repo-governance',
    ]);
    expectAll(testCommands, [
      'test:api-v1:black-box:postgres:medium-scale',
      'test:api-v1:black-box:postgres:topology-replay',
      'perf:api-v1:state-write',
      'UI Workflow Testing',
      'test:repo-governance',
    ]);
  });

  it('keeps authenticated governance decisions exact and separate from ordinary publication', () => {
    const sources = [
      readRepo('AGENTS.md'),
      readRepo('.agents/skills/adaptive-plan-execution/SKILL.md'),
      readRepo('.agents/skills/publishing-plan-progress/SKILL.md'),
    ].map(normalize);

    for (const source of sources) {
      expect(source).toContain('exact canonical request');
      expect(source).toContain('expected main head');
      expect(source).toContain('one just-in-time approval');
      expect(source).toMatch(/changed request or (?:expected )?head invalidates/iu);
      expect(source).toMatch(/Never hand-write/iu);
      expect(source).toMatch(/directly edit(?:\/delete| or delete) a plan/iu);
      expect(source).toMatch(/generated (?:active-plan )?registr/iu);
    }
    expect(sources[2]).toContain(
      'This does not approve any ordinary default-branch commit or push.',
    );
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
