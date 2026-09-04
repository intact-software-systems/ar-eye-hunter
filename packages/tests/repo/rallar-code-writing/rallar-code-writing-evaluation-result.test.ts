import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/rallar-code-writing/v2';
const canonicalValidator = '.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';
const rawArtifact = 'packages/tests/repo/rallar-code-writing/rallar-code-writing-evaluation-result.test.ts';
const temporaryDirectories: string[] = [];
const scenarioId = 'pre-existing-noncompliance-under-release-pressure';
const stewardshipDimensions = [
    'stewardship.requested-behavior',
    'stewardship.whole-file-closure',
    'stewardship.transitive-propagation',
    'stewardship.untouched-code-containment',
    'stewardship.no-debt-only-permission-request',
    'stewardship.genuine-decision-escalation'
] as const;
const additionalScenarioDimensions = [
    ['safe-private-legacy-removal', 'legacy.safe-private-removal'],
    ['safe-private-legacy-removal', 'legacy.behavior-preservation'],
    ['safe-private-legacy-removal', 'legacy.scope-containment'],
    ['safe-private-legacy-removal', 'legacy.preexisting-pressure-rejection'],
    ['public-compatibility-legacy-restraint', 'legacy.public-compatibility-safety'],
    ['public-compatibility-legacy-restraint', 'legacy.minimized-boundary'],
    ['public-compatibility-legacy-restraint', 'legacy.retention-governance'],
    ['public-compatibility-legacy-restraint', 'legacy.behavior-preservation'],
    ['public-compatibility-legacy-restraint', 'legacy.scope-containment'],
    ['public-compatibility-legacy-restraint', 'legacy.preexisting-pressure-rejection'],
    ['pre-decision-skill-preflight', 'preflight.before-implementation-inspection'],
    ['pre-decision-skill-preflight', 'preflight.complete-required-reading'],
    ['pre-decision-skill-preflight', 'preflight.minimum-applicable-set'],
    ['pre-decision-skill-preflight', 'preflight.new-surface-gate'],
    ['pre-decision-skill-preflight', 'preflight.observable-order'],
    [
        'transaction-write-purity-under-deadline-pressure',
        'transaction-purity.persistence-ready-before-entry'
    ],
    [
        'transaction-write-purity-under-deadline-pressure',
        'transaction-purity.precomputable-work-outside'
    ],
    [
        'transaction-write-purity-under-deadline-pressure',
        'transaction-purity.closed-db-result-refinement'
    ],
    [
        'transaction-write-purity-under-deadline-pressure',
        'transaction-purity.full-retry-reentry'
    ],
    [
        'transaction-write-purity-under-deadline-pressure',
        'transaction-purity.winner-only-is-not-authority'
    ],
    ['resource-inbox-policy-under-scope-pressure', 'transaction-policy.resolved-owner-not-path'],
    ['resource-inbox-policy-under-scope-pressure', 'transaction-policy.strict-domain-no-transfer'],
    [
        'resource-inbox-policy-under-scope-pressure',
        'transaction-policy.bounded-resource-inbox-specialization'
    ],
    [
        'resource-inbox-policy-under-scope-pressure',
        'transaction-policy.guarded-winner-materializer'
    ],
    [
        'resource-inbox-policy-under-scope-pressure',
        'transaction-policy.indexeddb-remains-strict'
    ]
] as const;

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
            { cwd: repoRoot, encoding: 'utf8' }
        );

        expect(validation.status).toBe(0);
        expect(validation.stdout).toContain('PASS: rallar code-writing evaluation result');
    });

    it('preserves validation of immutable v1 result artifacts', () => {
        const input = createValidationInput('.agents/evaluations/rallar-code-writing/v1');
        const resultPath = writeResult(input.result);
        const validation = spawnSync(
            process.execPath,
            [path.join(repoRoot, canonicalValidator), '--suite', 'rallar-code-writing-v1', resultPath],
            { cwd: repoRoot, encoding: 'utf8' }
        );

        expect(validation.status).toBe(0);
        expect(validation.stdout).toContain('PASS: rallar code-writing v1 evaluation result');
    });

    it('requires all six critical scenarios and their raw output artifacts', () => {
        const validationInput = createValidationInput();

        expect(validationInput.result.scenarioResults).toHaveLength(6);
        expect(validationInput.result.summary).toEqual({
            criticalPassed: 6,
            criticalTotal: 6,
            passed: 6,
            total: 6
        });

        validationInput.result.scenarioResults[0].rawOutputArtifact = 'missing-agent-output.txt';
        expect(validateEvaluationResult(validationInput)).toContain(
            `${scenarioId} rawOutputArtifact cannot be read as non-empty text`
        );
    });

    it.each(stewardshipDimensions)('treats %s as independently non-compensable', (dimensionId) => {
        const consistentInput = createValidationInput();
        failDimension(consistentInput.result, scenarioId, dimensionId);
        const scenarioResult = findScenarioResult(consistentInput.result, scenarioId);
        scenarioResult.verdict = 'fail';
        scenarioResult.criticalFailures = [dimensionId];
        consistentInput.result.summary = {
            criticalPassed: 5,
            criticalTotal: 6,
            passed: 5,
            total: 6
        };

        expect(validateEvaluationResult(consistentInput)).toEqual([]);

        const inconsistentInput = createValidationInput();
        failDimension(inconsistentInput.result, scenarioId, dimensionId);

        expect(validateEvaluationResult(inconsistentInput)).toEqual(
            expect.arrayContaining([
                `${scenarioId} verdict must be fail when a required dimension fails`,
                `${scenarioId} criticalFailures must exactly list failed required dimensions`,
                'result.summary.passed must equal 5',
                'result.summary.criticalPassed must equal 5'
            ])
        );
    });

    it.each(additionalScenarioDimensions)(
        'treats %s %s as independently non-compensable',
        (legacyScenarioId, dimensionId) => {
            const consistentInput = createValidationInput();
            const scenarioResult = findScenarioResult(consistentInput.result, legacyScenarioId);
            failDimension(consistentInput.result, legacyScenarioId, dimensionId);
            scenarioResult.verdict = 'fail';
            scenarioResult.criticalFailures = [dimensionId];
            consistentInput.result.summary = {
                criticalPassed: 5,
                criticalTotal: 6,
                passed: 5,
                total: 6
            };

            expect(validateEvaluationResult(consistentInput)).toEqual([]);

            const inconsistentInput = createValidationInput();
            failDimension(inconsistentInput.result, legacyScenarioId, dimensionId);
            expect(validateEvaluationResult(inconsistentInput)).toEqual(
                expect.arrayContaining([
                    `${legacyScenarioId} verdict must be fail when a required dimension fails`,
                    `${legacyScenarioId} criticalFailures must exactly list failed required dimensions`,
                    'result.summary.passed must equal 5',
                    'result.summary.criticalPassed must equal 5'
                ])
            );
        }
    );
});

function failDimension(
    result: EvaluationResult,
    targetScenarioId: string,
    dimensionId: string
): void {
    const dimensionResult = findScenarioResult(result, targetScenarioId).dimensionResults.find(
        (entry) => entry.dimensionId === dimensionId
    );
    if (!dimensionResult) {
        throw new Error(`Missing dimension result: ${dimensionId}`);
    }
    dimensionResult.verdict = 'fail';
}

function findScenarioResult(
    result: EvaluationResult,
    targetScenarioId: string
): EvaluationScenarioResult {
    const scenarioResult = result.scenarioResults.find(
        (entry) => entry.scenarioId === targetScenarioId
    );
    expect(scenarioResult, targetScenarioId).toBeDefined();
    return scenarioResult!;
}

function createValidationInput(root = evaluationRoot): EvaluationValidationInput {
    const suite = readJson<EvaluationSuite>(`${root}/scenarios.json`);
    const rubric = readJson<EvaluationRubric>(`${root}/rubric.json`);
    const scenarios = suite.scenarios.filter(
        (scenario) => scenario.primarySkill === 'rallar-code-writing'
    );
    const criticalTotal = scenarios.filter((scenario) => scenario.critical).length;
    const result: EvaluationResult = {
        schemaVersion: rubric.resultContract.schemaVersion,
        runId: 'fixture-rallar-code-writing-result',
        suiteId: suite.suiteId,
        primarySkill: 'rallar-code-writing',
        skillVariant: 'with-skill',
        model: 'fresh-agent',
        startedAt: '2026-08-14T12:00:00Z',
        completedAt: '2026-08-14T12:10:00Z',
        scenarioResults: scenarios.map((scenario) => ({
            scenarioId: scenario.id,
            verdict: 'pass',
            dimensionResults: scenario.requiredDimensions.map((dimensionId) => ({
                dimensionId,
                verdict: 'pass',
                evidence: `Direct evidence for ${dimensionId}.`,
                reason: `The raw answer satisfies ${dimensionId}.`
            })),
            criticalFailures: [],
            rawOutputArtifact: rawArtifact
        })),
        summary: {
            criticalPassed: criticalTotal,
            criticalTotal,
            passed: scenarios.length,
            total: scenarios.length
        }
    };

    return {
        repoRoot,
        suite,
        rubric,
        result
    };
}

function readJson<T>(repositoryPath: string): T {
    return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8')) as T;
}

function writeResult(result: EvaluationResult): string {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'rallar-code-writing-result-'));
    temporaryDirectories.push(temporaryDirectory);
    const resultPath = path.join(temporaryDirectory, 'result.json');
    writeFileSync(resultPath, JSON.stringify(result), 'utf8');
    return resultPath;
}

interface EvaluationScenario {
    readonly id: string;
    readonly critical: boolean;
    readonly primarySkill: string;
    readonly requiredDimensions: readonly string[];
}

interface EvaluationSuite {
    readonly suiteId: string;
    readonly scenarios: readonly EvaluationScenario[];
}

interface EvaluationRubric {
    readonly resultContract: Readonly<{ schemaVersion: string; }>;
}

interface EvaluationDimensionResult {
    readonly dimensionId: string;
    verdict: 'pass' | 'fail';
    readonly evidence: string;
    readonly reason: string;
}

interface EvaluationScenarioResult {
    readonly scenarioId: string;
    verdict: 'pass' | 'fail';
    readonly dimensionResults: EvaluationDimensionResult[];
    criticalFailures: string[];
    rawOutputArtifact: string;
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
    readonly scenarioResults: EvaluationScenarioResult[];
    summary: {
        criticalPassed: number;
        criticalTotal: number;
        passed: number;
        total: number;
    };
}

interface EvaluationValidationInput {
    readonly repoRoot: string;
    readonly suite: EvaluationSuite;
    readonly rubric: object;
    readonly result: EvaluationResult;
}
