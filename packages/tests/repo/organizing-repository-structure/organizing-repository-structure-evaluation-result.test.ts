import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it.each([
    ['missing artifact', { navigationEvidenceArtifact: undefined }, /navigationEvidenceArtifact/u],
    ['wrong digest', { navigationEvidenceDigest: '0'.repeat(64) }, /digest does not match/u],
    ['wrong owner', { navigationEvidenceOwner: 'wrong owner' }, /owner must match/u],
    ['wrong command', { navigationEvidenceCommand: 'node wrong.mjs' }, /command must match/u],
    ['missing exit code', { navigationEvidenceExitCode: undefined }, /exitCode must equal 0/u],
    ['nonzero exit code', { navigationEvidenceExitCode: 2 }, /exitCode must equal 0/u],
    [
      'wrong affected digest',
      { affectedCodeDigest: 'f'.repeat(64) },
      /artifact must match expected repository truth/u,
    ],
  ])('rejects structure provenance with %s', (_, changes, expected) => {
    const input = createValidationInput();
    input.result.scenarioResults[0] = { ...input.result.scenarioResults[0], ...changes };

    expect(validateEvaluationResult(input).join('\n')).toMatch(expected);
  });
});

function createValidationInput(
  evaluationRoot = structureEvaluationRoot,
  primarySkill = 'organizing-repository-structure',
): EvaluationValidationInput {
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
      scenarioResults: scenarios.map((scenario) => {
        if (evaluationRoot !== structureEvaluationRoot) {
          return {
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
          };
        }
        const expected = rubric.scenarioExpectations[scenario.id];
        const evidence = JSON.stringify({
          schemaVersion: 'repository-navigation-evidence-v1',
          owner: scenario.target.capabilityOwner,
          root: scenario.target.repositoryPath,
          entry: withoutKind(expected.entry),
          results: expected.acceptedResults.map(withoutKind).sort(compareReference),
          failures: [withoutKind(expected.failure)],
          testRoot: expected.tests.path,
          focusedCommand: `npm run ${expected.focusedCommand.symbol}`,
          navigationMap: { state: 'present', path: expected.navigationMap.path },
          affectedCodeDigest: 'a'.repeat(64),
        });
        const navigationEvidenceArtifact = writeArtifact(`${scenario.id}-evidence.json`, evidence);
        return {
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
          navigationEvidenceArtifact,
          navigationEvidenceDigest: sha256(evidence),
          navigationEvidenceCommand: scenario.target.evidenceCommand,
          navigationEvidenceOwner: scenario.target.capabilityOwner,
          navigationEvidenceExitCode: 0,
          affectedCodeDigest: 'a'.repeat(64),
        };
      }),
      summary: {
        criticalPassed: scenarios.length,
        criticalTotal: scenarios.length,
        passed: scenarios.length,
        total: scenarios.length,
      },
    },
  };
}

interface EvaluationValidationInput {
  readonly repoRoot: string;
  readonly suite: EvaluationSuite;
  readonly rubric: EvaluationRubric;
  readonly result: EvaluationResult;
}

interface EvaluationSuite {
  readonly suiteId: string;
  readonly scenarios: readonly EvaluationScenario[];
}

interface EvaluationScenario {
  readonly id: string;
  readonly primarySkill: string;
  readonly critical: boolean;
  readonly requiredDimensions: readonly string[];
  readonly target: {
    readonly repositoryPath: string;
    readonly capabilityOwner: string;
    readonly evidenceCommand: string;
  };
}

interface EvaluationRubric {
  readonly suiteId: string;
  readonly dimensions: readonly { readonly id: string }[];
  readonly resultContract: {
    readonly schemaVersion: string;
    readonly skillVariants: readonly string[];
    readonly verdicts: readonly string[];
  };
  readonly scenarioExpectations: Readonly<Record<string, ScenarioExpectation>>;
}

interface EvaluationResult {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly suiteId: string;
  readonly primarySkill: string;
  readonly skillVariant: string;
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scenarioResults: readonly EvaluationScenarioResult[];
  readonly summary: EvaluationSummary;
}

interface EvaluationScenarioResult {
  readonly scenarioId: string;
  readonly verdict: string;
  readonly dimensionResults: readonly EvaluationDimensionResult[];
  readonly criticalFailures: readonly string[];
  readonly rawOutputArtifact: string;
  readonly navigationEvidenceArtifact?: string;
  readonly navigationEvidenceDigest?: string;
  readonly navigationEvidenceCommand?: string;
  readonly navigationEvidenceOwner?: string;
  readonly navigationEvidenceExitCode?: number;
  readonly affectedCodeDigest?: string;
}

interface EvaluationDimensionResult {
  readonly dimensionId: string;
  readonly verdict: string;
  readonly evidence: string;
  readonly reason: string;
}

interface EvaluationSummary {
  readonly criticalPassed: number;
  readonly criticalTotal: number;
  readonly passed: number;
  readonly total: number;
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

function writeArtifact(name: string, content: string): string {
  const temporaryDirectory = mkdtempSync(path.join(repoRoot, '.superpowers', 'task8-result-'));
  temporaryDirectories.push(temporaryDirectory);
  const artifactPath = path.join(temporaryDirectory, name);
  writeFileSync(artifactPath, content, 'utf8');
  return path.relative(repoRoot, artifactPath);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface ScenarioExpectation {
  readonly entry: EvidenceReference;
  readonly acceptedResults: readonly EvidenceReference[];
  readonly failure: EvidenceReference;
  readonly tests: { readonly path: string };
  readonly focusedCommand: { readonly symbol: string };
  readonly navigationMap: { readonly path: string };
}

interface EvidenceReference {
  readonly kind: string;
  readonly path: string;
  readonly symbol: string;
}

function withoutKind({ path: repositoryPath, symbol }: EvidenceReference) {
  return { path: repositoryPath, symbol };
}

function compareReference(
  left: Readonly<{ path: string; symbol: string }>,
  right: Readonly<{ path: string; symbol: string }>,
): number {
  return Buffer.compare(
    Buffer.from(`${left.path}\0${left.symbol}`),
    Buffer.from(`${right.path}\0${right.symbol}`),
  );
}

function runCli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(repoRoot, canonicalValidator), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}
