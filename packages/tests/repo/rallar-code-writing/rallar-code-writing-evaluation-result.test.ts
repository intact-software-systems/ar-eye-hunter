import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateEvaluationResult } from '../../../../.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/rallar-code-writing/v1';
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
const legacyScenarioDimensions = [
    ['safe-private-legacy-removal', 'legacy.safe-private-removal'],
    ['safe-private-legacy-removal', 'legacy.behavior-preservation'],
    ['safe-private-legacy-removal', 'legacy.scope-containment'],
    ['safe-private-legacy-removal', 'legacy.preexisting-pressure-rejection'],
    ['public-compatibility-legacy-restraint', 'legacy.public-compatibility-safety'],
    ['public-compatibility-legacy-restraint', 'legacy.minimized-boundary'],
    ['public-compatibility-legacy-restraint', 'legacy.retention-governance'],
    ['public-compatibility-legacy-restraint', 'legacy.behavior-preservation'],
    ['public-compatibility-legacy-restraint', 'legacy.scope-containment'],
    ['public-compatibility-legacy-restraint', 'legacy.preexisting-pressure-rejection']
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

    it('requires all three critical scenarios and their raw output artifacts', () => {
        const validationInput = createValidationInput();

        expect(validationInput.result.scenarioResults).toHaveLength(3);
        expect(validationInput.result.summary).toEqual({
            criticalPassed: 3,
            criticalTotal: 3,
            passed: 3,
            total: 3
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
            criticalPassed: 2,
            criticalTotal: 3,
            passed: 2,
            total: 3
        };

        expect(validateEvaluationResult(consistentInput)).toEqual([]);

        const inconsistentInput = createValidationInput();
        failDimension(inconsistentInput.result, scenarioId, dimensionId);

        expect(validateEvaluationResult(inconsistentInput)).toEqual(
            expect.arrayContaining([
                `${scenarioId} verdict must be fail when a required dimension fails`,
                `${scenarioId} criticalFailures must exactly list failed required dimensions`,
                'result.summary.passed must equal 2',
                'result.summary.criticalPassed must equal 2'
            ])
        );
    });

    it.each(legacyScenarioDimensions)(
        'treats %s %s as independently non-compensable',
        (legacyScenarioId, dimensionId) => {
            const consistentInput = createValidationInput();
            const scenarioResult = findScenarioResult(consistentInput.result, legacyScenarioId);
            failDimension(consistentInput.result, legacyScenarioId, dimensionId);
            scenarioResult.verdict = 'fail';
            scenarioResult.criticalFailures = [dimensionId];
            consistentInput.result.summary = {
                criticalPassed: 2,
                criticalTotal: 3,
                passed: 2,
                total: 3
            };

            expect(validateEvaluationResult(consistentInput)).toEqual([]);

            const inconsistentInput = createValidationInput();
            failDimension(inconsistentInput.result, legacyScenarioId, dimensionId);
            expect(validateEvaluationResult(inconsistentInput)).toEqual(
                expect.arrayContaining([
                    `${legacyScenarioId} verdict must be fail when a required dimension fails`,
                    `${legacyScenarioId} criticalFailures must exactly list failed required dimensions`,
                    'result.summary.passed must equal 2',
                    'result.summary.criticalPassed must equal 2'
                ])
            );
        }
    );
});

function failDimension(result: any, targetScenarioId: string, dimensionId: string): void {
    const dimensionResult = findScenarioResult(result, targetScenarioId).dimensionResults.find(
        (entry: any) => entry.dimensionId === dimensionId
    );
    dimensionResult.verdict = 'fail';
}

function findScenarioResult(result: any, targetScenarioId: string): any {
    const scenarioResult = result.scenarioResults.find(
        (entry: any) => entry.scenarioId === targetScenarioId
    );
    expect(scenarioResult, targetScenarioId).toBeDefined();
    return scenarioResult;
}

function createValidationInput(): any {
    const suite = readJson(`${evaluationRoot}/scenarios.json`) as any;
    const rubric = readJson(`${evaluationRoot}/rubric.json`) as any;
    const scenarios = suite.scenarios.filter(
        (scenario: any) => scenario.primarySkill === 'rallar-code-writing'
    );
    const criticalTotal = scenarios.filter((scenario: any) => scenario.critical).length;
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
        }
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
