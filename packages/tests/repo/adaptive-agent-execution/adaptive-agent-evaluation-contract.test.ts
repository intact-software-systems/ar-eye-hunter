import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/adaptive-agent-execution/v1';
const adaptiveScenarioIds = [
  'conflict-before-final-validation',
  'base-movement-without-conflict',
  'ci-failure-classification',
] as const;
describe('adaptive agent execution evaluation contract', () => {
  it('owns three versioned adaptive pressure scenarios', () => {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;

    expect(suite.schemaVersion).toBe('adaptive-agent-execution-scenarios-v1');
    expect(suite.suiteId).toBe('adaptive-agent-execution-v1');
    expect(suite.scenarios.map((scenario) => scenario.id).sort()).toEqual(
      [...adaptiveScenarioIds].sort(),
    );
    expect(
      suite.scenarios.filter((scenario) => scenario.primarySkill === 'adaptive-plan-execution'),
    ).toHaveLength(3);
    for (const scenario of suite.scenarios) {
      expect(scenario.critical, scenario.id).toBe(true);
      expect(scenario.pressures.length, scenario.id).toBeGreaterThanOrEqual(3);
      expect(scenario.prompt.length, scenario.id).toBeGreaterThan(200);
      expect(new Set(scenario.requiredDimensions).size, scenario.id).toBe(
        scenario.requiredDimensions.length,
      );
    }
  });

  it('makes adaptive compliance observable without grading general architecture eloquence', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
    expect(rubric.schemaVersion).toBe('adaptive-agent-execution-rubric-v1');
    expect(rubric.dimensions.map((dimension) => dimension.id).sort()).toEqual(
      [
        'adaptive.ci-classification',
        'adaptive.material-change',
        'adaptive.proportionate-validation',
        'adaptive.two-slice-horizon',
        'boundary.fact-versus-judgment',
        'delivery.base-movement-noop',
        'delivery.pr-state-first',
        'delivery.terminal-merged',
      ].sort(),
    );
    expect(rubric.nonGoals).toContain('Score general architecture eloquence or writing style.');

    const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
    for (const scenarioId of adaptiveScenarioIds) {
      const requiredDimensions = suite.scenarios.find(
        (entry) => entry.id === scenarioId,
      )?.requiredDimensions;
      expect(requiredDimensions, scenarioId).toContain('delivery.pr-state-first');
    }
  });

  it('separates command-owned facts from agent-owned judgments', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

    expect(rubric.authority.automatedFacts).toEqual(
      expect.arrayContaining([
        'live pull request state',
        'changed paths',
        'check results',
        'repository structure findings',
      ]),
    );
    expect(rubric.authority.agentJudgments).toEqual(
      expect.arrayContaining([
        'goal',
        'acceptance',
        'next slices',
        'material plan changes',
        'structure',
        'validation scope',
      ]),
    );
    expect(rubric.authority.agentJudgments).not.toEqual(
      expect.arrayContaining(rubric.authority.automatedFacts),
    );
  });

  it('defines a machine-readable result contract with evidence per required dimension', () => {
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
    const contract = rubric.resultContract;

    expect(contract.schemaVersion).toBe('adaptive-agent-execution-result-v1');
    expect(contract.requiredRunFields).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'runId',
        'suiteId',
        'skillVariant',
        'scenarioResults',
        'summary',
      ]),
    );
    expect(contract.skillVariants).toEqual(['no-skill', 'with-skill']);
    expect(contract.verdicts).toEqual(['pass', 'fail']);
    expect(contract.requiredScenarioFields).toEqual(
      expect.arrayContaining([
        'scenarioId',
        'verdict',
        'dimensionResults',
        'criticalFailures',
        'rawOutputArtifact',
      ]),
    );
    expect(contract.requiredDimensionFields).toEqual([
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
  readonly nonGoals: readonly string[];
  readonly authority: {
    readonly automatedFacts: readonly string[];
    readonly agentJudgments: readonly string[];
  };
  readonly dimensions: readonly { readonly id: string }[];
  readonly resultContract: {
    readonly schemaVersion: string;
    readonly requiredRunFields: readonly string[];
    readonly skillVariants: readonly string[];
    readonly verdicts: readonly string[];
    readonly requiredScenarioFields: readonly string[];
    readonly requiredDimensionFields: readonly string[];
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, filePath), 'utf8'));
}
