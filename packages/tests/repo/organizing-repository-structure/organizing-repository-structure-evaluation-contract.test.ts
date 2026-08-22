import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/organizing-repository-structure/v1';
const scenarioIds = [
    'flat-versus-singleton-folders',
    'near-limit-module-pressure',
    'repository-depends-on-plan'
];

describe('organizing repository structure evaluation contract', () => {
    it('keeps three current-code pressure scenarios without plan or generated evidence coupling', () => {
        const suite = readJson(`${evaluationRoot}/scenarios.json`) as EvaluationSuite;

        expect(suite.schemaVersion).toBe('organizing-repository-structure-scenarios-v1');
        expect(suite.suiteId).toBe('organizing-repository-structure-v1');
        expect(suite.scenarios.map((scenario) => scenario.id).sort()).toEqual(scenarioIds.sort());
        for (const scenario of suite.scenarios) {
            expect(scenario.critical, scenario.id).toBe(true);
            expect(scenario.target.checkCommand, scenario.id).toBe(
                'npm run check:repo-structure -- --base origin/main'
            );
            expect(existsSync(path.join(repoRoot, scenario.target.repositoryPath)), scenario.id).toBe(
                true
            );
            expect(existsSync(path.join(repoRoot, scenario.target.pressurePath)), scenario.id).toBe(true);
            expect(scenario.prompt, scenario.id).toContain(scenario.target.repositoryPath);
            expect(scenario.prompt, scenario.id).toContain(scenario.target.checkCommand);
        }
        expect(JSON.stringify(suite)).not.toMatch(
            /plan-adaptation|navigation-evidence|affectedCodeDigest|receipt/iu
        );
    });

    it('assigns reproducible facts to automation and structural choices to the agent', () => {
        const rubric = readJson(`${evaluationRoot}/rubric.json`) as EvaluationRubric;

        expect(rubric.authority.automatedFacts).toEqual(
            expect.arrayContaining([
                'directory density',
                'singleton and redundant-chain findings',
                'exception-registry validity'
            ])
        );
        expect(rubric.authority.agentJudgments).toEqual(
            expect.arrayContaining([
                'capability and responsibility ownership',
                'keep, split, move, or consolidate disposition',
                'material working-plan adaptation'
            ])
        );
        expect(rubric.nonGoals).toContain(
            'Require a generated navigation record, plan digest, or tracked evidence ledger.'
        );
        for (const expectation of Object.values(rubric.scenarioExpectations)) {
            for (const repositoryPath of expectation.requiredPaths) {
                expect(existsSync(path.join(repoRoot, repositoryPath)), repositoryPath).toBe(true);
            }
        }
    });

    it('keeps evaluation reproducibility internal without making it ordinary PR input', () => {
        const microtests = readJson(`${evaluationRoot}/microtests.json`) as Microtests;

        expect(microtests.repetitionsPerVariant).toBe(5);
        expect(microtests.variants).toEqual(['no-skill', 'with-skill']);
        expect(microtests.target.checkCommand).toBe(
            'npm run check:repo-structure -- --base origin/main'
        );
        expect(microtests.evidenceContract.requiredFields).toEqual(
            expect.arrayContaining(['promptDigest', 'skillDigest', 'rubricDigest', 'rawOutputArtifact'])
        );
        expect(microtests.evidenceContract.requiredFields).not.toEqual(
            expect.arrayContaining([
                'navigationEvidenceArtifact',
                'navigationEvidenceDigest',
                'navigationEvidenceAffectedCodeDigest'
            ])
        );
        expect(JSON.stringify(microtests)).not.toMatch(/plan-adaptation|navigation-evidence/iu);
    });
});

interface EvaluationSuite {
    readonly schemaVersion: string;
    readonly suiteId: string;
    readonly scenarios: readonly {
        readonly id: string;
        readonly critical: boolean;
        readonly prompt: string;
        readonly target: {
            readonly repositoryPath: string;
            readonly pressurePath: string;
            readonly checkCommand: string;
        };
    }[];
}

interface EvaluationRubric {
    readonly nonGoals: readonly string[];
    readonly authority: {
        readonly automatedFacts: readonly string[];
        readonly agentJudgments: readonly string[];
    };
    readonly scenarioExpectations: Readonly<Record<string, { readonly requiredPaths: readonly string[]; }>>;
}

interface Microtests {
    readonly repetitionsPerVariant: number;
    readonly variants: readonly string[];
    readonly target: { readonly checkCommand: string; };
    readonly evidenceContract: { readonly requiredFields: readonly string[]; };
}

function readJson(repositoryPath: string): unknown {
    return JSON.parse(readFileSync(path.join(repoRoot, repositoryPath), 'utf8'));
}
