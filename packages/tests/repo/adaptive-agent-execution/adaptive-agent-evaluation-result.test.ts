import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/adaptive-agent-execution/v1';
const rawArtifact =
  'packages/tests/repo/adaptive-agent-execution/adaptive-agent-evaluation-result.test.ts';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('adaptive agent evaluation result validation', () => {
  it('accepts one complete result for every scenario owned by the selected skill', () => {
    const input = createValidationInput();

    expect(validateEvaluationResult(input)).toEqual([]);
  });

  it('rejects missing, duplicate, and unknown scenarios for the selected skill run', () => {
    const input = createValidationInput();
    const result = input.result as any;
    const first = result.scenarioResults[0];
    result.scenarioResults = [first, first, ...result.scenarioResults.slice(2)];
    result.scenarioResults.push({ ...first, scenarioId: 'unknown-scenario' });

    expect(validateEvaluationResult(input)).toEqual(
      expect.arrayContaining([
        'result.scenarioResults contains duplicate scenario conflict-before-final-validation',
        'result.scenarioResults contains unknown scenario unknown-scenario',
        'result.scenarioResults is missing scenario base-movement-without-conflict',
      ]),
    );
  });

  it('rejects missing, duplicate, and unknown required dimensions', () => {
    const input = createValidationInput();
    const scenario = (input.result as any).scenarioResults[0];
    const first = scenario.dimensionResults[0];
    scenario.dimensionResults = [first, first, ...scenario.dimensionResults.slice(2)];
    scenario.dimensionResults.push({ ...first, dimensionId: 'unknown.dimension' });

    expect(validateEvaluationResult(input)).toEqual(
      expect.arrayContaining([
        'conflict-before-final-validation dimensionResults contains duplicate dimension delivery.pr-state-first',
        'conflict-before-final-validation dimensionResults contains unknown dimension unknown.dimension',
        'conflict-before-final-validation dimensionResults is missing dimension adaptive.two-slice-horizon',
      ]),
    );
  });

  it('binds scenario verdicts, critical failures, artifacts, and summary to dimension results', () => {
    const input = createValidationInput();
    const result = input.result as any;
    const scenario = result.scenarioResults[0];
    scenario.dimensionResults[0].verdict = 'fail';
    scenario.dimensionResults[0].evidence = '';
    scenario.verdict = 'pass';
    scenario.criticalFailures = [];
    scenario.rawOutputArtifact = 'missing-artifact.md';
    result.summary = { criticalPassed: 3, criticalTotal: 2, passed: 3, total: 2 };

    expect(validateEvaluationResult(input)).toEqual(
      expect.arrayContaining([
        'conflict-before-final-validation delivery.pr-state-first evidence must be non-empty text',
        'conflict-before-final-validation verdict must be fail when a required dimension fails',
        'conflict-before-final-validation criticalFailures must exactly list failed required dimensions',
        'conflict-before-final-validation rawOutputArtifact cannot be read as non-empty text',
        'result.summary.total must equal 3',
        'result.summary.passed must equal 2',
        'result.summary.criticalTotal must equal 3',
        'result.summary.criticalPassed must equal 2',
      ]),
    );
  });

  it('rejects malformed run fields and inverted timestamps', () => {
    const input = createValidationInput();
    const result = input.result as any;
    result.schemaVersion = 'wrong';
    result.runId = '';
    result.suiteId = 'wrong-suite';
    result.primarySkill = 'unknown-skill';
    result.skillVariant = 'sometimes-skill';
    result.model = 5;
    result.startedAt = '2026-08-12T18:00:00Z';
    result.completedAt = '2026-08-12T17:00:00Z';

    expect(validateEvaluationResult(input)).toEqual(
      expect.arrayContaining([
        'result.schemaVersion must be adaptive-agent-execution-result-v1',
        'result.runId must be non-empty text',
        'result.suiteId must be adaptive-agent-execution-v1',
        'result.primarySkill does not select any evaluation scenarios',
        'result.skillVariant must be no-skill or with-skill',
        'result.model must be non-empty text',
        'result.completedAt must not precede result.startedAt',
      ]),
    );
  });

  it('provides a CLI that fails invalid result files and accepts complete ones', () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'adaptive-evaluation-result-'));
    temporaryDirectories.push(temporaryDirectory);
    const resultPath = path.join(temporaryDirectory, 'result.json');
    const input = createValidationInput();
    writeFileSync(resultPath, JSON.stringify(input.result), 'utf8');

    const valid = runCli(resultPath);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain('PASS: adaptive agent evaluation result');

    (input.result as any).summary.total = 99;
    writeFileSync(resultPath, JSON.stringify(input.result), 'utf8');
    const invalid = runCli(resultPath);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toContain('FAIL: result.summary.total must equal 3');
  });
});

function createValidationInput(): any {
  const suite = readJson(`${evaluationRoot}/scenarios.json`) as any;
  const rubric = readJson(`${evaluationRoot}/rubric.json`) as any;
  const scenarios = suite.scenarios.filter(
    (scenario: any) => scenario.primarySkill === 'adaptive-plan-execution',
  );
  return {
    repoRoot,
    suite,
    rubric,
    result: {
      schemaVersion: 'adaptive-agent-execution-result-v1',
      runId: 'fixture-adaptive-plan-result',
      suiteId: 'adaptive-agent-execution-v1',
      primarySkill: 'adaptive-plan-execution',
      skillVariant: 'with-skill',
      model: 'fresh-agent',
      startedAt: '2026-08-12T16:00:00Z',
      completedAt: '2026-08-12T16:10:00Z',
      scenarioResults: scenarios.map((scenario: any) => ({
        scenarioId: scenario.id,
        verdict: 'pass',
        dimensionResults: scenario.requiredDimensions.map((dimensionId: string) => ({
          dimensionId,
          verdict: 'pass',
          evidence: `Direct evidence for ${dimensionId}.`,
          reason: `The raw answer satisfies ${dimensionId}.`,
        })),
        criticalFailures: [],
        rawOutputArtifact: rawArtifact,
      })),
      summary: { criticalPassed: 3, criticalTotal: 3, passed: 3, total: 3 },
    },
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}

function runCli(resultPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, evaluationRoot, 'validate-result.mjs'), resultPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}
