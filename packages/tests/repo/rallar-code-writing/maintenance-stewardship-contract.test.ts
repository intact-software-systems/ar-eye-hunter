import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/rallar-code-writing/v1';
const guidancePaths = [
  'AGENTS.md',
  '.agents/skills/rallar-code-writing/SKILL.md',
  '.agents/skills/rallar-code-writing/references/repo-code-style.md',
  '.agents/skills/adaptive-plan-execution/SKILL.md',
  'docs/repo-human-style-guide.md',
] as const;
const stewardshipDimensions = [
  'stewardship.requested-behavior',
  'stewardship.whole-file-closure',
  'stewardship.transitive-propagation',
  'stewardship.untouched-code-containment',
  'stewardship.no-debt-only-permission-request',
  'stewardship.genuine-decision-escalation',
] as const;

describe('rallar code-writing maintenance stewardship contract', () => {
  it('makes touched-file standards closure the positive execution path', () => {
    const sources = guidancePaths.map(readRepo).map(normalize);

    for (const source of sources) {
      expect(source).toContain('touched-file standards closure');
      expect(source).toContain('pre-existing and new noncompliance');
      expect(source).toContain('throughout each touched file');
      expect(source).toContain('enters the closure recursively');
      expect(source).toContain('Independent untouched code remains outside the closure');
    }

    const canonicalStyle = sources[2];
    expect(canonicalStyle).toContain(
      'changed human-authored source, test, script, fixture, example, and configuration file',
    );
    expect(canonicalStyle).toContain('generated and third-party files are excluded');
    expect(canonicalStyle).toContain('implement the requested behavior');
    expect(canonicalStyle).toContain('resolve the entire touched-file closure');
    expect(canonicalStyle).toContain('validate both the requested behavior and closure');
  });

  it('keeps checker tolerance non-authoritative for touched-file closure', () => {
    const canonicalStyle = normalize(
      readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md'),
    );
    const humanGuide = normalize(readRepo('docs/repo-human-style-guide.md'));

    for (const source of [canonicalStyle, humanGuide]) {
      expect(source).toContain('full-repository checker remains warning-only');
      expect(source).toContain('new or worsened findings');
      expect(source).toContain('Checker tolerance is not authority');
      expect(source).toContain('does not define touched-file standards closure');
    }
  });

  it('permits escalation only for four genuine decisions', () => {
    const sources = guidancePaths.map(readRepo).map(normalize);
    const escalationConditions = [
      'a genuine exception for a remaining real standards violation',
      'a public compatibility or migration decision',
      'an unresolved correctness or safety conflict',
      'a failed post-consolidation navigation probe',
    ];

    for (const source of sources) {
      expect(source).toContain('Escalate only for');
      expectAll(source, escalationConditions);
      expect(source).toContain('Do not escalate for');
      expectAll(source, ['pre-existing debt', 'deadline pressure', 'diff size', 'cleanup volume']);
    }

    for (const repositoryPath of guidancePaths) {
      expect(readRepo(repositoryPath), repositoryPath).not.toContain(
        'accepted existing debt with no new/worsened magnitude and an owner',
      );
    }
  });

  it('defines one critical versioned pressure scenario and a binary rubric', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(suite.schemaVersion).toBe('rallar-code-writing-scenarios-v1');
    expect(suite.suiteId).toBe('rallar-code-writing-v1');
    expect(suite.scenarios).toHaveLength(1);
    expect(suite.scenarios[0]).toMatchObject({
      id: 'pre-existing-noncompliance-under-release-pressure',
      critical: true,
      primarySkill: 'rallar-code-writing',
      requiredDimensions: stewardshipDimensions,
    });
    expect(suite.scenarios[0].pressures).toEqual([
      'release-deadline',
      'small-diff-request',
      'pre-existing-noncompliance',
      'permission-seeking',
    ]);
    expect(suite.scenarios[0].prompt).toContain('BabylonArena.tsx');
    expect(suite.scenarios[0].prompt).toContain('pause/resume');
    expect(suite.scenarios[0].prompt).toContain('20-line');

    expect(rubric.schemaVersion).toBe('rallar-code-writing-rubric-v1');
    expect(rubric.suiteId).toBe(suite.suiteId);
    expect(rubric.criticalPolicy).toBe(
      'Every required dimension for every critical scenario must pass.',
    );
    expect(rubric.dimensions.map(({ id }) => id)).toEqual(stewardshipDimensions);
    expect(rubric.resultContract).toMatchObject({
      schemaVersion: 'rallar-code-writing-result-v1',
      skillVariants: ['no-skill', 'with-skill'],
      verdicts: ['pass', 'fail'],
    });
    expect(JSON.stringify(rubric)).not.toMatch(/points|score|weighted/iu);
  });

  it('reuses the canonical versioned evaluation-result validator', () => {
    expect(existsSync(path.join(repoRoot, `${evaluationRoot}/validate-result.mjs`))).toBe(false);
    expect(
      readRepo('.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs'),
    ).toContain("'rallar-code-writing'");
  });
});

interface EvaluationSuite {
  readonly schemaVersion: string;
  readonly suiteId: string;
  readonly scenarios: readonly {
    readonly id: string;
    readonly critical: boolean;
    readonly primarySkill: string;
    readonly pressures: readonly string[];
    readonly prompt: string;
    readonly requiredDimensions: readonly string[];
  }[];
}

interface EvaluationRubric {
  readonly schemaVersion: string;
  readonly suiteId: string;
  readonly criticalPolicy: string;
  readonly dimensions: readonly { readonly id: string; readonly pass: string }[];
  readonly resultContract: Readonly<{
    schemaVersion: string;
    skillVariants: readonly string[];
    verdicts: readonly string[];
  }>;
}

function readRepo(repositoryPath: string): string {
  return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readRepo(repositoryPath));
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function expectAll(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack, needle).toContain(needle);
  }
}
