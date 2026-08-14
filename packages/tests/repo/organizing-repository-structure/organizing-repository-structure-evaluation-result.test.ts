import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const validator = '.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';
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
  it('accepts direct semantic evidence without a generated navigation record', () => {
    expect(validateEvaluationResult(createValidationInput())).toEqual([]);
  });

  it('selects the structure suite explicitly through the canonical CLI', () => {
    const resultPath = writeResult(createValidationInput().result);
    const validation = runCli(['--suite', 'organizing-repository-structure', resultPath]);

    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('PASS: organizing repository structure evaluation result');
  });

  it('preserves the one-path adaptive-suite CLI invocation', () => {
    const input = createValidationInput(adaptiveEvaluationRoot, 'adaptive-plan-execution');
    const resultPath = writeResult(input.result);
    const validation = runCli([resultPath]);

    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('PASS: adaptive agent evaluation result');
  });

  it('rejects unknown suite selectors without reading the result', () => {
    const resultPath = writeResult(createValidationInput().result);
    const validation = runCli(['--suite', 'unknown-suite', resultPath]);

    expect(validation.status).toBe(1);
    expect(validation.stdout).toContain(
      'FAIL: suite must be adaptive-agent-execution, organizing-repository-structure, or rallar-code-writing',
    );
  });

  it('still requires a non-empty raw answer artifact', () => {
    const input = createValidationInput();
    input.result.scenarioResults[0].rawOutputArtifact = 'missing-output.txt';

    expect(validateEvaluationResult(input).join('\n')).toContain(
      'rawOutputArtifact cannot be read as non-empty text',
    );
  });
});

function createValidationInput(
  evaluationRoot = structureEvaluationRoot,
  primarySkill = 'organizing-repository-structure',
) {
  const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;
  const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;
  const scenarios = suite.scenarios.filter((scenario) => scenario.primarySkill === primarySkill);
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
      scenarioResults: scenarios.map((scenario) => ({
        scenarioId: scenario.id,
        verdict: 'pass',
        dimensionResults: scenario.requiredDimensions.map((dimensionId) => ({
          dimensionId,
          verdict: 'pass',
          evidence: `Direct current-code evidence for ${dimensionId}.`,
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

interface EvaluationSuite {
  readonly suiteId: string;
  readonly scenarios: readonly {
    readonly id: string;
    readonly primarySkill: string;
    readonly requiredDimensions: readonly string[];
  }[];
}

interface EvaluationRubric {
  readonly suiteId: string;
  readonly dimensions: readonly { readonly id: string }[];
  readonly resultContract: {
    readonly schemaVersion: string;
    readonly skillVariants: readonly string[];
    readonly verdicts: readonly string[];
  };
}

function readJson(repositoryPath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}

function writeResult(result: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'structure-evaluation-result-'));
  temporaryDirectories.push(directory);
  const resultPath = path.join(directory, 'result.json');
  writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  return resultPath;
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, validator), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
