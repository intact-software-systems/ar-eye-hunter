import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const canonicalValidator = '.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';
const adaptiveEvaluationRoot = '.agents/evaluations/adaptive-agent-execution/v1';
const structureEvaluationRoot = '.agents/evaluations/organizing-repository-structure/v1';
const rawArtifact =
  'packages/tests/repo/organizing-repository-structure/organizing-repository-structure-evaluation-result.test.ts';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('organizing repository structure evaluation result validation', () => {
  it('accepts a complete structure result through the canonical validator API', () => {
    const input = createValidationInput();

    expect(validateEvaluationResult(input)).toEqual([]);
  });

  it('selects the structure suite explicitly through the canonical CLI', () => {
    const resultPath = writeResult(createValidationInput().result);
    const validation = runCli(['--suite', 'organizing-repository-structure', resultPath]);

    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('PASS: organizing repository structure evaluation result');
  });

  it('preserves the existing one-path adaptive-suite CLI invocation', () => {
    const adaptiveInput = createValidationInput(adaptiveEvaluationRoot, 'adaptive-plan-execution');
    const resultPath = writeResult(adaptiveInput.result);
    const validation = runCli([resultPath]);

    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('PASS: adaptive agent evaluation result');
  });

  it('rejects unknown suite selectors without reading the result', () => {
    const resultPath = writeResult(createValidationInput().result);
    const validation = runCli(['--suite', 'unknown-suite', resultPath]);

    expect(validation.status).toBe(1);
    expect(validation.stdout).toContain(
      'FAIL: suite must be adaptive-agent-execution or organizing-repository-structure',
    );
  });
});

function createValidationInput(
  evaluationRoot = structureEvaluationRoot,
  primarySkill = 'organizing-repository-structure',
): any {
  const suite = readJson(`${evaluationRoot}/scenarios.json`) as any;
  const rubric = readJson(`${evaluationRoot}/rubric.json`) as any;
  const scenarios = suite.scenarios.filter(
    (scenario: any) => scenario.primarySkill === primarySkill,
  );
  return {
    repoRoot,
    suite,
    rubric,
    result: {
      schemaVersion: 'adaptive-agent-execution-result-v1',
      runId: `fixture-${primarySkill}`,
      suiteId: suite.suiteId,
      primarySkill,
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
      summary: {
        criticalPassed: scenarios.length,
        criticalTotal: scenarios.length,
        passed: scenarios.length,
        total: scenarios.length,
      },
    },
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}

function writeResult(result: unknown): string {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'structure-evaluation-result-'));
  temporaryDirectories.push(temporaryDirectory);
  const resultPath = path.join(temporaryDirectory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  return resultPath;
}

function runCli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(repoRoot, canonicalValidator), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
