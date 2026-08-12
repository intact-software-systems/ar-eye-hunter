import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/organizing-repository-structure/v1';
const scenarioIds = [
  'flat-versus-singleton-folders',
  'near-limit-module-pressure',
  'repository-depends-on-plan',
] as const;

describe('organizing repository structure evaluation contract', () => {
  it('owns three versioned critical pressure scenarios', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;

    expect(suite.schemaVersion).toBe('organizing-repository-structure-scenarios-v1');
    expect(suite.suiteId).toBe('organizing-repository-structure-v1');
    expect(suite.scenarios.map((scenario) => scenario.id).sort()).toEqual([...scenarioIds].sort());
    for (const scenario of suite.scenarios) {
      expect(scenario.critical, scenario.id).toBe(true);
      expect(scenario.primarySkill, scenario.id).toBe('organizing-repository-structure');
      expect(scenario.pressures.length, scenario.id).toBeGreaterThanOrEqual(3);
      expect(scenario.prompt.length, scenario.id).toBeGreaterThan(200);
      expect(new Set(scenario.requiredDimensions).size, scenario.id).toBe(
        scenario.requiredDimensions.length,
      );
    }
  });

  it('grades owner navigation, judgment, cold proof, and fact boundaries', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
    const dimensionIds = rubric.dimensions.map((dimension) => dimension.id);

    expect(rubric.schemaVersion).toBe('organizing-repository-structure-rubric-v1');
    expect(rubric.suiteId).toBe(suite.suiteId);
    expect(dimensionIds).toEqual(
      expect.arrayContaining([
        'structure.owner-navigation',
        'structure.disposition-judgment',
        'structure.singleton-tradeoff',
        'structure.cold-navigation-proof',
        'structure.durable-repository-truth',
        'boundary.fact-versus-judgment',
      ]),
    );
    expect(rubric.nonGoals).toEqual(
      expect.arrayContaining([
        'Require a particular folder taxonomy.',
        'Convert a size, density, prefix, or depth fact into an automatic split.',
      ]),
    );
    for (const scenario of suite.scenarios) {
      expect(scenario.requiredDimensions, scenario.id).toContain('structure.owner-navigation');
      expect(scenario.requiredDimensions, scenario.id).toContain('structure.disposition-judgment');
      expect(scenario.requiredDimensions, scenario.id).toContain('boundary.fact-versus-judgment');
    }
  });

  it('assigns computed facts to automation and dispositions to the agent', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(rubric.authority.automatedFacts).toEqual(
      expect.arrayContaining([
        'directory density',
        'feature-prefix clustering',
        'file size and cognitive-load findings',
        'semantic directory depth',
        'singleton and redundant-chain findings',
        'capability declaration and cold-navigation evidence validity',
      ]),
    );
    expect(rubric.authority.agentJudgments).toEqual(
      expect.arrayContaining([
        'capability and responsibility ownership',
        'keep, split, move, or consolidate disposition',
        'validation scope',
      ]),
    );
  });

  it('reuses the canonical result contract shape', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(rubric.resultContract.schemaVersion).toBe('adaptive-agent-execution-result-v1');
    expect(rubric.resultContract.skillVariants).toEqual(['no-skill', 'with-skill']);
    expect(rubric.resultContract.verdicts).toEqual(['pass', 'fail']);
    expect(rubric.resultContract.requiredDimensionFields).toEqual([
      'dimensionId',
      'verdict',
      'evidence',
      'reason',
    ]);
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
  readonly nonGoals: readonly string[];
  readonly authority: {
    readonly automatedFacts: readonly string[];
    readonly agentJudgments: readonly string[];
  };
  readonly dimensions: readonly { readonly id: string }[];
  readonly resultContract: {
    readonly schemaVersion: string;
    readonly skillVariants: readonly string[];
    readonly verdicts: readonly string[];
    readonly requiredDimensionFields: readonly string[];
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}
