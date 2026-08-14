import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/rallar-code-writing/v1';
const canonicalValidator = '.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';
const rawArtifact =
  'packages/tests/repo/rallar-code-writing/rallar-code-writing-evaluation-result.test.ts';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('rallar code-writing evaluation result validation', () => {
  it('accepts a complete binary result through the canonical validator API', () => {
    expect(validateEvaluationResult(createValidationInput())).toEqual([]);
  });

  it('selects the rallar code-writing suite through the canonical CLI', () => {
    const resultPath = writeResult(createValidationInput().result);
    const validation = spawnSync(
      process.execPath,
      [path.join(repoRoot, canonicalValidator), '--suite', 'rallar-code-writing', resultPath],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('PASS: rallar code-writing evaluation result');
  });

  it('fails the scenario when any non-compensable dimension fails', () => {
    const input = createValidationInput();
    const result = input.result as any;
    result.scenarioResults[0].dimensionResults[1].verdict = 'fail';
    result.scenarioResults[0].verdict = 'fail';
    result.scenarioResults[0].criticalFailures = ['stewardship.whole-file-closure'];
    result.summary = { criticalPassed: 0, criticalTotal: 1, passed: 0, total: 1 };

    expect(validateEvaluationResult(input)).toEqual([]);
  });
});

function createValidationInput(): any {
  const suite = readJson(`${evaluationRoot}/scenarios.json`) as any;
  const rubric = readJson(`${evaluationRoot}/rubric.json`) as any;
  const scenarios = suite.scenarios.filter(
    (scenario: any) => scenario.primarySkill === 'rallar-code-writing',
  );
  return {
    repoRoot,
    suite,
    rubric,
    result: {
      schemaVersion: 'rallar-code-writing-result-v1',
      runId: 'fixture-rallar-code-writing-result',
      suiteId: 'rallar-code-writing-v1',
      primarySkill: 'rallar-code-writing',
      skillVariant: 'with-skill',
      model: 'fresh-agent',
      startedAt: '2026-08-14T12:00:00Z',
      completedAt: '2026-08-14T12:10:00Z',
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
      summary: { criticalPassed: 1, criticalTotal: 1, passed: 1, total: 1 },
    },
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}

function writeResult(result: unknown): string {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'rallar-code-writing-result-'));
  temporaryDirectories.push(temporaryDirectory);
  const resultPath = path.join(temporaryDirectory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  return resultPath;
}
