import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const evaluationRoot = '.agents/evaluations/rallar-code-writing/v2';
const guidancePaths = [
    'AGENTS.md',
    '.agents/skills/rallar-code-writing/SKILL.md',
    '.agents/skills/rallar-code-writing/references/repo-code-style.md',
    '.agents/skills/adaptive-plan-execution/SKILL.md',
    'docs/repo-human-style-guide.md'
] as const;
const stewardshipDimensions = [
    'stewardship.requested-behavior',
    'stewardship.whole-file-closure',
    'stewardship.transitive-propagation',
    'stewardship.untouched-code-containment',
    'stewardship.no-debt-only-permission-request',
    'stewardship.genuine-decision-escalation'
] as const;
const safePrivateLegacyDimensions = [
    'legacy.safe-private-removal',
    'legacy.behavior-preservation',
    'legacy.scope-containment',
    'legacy.preexisting-pressure-rejection'
] as const;
const publicCompatibilityLegacyDimensions = [
    'legacy.public-compatibility-safety',
    'legacy.minimized-boundary',
    'legacy.retention-governance',
    'legacy.behavior-preservation',
    'legacy.scope-containment',
    'legacy.preexisting-pressure-rejection'
] as const;
const preflightDimensions = [
    'preflight.before-implementation-inspection',
    'preflight.complete-required-reading',
    'preflight.minimum-applicable-set',
    'preflight.new-surface-gate',
    'preflight.observable-order'
] as const;
const transactionPurityDimensions = [
    'transaction-purity.persistence-ready-before-entry',
    'transaction-purity.precomputable-work-outside',
    'transaction-purity.closed-db-result-refinement',
    'transaction-purity.full-retry-reentry',
    'transaction-purity.winner-only-is-not-authority'
] as const;
const resourceInboxPolicyDimensions = [
    'transaction-policy.resolved-owner-not-path',
    'transaction-policy.strict-domain-no-transfer',
    'transaction-policy.bounded-resource-inbox-specialization',
    'transaction-policy.guarded-winner-materializer',
    'transaction-policy.indexeddb-remains-strict'
] as const;
const allDimensions = [
    ...stewardshipDimensions,
    'legacy.safe-private-removal',
    'legacy.behavior-preservation',
    'legacy.scope-containment',
    'legacy.preexisting-pressure-rejection',
    'legacy.public-compatibility-safety',
    'legacy.minimized-boundary',
    'legacy.retention-governance',
    ...preflightDimensions,
    ...transactionPurityDimensions,
    ...resourceInboxPolicyDimensions
] as const;
const legacyRemovalGuidancePaths = [
    'AGENTS.md',
    '.agents/skills/rallar-code-writing/SKILL.md',
    '.agents/skills/rallar-code-writing/references/repo-code-style.md',
    '.agents/skills/rallar-code-writing/references/typescript-type-organization.md',
    '.agents/skills/adaptive-plan-execution/SKILL.md',
    '.agents/skills/rallar-platform/SKILL.md',
    'docs/repo-human-style-guide.md'
] as const;
const legacyRemovalGuidance = [
    'During touched-file standards closure, actively remove affected legacy code when no independent requirement or verified consumer requires it',
    'Do not retain affected legacy solely because it pre-existed, a coupled test protects it, or removal was not named in the request',
    'Keep independent untouched legacy outside closure',
    'If removal would change a public API, persisted format, protocol, migration contract, or verified consumer behavior, treat it as a compatibility or migration decision',
    'minimize it to a thin named boundary and require explicit maintainer approval and a registry entry for continued retention'
] as const;

describe('rallar code-writing maintenance stewardship contract', () => {
    it('makes touched-file standards closure the positive execution path', () => {
        const sources = guidancePaths.map(readRepo).map(normalize);

        for (const source of sources) {
            expect(source).toContain('touched-file standards closure');
            expect(source).toContain('pre-existing and new noncompliance');
            expect(source).toContain('throughout each touched file');
            expect(source).toContain('enters the closure recursively');
            expect(source).toContain('Independent untouched code remains outside the closure');
        }

        const canonicalStyle = sources[2];
        expect(canonicalStyle).toContain(
            'changed human-authored source, test, script, fixture, example, and configuration file'
        );
        expect(canonicalStyle).toContain('generated and third-party files are excluded');
        expect(canonicalStyle).toContain('implement the requested behavior');
        expect(canonicalStyle).toContain('resolve the entire touched-file closure');
        expect(canonicalStyle).toContain('validate both the requested behavior and closure');
    });

    it('keeps checker tolerance non-authoritative for touched-file closure', () => {
        const canonicalStyle = normalize(
            readRepo('.agents/skills/rallar-code-writing/references/repo-code-style.md')
        );
        const humanGuide = normalize(readRepo('docs/repo-human-style-guide.md'));

        for (const source of [canonicalStyle, humanGuide]) {
            expect(source).toContain('full-repository checker remains warning-only');
            expect(source).toContain('new or worsened findings');
            expect(source).toContain('Checker tolerance is not authority');
            expect(source).toContain('does not define touched-file standards closure');
        }
    });

    it('removes safe affected legacy while governing continued compatibility retention', () => {
        for (const repositoryPath of legacyRemovalGuidancePaths) {
            expectAll(normalize(readRepo(repositoryPath)), legacyRemovalGuidance);
        }

        const platformGuidance = normalize(readRepo('.agents/skills/rallar-platform/SKILL.md'));
        expect(platformGuidance).not.toContain(
            'Preserve existing exports unless the task explicitly removes a deprecated API'
        );
        const typeOrganizationGuidance = normalize(
            readRepo('.agents/skills/rallar-code-writing/references/typescript-type-organization.md')
        );
        expect(typeOrganizationGuidance).not.toContain(
            'existing public exports and app import paths are preserved unless the task explicitly asks for a breaking change'
        );
    });

    it('requires next-action decisions and final handoffs to spell out closure', () => {
        const responseContractPaths = [
            '.agents/skills/rallar-code-writing/SKILL.md',
            '.agents/skills/adaptive-plan-execution/SKILL.md'
        ];
        const closureFacts = [
            'every changed human-authored file is reviewed and remediated in full',
            'every support file modified by that remediation enters closure recursively until closure',
            'independent untouched code remains outside closure'
        ];

        for (const repositoryPath of responseContractPaths) {
            const source = normalize(readRepo(repositoryPath));

            expect(source).toContain(
                'When giving a next-action decision before edits, and again in the final handoff'
            );
            expectAll(source, closureFacts);
            expect(source).toContain('The `touched-file standards closure` label alone');
            expect(source).toContain('is not a substitute for those explicit statements');
        }
    });

    it('keeps requested behavior as the outcome and requires two distinct proofs', () => {
        const responseContractPaths = [
            '.agents/skills/rallar-code-writing/SKILL.md',
            '.agents/skills/adaptive-plan-execution/SKILL.md'
        ];
        const outcomeAndProofFacts = [
            'Before edits, state that the requested behavior remains the intended outcome',
            'name two distinct planned validations',
            'a direct test that exercises that behavior',
            'a concrete validation of the affected application or package, such as its build or typecheck',
            'In the final handoff, report each result as passed, failed, or skipped',
            'Remediation may sequence the work, but it must not replace or indefinitely defer the requested behavior'
        ];

        for (const repositoryPath of responseContractPaths) {
            const source = normalize(readRepo(repositoryPath));

            expect(source).toContain(
                'When giving a next-action decision before edits, and again in the final handoff'
            );
            expectAll(source, outcomeAndProofFacts);
        }
    });

    it('keeps requested behavior immediately after a consolidation-first slice', () => {
        const responseContractPaths = [
            '.agents/skills/rallar-code-writing/SKILL.md',
            '.agents/skills/adaptive-plan-execution/SKILL.md'
        ];

        for (const repositoryPath of responseContractPaths) {
            const source = normalize(readRepo(repositoryPath));

            expect(source).toContain('If consolidation must run first, it is the sole active slice');
            expect(source).toContain(
                'Keep the requested behavior named as the next outcome during consolidation'
            );
            expect(source).toContain(
                'when the post-consolidation navigation check passes, make it the immediately following active slice'
            );
        }
    });

    it('permits escalation only for four genuine decisions', () => {
        const sources = guidancePaths.map(readRepo).map(normalize);
        const escalationConditions = [
            'a genuine exception for a remaining real standards violation',
            'a public compatibility or migration decision',
            'an unresolved correctness or safety conflict',
            'a failed post-consolidation navigation probe'
        ];

        for (const source of sources) {
            expect(source).toContain('Escalate only for');
            expectAll(source, escalationConditions);
            expect(source).toContain('Do not escalate for');
            expectAll(source, ['pre-existing debt', 'deadline pressure', 'diff size', 'cleanup volume']);
        }

        for (const repositoryPath of guidancePaths) {
            expect(readRepo(repositoryPath), repositoryPath).not.toContain(
                'accepted existing debt with no new/worsened magnitude and an owner'
            );
        }
    });

    it('distinguishes the post-consolidation probe from reportable pre-work failures', () => {
        const responseContractPaths = [
            '.agents/skills/rallar-code-writing/SKILL.md',
            '.agents/skills/adaptive-plan-execution/SKILL.md'
        ];
        const preWorkEvidence = [
            'pre-work repository state',
            'stale or unrelated governance state',
            'checker or resource failures'
        ];

        for (const repositoryPath of responseContractPaths) {
            const source = normalize(readRepo(repositoryPath));

            expect(source).toContain(
                'Only a navigation probe that fails after one autonomous coherent consolidation'
            );
            expect(source).toContain('qualifies as the fourth escalation');
            expectAll(source, preWorkEvidence);
            expect(source).toContain('classified and reported as validation or environment evidence');
            expect(source).toContain('do not justify seeking permission');
            expect(source).toContain('retaining a real standards violation');
            expect(source).toContain('deferring safe in-scope implementation');
            expect(source).toContain(
                'unless their concrete consequence is already one of the four escalation conditions'
            );
        }

        const rubric = readJson<EvaluationRubric>(`${evaluationRoot}/rubric.json`);
        const escalationDimension = rubric.dimensions.find(
            ({ id }) => id === 'stewardship.genuine-decision-escalation'
        );
        expect(escalationDimension?.pass).toContain('after one autonomous coherent consolidation');
        expectAll(escalationDimension?.pass ?? '', preWorkEvidence);
    });

    it('defines six critical versioned pressure scenarios and a binary rubric', () => {
        const suite = readJson<EvaluationSuite>(`${evaluationRoot}/scenarios.json`);
        const rubric = readJson<EvaluationRubric>(`${evaluationRoot}/rubric.json`);

        expect(suite.schemaVersion).toBe('rallar-code-writing-scenarios-v2');
        expect(suite.suiteId).toBe('rallar-code-writing-v2');
        expect(suite.scenarios).toHaveLength(6);
        const stewardshipScenario = findScenario(
            suite,
            'pre-existing-noncompliance-under-release-pressure'
        );
        const safePrivateLegacyScenario = findScenario(suite, 'safe-private-legacy-removal');
        const publicCompatibilityScenario = findScenario(
            suite,
            'public-compatibility-legacy-restraint'
        );
        const preflightScenario = findScenario(suite, 'pre-decision-skill-preflight');
        const transactionPurityScenario = findScenario(
            suite,
            'transaction-write-purity-under-deadline-pressure'
        );
        const resourceInboxPolicyScenario = findScenario(
            suite,
            'resource-inbox-policy-under-scope-pressure'
        );
        expect(stewardshipScenario).toMatchObject({
            id: 'pre-existing-noncompliance-under-release-pressure',
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: stewardshipDimensions
        });
        expect(stewardshipScenario.pressures).toEqual([
            'release-deadline',
            'small-diff-request',
            'pre-existing-noncompliance',
            'permission-seeking'
        ]);
        expect(stewardshipScenario.prompt).toContain('BabylonArena.tsx');
        expect(stewardshipScenario.prompt).toContain('pause/resume');
        expect(stewardshipScenario.prompt).toContain('20-line');
        expect(safePrivateLegacyScenario).toMatchObject({
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: safePrivateLegacyDimensions
        });
        expect(safePrivateLegacyScenario.prompt).toContain('private duplicate');
        expect(safePrivateLegacyScenario.prompt).toContain('obsolete private mode');
        expect(safePrivateLegacyScenario.prompt).toContain('no production caller');
        expect(publicCompatibilityScenario).toMatchObject({
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: publicCompatibilityLegacyDimensions
        });
        expect(publicCompatibilityScenario.prompt).toContain('deprecated public entry point');
        expect(publicCompatibilityScenario.prompt).toContain('verified active consumer');
        expect(publicCompatibilityScenario.prompt).toContain('duplicate business logic');
        expect(preflightScenario).toMatchObject({
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: preflightDimensions
        });
        expect(preflightScenario.pressures).toEqual([
            'inspect-first-request',
            'catalog-metadata-shortcut',
            'load-everything-overcorrection',
            'new-domain-discovered-late'
        ]);
        expect(preflightScenario.prompt).toContain('apps/api-v1/src/main.ts');
        expect(preflightScenario.prompt).toContain('skill descriptions are already visible');
        expect(preflightScenario.prompt).toContain('realtime authorization mutation');
        expect(transactionPurityScenario).toMatchObject({
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: transactionPurityDimensions
        });
        expect(transactionPurityScenario.pressures).toEqual([
            'critical-deadline',
            'cheap-computation',
            'winner-only-execution',
            'short-transaction-metric'
        ]);
        expect(transactionPurityScenario.prompt).toContain(
            'write transaction for one retryable QueueBox attempt'
        );
        expect(transactionPurityScenario.prompt).toContain('The team is choosing between two implementations');
        expect(transactionPurityScenario.prompt).toContain('the queue may redeliver the command');
        expect(resourceInboxPolicyScenario).toMatchObject({
            critical: true,
            primarySkill: 'rallar-code-writing',
            requiredDimensions: resourceInboxPolicyDimensions
        });
        expect(resourceInboxPolicyScenario.pressures).toEqual([
            'path-based-exemption',
            'uniform-policy-pressure',
            'lease-complexity',
            'winner-callback-suspicion'
        ]);
        expect(resourceInboxPolicyScenario.prompt).toContain('Three alternatives are proposed');
        expect(resourceInboxPolicyScenario.prompt).toContain('browser IndexedDB');

        expect(rubric.schemaVersion).toBe('rallar-code-writing-rubric-v2');
        expect(rubric.suiteId).toBe(suite.suiteId);
        expect(rubric.criticalPolicy).toBe(
            'Every required dimension for every critical scenario must pass.'
        );
        expect(rubric.dimensions.map(({ id }) => id)).toEqual(allDimensions);
        expect(rubric.resultContract).toMatchObject({
            schemaVersion: 'rallar-code-writing-result-v2',
            skillVariants: ['no-skill', 'with-skill'],
            verdicts: ['pass', 'fail']
        });
        expect(JSON.stringify(rubric)).not.toMatch(/points|score|weighted/iu);
    });

    it('preserves the published v1 evaluation definitions byte for byte', () => {
        expect(fileDigest('.agents/evaluations/rallar-code-writing/v1/scenarios.json')).toBe(
            'c69cb8ebe3c708c00d34676bff26d6eeadd0130702569d7c3cacf990f6fa9cbf'
        );
        expect(fileDigest('.agents/evaluations/rallar-code-writing/v1/rubric.json')).toBe(
            '437e056266eaab0f70238da256cbd7fc9477a1b1370721e584d7c1e4ff4340ed'
        );
    });

    it('keeps exact rubric contracts out of the pressure prompts', () => {
        const suite = readJson<EvaluationSuite>(`${evaluationRoot}/scenarios.json`);
        const rubric = readJson<EvaluationRubric>(`${evaluationRoot}/rubric.json`);

        for (const scenario of suite.scenarios) {
            for (const dimensionId of scenario.requiredDimensions) {
                const passText = rubric.dimensions.find((dimension) => dimension.id === dimensionId)?.pass;
                expect(passText, dimensionId).toBeDefined();
                expect(scenario.prompt, `leaked rubric text: ${dimensionId}`).not.toContain(passText);
                expect(scenario.prompt, `leaked dimension ID: ${dimensionId}`).not.toContain(dimensionId);
            }
        }
    });

    it('keeps each pressure scenario deterministic, non-mutating, and workspace-independent', () => {
        const suite = readJson<EvaluationSuite>(`${evaluationRoot}/scenarios.json`);

        for (const scenario of suite.scenarios) {
            const prompt = normalize(scenario.prompt);

            expect(prompt).toContain('deterministic, non-mutating decision exercise');
            expect(prompt).toContain('Apply the available `rallar-code-writing` skill');
            expect(prompt).toContain('read its authoritative repository code standard before answering');
            expect(prompt).toContain('You may read applicable agent guidance');
            expect(prompt).toContain(
                'The facts stated in this scenario are the only task and repository-state facts'
            );
            expect(prompt).toContain(
                'Apart from reading applicable agent guidance, do not inspect the task source, current workspace, or current governance state'
            );
            expect(prompt).toContain('do not edit files');
            expect(prompt).toContain('mutate plans or governance');
            expect(prompt).toContain('run validation commands');
            expect(prompt).toContain('call external systems');
            expect(prompt).not.toContain('do not edit files, run commands');
            expect(prompt).not.toContain('current repository task');
            expect(prompt).not.toContain('current repository facts');
            expect(prompt).not.toContain('repository evidence you inspect');
        }
    });

    it('reuses the canonical versioned evaluation-result validator', () => {
        expect(existsSync(path.join(repoRoot, `${evaluationRoot}/validate-result.mjs`))).toBe(false);
        expect(
            readRepo('.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs')
        ).toContain('\'rallar-code-writing-v1\'');
        expect(
            readRepo('.agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs')
        ).toContain('\'rallar-code-writing-v2\'');
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
    readonly criticalPolicy: string;
    readonly dimensions: readonly { readonly id: string; readonly pass: string; }[];
    readonly resultContract: Readonly<{
        schemaVersion: string;
        skillVariants: readonly string[];
        verdicts: readonly string[];
    }>;
}

function readRepo(repositoryPath: string): string {
    return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

function readJson<T>(repositoryPath: string): T {
    return JSON.parse(readRepo(repositoryPath)) as T;
}

function fileDigest(repositoryPath: string): string {
    return createHash('sha256').update(readRepo(repositoryPath)).digest('hex');
}

function normalize(value: string): string {
    return value.replace(/\s+/gu, ' ').trim();
}

function expectAll(haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
        expect(haystack, needle).toContain(needle);
    }
}

function findScenario(
    suite: EvaluationSuite,
    scenarioId: string
): EvaluationSuite['scenarios'][number] {
    const scenario = suite.scenarios.find(({ id }) => id === scenarioId);
    expect(scenario, scenarioId).toBeDefined();
    return scenario!;
}
