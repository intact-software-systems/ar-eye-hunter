import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('general agent guidance fresh-agent evaluation contract', () => {
    it('defines one neutral versioned routing-pressure scenario', () => {
        const evaluation = JSON.parse(
            readFileSync(path.join(import.meta.dirname, 'evaluation-v1.json'), 'utf8')
        ) as EvaluationContract;

        expect(evaluation.schemaVersion).toBe('general-agent-guidance-evaluation-v2');
        expect(evaluation.execution).toEqual({
            model: 'gpt-5.6-terra',
            reasoningEffort: 'medium',
            forkTurns: 'none',
            singleShot: true,
            repositoryRootResolution: 'suite-checkout'
        });
        expect(evaluation.repetitionsPerVariant).toBe(5);
        expect(evaluation.runtimeGuidanceManifest).toBe(
            'packages/tests/repo/general-agent-guidance/runtime-guidance-v2.json'
        );
        const runtimeGuidance = JSON.parse(readRepo(evaluation.runtimeGuidanceManifest)) as {
            schemaVersion?: string;
            automaticAuthorities?: readonly Readonly<Record<string, unknown>>[];
        };
        expect(runtimeGuidance.schemaVersion).toBe('general-agent-guidance-runtime-v2');
        expect(runtimeGuidance.automaticAuthorities?.map(({ id }) => id)).toEqual([
            'codex-system-and-developer-runtime',
            'repository-agents-guide',
            'mandatory-using-superpowers-skill'
        ]);
        expect(evaluation.scenario.pressures.length).toBeGreaterThanOrEqual(3);
        expect(evaluation.scenario.prompt).not.toContain('adaptive-plan-execution');
        expect(evaluation.scenario.prompt).not.toContain('organizing-repository-structure');
        expect(evaluation.scenario.prompt).not.toContain('publishing-plan-progress');
        expect(evaluation.scenario.prompt).not.toContain('rallar-testing');
        expect(evaluation.automaticInputs).toEqual([
            { id: 'codex-runtime-guidance', source: 'runtime-injected-system-and-developer' },
            { id: 'repository-guide', source: 'runtime-injected-baseline-AGENTS.md' },
            { id: 'mandatory-using-superpowers', source: 'superpowers:using-superpowers@6.2.0' }
        ]);
        expect(evaluation.variants.map(({ id }) => id)).toEqual(['no-skill', 'with-canonical-skills']);
        expect(evaluation.variants[0]).toMatchObject({
            id: 'no-skill',
            treeSource: { kind: 'immutable-head-tree' },
            explicitInputs: []
        });
        expect(evaluation.variants[1]).toMatchObject({
            id: 'with-canonical-skills',
            treeSource: { kind: 'full-worktree-git-tree' },
            explicitInputs: [
                'AGENTS.md',
                '.agents/skills/adaptive-plan-execution/SKILL.md',
                '.agents/skills/organizing-repository-structure/SKILL.md',
                '.agents/skills/rallar-testing/SKILL.md',
                '.agents/skills/publishing-plan-progress/SKILL.md'
            ]
        });
        expect(evaluation.requiredDimensions.map(({ id }) => id)).toEqual([
            'routing.working-plan',
            'routing.repository-structure',
            'delivery.pr-state-first',
            'delivery.base-movement-noop',
            'validation.proportional-local-scope',
            'publication.pr-authority'
        ]);
        expect(evaluation.evidenceContract).toEqual({
            schemaVersion: 'general-agent-guidance-evidence-ledger-v2',
            digestAlgorithm: 'sha256',
            rawOutputPolicy: 'verbatim-agent-response-separate-from-score-artifact',
            statuses: ['running', 'completed', 'failed', 'excluded', 'aborted'],
            requiredPerRunFields: [
                'runId',
                'variant',
                'status',
                'treeIdentity',
                'automaticInputs',
                'explicitInputs',
                'inputBundleDigest',
                'promptDigest',
                'runtimePreambleArtifact',
                'runtimePreambleDigest',
                'exactInvocationDigest',
                'model',
                'reasoningEffort',
                'forkTurns',
                'singleShot',
                'freshAgentId',
                'startedAt',
                'completedAt',
                'rawOutputArtifact',
                'rawOutputDigest',
                'scoreArtifact',
                'scoreDigest'
            ]
        });
        for (const variant of evaluation.variants) {
            for (const explicitInput of variant.explicitInputs) {
                if (explicitInput !== 'AGENTS.md') {
                    expect(readRepo(explicitInput), explicitInput).toMatch(/^---\n/u);
                }
            }
        }
    });
});

function readRepo(repositoryPath: string): string {
    return readFileSync(path.join(repoRoot, repositoryPath), 'utf8');
}

interface EvaluationContract {
    readonly schemaVersion: string;
    readonly repetitionsPerVariant: number;
    readonly runtimeGuidanceManifest: string;
    readonly execution: Readonly<Record<string, unknown>>;
    readonly automaticInputs: readonly Readonly<{ id: string; source: string; }>[];
    readonly scenario: {
        readonly pressures: readonly string[];
        readonly prompt: string;
    };
    readonly variants: readonly {
        readonly id: string;
        readonly explicitInputs: readonly string[];
        readonly treeSource: Readonly<Record<string, unknown>>;
    }[];
    readonly requiredDimensions: readonly {
        readonly id: string;
        readonly pass: string;
    }[];
    readonly evidenceContract: Readonly<Record<string, unknown>>;
}
