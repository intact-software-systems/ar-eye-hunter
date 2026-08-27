import { readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');

interface WorkflowStep {
    readonly name?: string;
    readonly uses?: string;
    readonly run?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly with?: Readonly<Record<string, string>>;
}

describe('governance decision GitHub workflows', () => {
    it('keeps App credentials behind a trusted-main administrator preflight', () => {
        const workflow = readWorkflow('.github/workflows/governance-decision.yml');

        expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
            mode: { required: true, type: 'choice', options: ['preview', 'apply'] },
            request_json: { required: false, type: 'string' },
            request_blob_oid: { required: false, type: 'string' }
        });
        expect(workflow.jobs.preflight.environment).toBeUndefined();
        expect(workflow.jobs.preflight.permissions).toMatchObject({
            actions: 'read',
            contents: 'read'
        });
        expect(workflow.jobs.apply).toMatchObject({
            needs: 'preflight',
            if: 'needs.preflight.outputs.mode == \'apply\'',
            environment: 'governance-decisions-main'
        });
        const applySteps = workflow.jobs.apply.steps as readonly WorkflowStep[];
        const appTokenIndex = applySteps.findIndex(
            (step) => step.uses === 'actions/create-github-app-token@v2'
        );
        const repeatedPreflightIndex = applySteps.findIndex(
            (step) => step.name === 'Repeat trusted-main administrator preflight'
        );
        expect(repeatedPreflightIndex).toBeGreaterThan(-1);
        expect(appTokenIndex).toBeGreaterThan(repeatedPreflightIndex);
        const gateEvidenceIndex = applySteps.findIndex(
            (step) => step.name === 'Read exact gate evidence with the workflow token'
        );
        expect(gateEvidenceIndex).toBeGreaterThan(repeatedPreflightIndex);
        expect(gateEvidenceIndex).toBeLessThan(appTokenIndex);
        expect(applySteps[gateEvidenceIndex]).toMatchObject({
            env: { GH_TOKEN: '${{ github.token }}' },
            run: expect.stringContaining('materialize-gate-evidence.mjs')
        });
        const applyIndex = applySteps.findIndex(
            (step) => step.name === 'Apply one atomic governance decision commit'
        );
        expect(applyIndex).toBeGreaterThan(appTokenIndex);
        expect(
            applySteps.find((step) => step.name === 'Recheck administrator with the App token')
        ).toBeUndefined();
        expect(applySteps[appTokenIndex]).toMatchObject({
            with: {
                'app-id': '${{ vars.GOVERNANCE_APP_ID }}',
                'private-key': '${{ secrets.GOVERNANCE_APP_PRIVATE_KEY }}',
                'permission-contents': 'write'
            }
        });
        for (const jobName of ['preflight', 'apply']) {
            const preflightStep = workflow.jobs[jobName].steps.find((step: { name?: string; }) => step.name?.includes('administrator preflight'));
            expect(preflightStep.run).toContain('.permission');
            expect(preflightStep.run).toContain('.user.login');
        }
        const applyRun = applySteps.find(
            (step) => step.name === 'Apply one atomic governance decision commit'
        );
        expect(applyRun).toMatchObject({
            env: {
                GOVERNANCE_APP_SLUG: '${{ steps.app-token.outputs.app-slug }}',
                GOVERNANCE_CONFIGURED_APP_SLUG: '${{ vars.GOVERNANCE_APP_SLUG }}',
                GOVERNANCE_PREFLIGHT_ACTOR: '${{ github.actor }}',
                GOVERNANCE_PREFLIGHT_SHA: '${{ github.sha }}',
                GOVERNANCE_PREFLIGHT_WORKFLOW_REF: '${{ github.workflow_ref }}',
                GOVERNANCE_GATE_EVIDENCE_PATH: '${{ runner.temp }}/governance-gate-evidence.json'
            }
        });
        if (!applyRun?.env) {
            throw new Error('Expected the apply step to declare an env block');
        }
        expect(applyRun.env.GH_TOKEN).toBe('${{ steps.app-token.outputs.token }}');
    });

    it('documents the repository-visible slug and protected App credential boundary', () => {
        const readme = readFileSync(
            path.join(repoRoot, 'scripts/governance-decisions/README.md'),
            'utf8'
        );

        expect(readme).toContain('`GOVERNANCE_APP_SLUG` is a repository variable');
        expect(readme).toContain('`GOVERNANCE_APP_ID`');
        expect(readme).toContain('repository variables');
        expect(readme).toContain('`GOVERNANCE_APP_PRIVATE_KEY` is a repository Actions');
        expect(readme.replace(/\s+/gu, ' ')).toContain(
            'only the dedicated governance App and the repository-admin role'
        );
        expect(readme).toContain('must not grant any additional');
        expect(readme.replace(/\s+/gu, ' ')).toContain('ordinary changes remain pull-request-based');
    });

    it('keeps authenticated exceptions separate from ordinary PR completion', () => {
        const readme = readFileSync(
            path.join(repoRoot, 'scripts/governance-decisions/README.md'),
            'utf8'
        );
        const guide = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
        const planSkill = readFileSync(
            path.join(repoRoot, '.agents/skills/adaptive-plan-execution/SKILL.md'),
            'utf8'
        );
        const publicationSkill = readFileSync(
            path.join(repoRoot, '.agents/skills/publishing-plan-progress/SKILL.md'),
            'utf8'
        );
        for (const source of [readme, guide]) {
            expect(source).toContain('just-in-time approval');
            expect(source).toMatch(/(?:a )?changed request or (?:expected )?head\s+invalidates/iu);
            expect(source).toMatch(/fabricate\s+completion/iu);
        }
        expect(planSkill).not.toContain('governance:decide');
        expect(planSkill).toContain('The GitHub pull request is the remote delivery entity');
        expect(guide).toContain('separate from ordinary pull request delivery');
        expect(guide).toContain('cannot be used as pull request completion evidence');
        expect(publicationSkill).toMatch(/Commit and\s+push approvals are independent/u);
    });

    it('classifies exact decisions before deploy and distributed runtime work', () => {
        const deploy = readWorkflow('.github/workflows/deploy.yml');
        const distributed = readWorkflow(
            '.github/workflows/hetzner-supported-distributed-manifests.yml'
        );

        for (const workflow of [deploy, distributed]) {
            expect(workflow.on.push).toMatchObject({
                branches: ['main'],
                'paths-ignore': ['performance-observations/**']
            });
        }

        expect(deploy.jobs['governance-decision']).toMatchObject({
            permissions: { actions: 'read', contents: 'read' },
            outputs: {
                decision_only: '${{ steps.resolve.outputs.decision_only }}',
                invalid_governance: '${{ steps.resolve.outputs.invalid_governance }}'
            }
        });
        expect(deploy.jobs['release-gate']).toMatchObject({
            needs: 'governance-decision',
            if: expect.stringContaining('needs.governance-decision.outputs.decision_only != \'true\'')
        });
        expect(deploy.jobs['release-gate'].if).toContain('always()');
        expect(deploy.jobs['governance-decision-checks']).toMatchObject({
            needs: 'governance-decision',
            if: 'needs.governance-decision.outputs.decision_only == \'true\''
        });
        expect(deploy.jobs['invalid-governance-decision']).toMatchObject({
            needs: 'governance-decision',
            if: 'needs.governance-decision.outputs.invalid_governance == \'true\''
        });
        expect(
            deploy.jobs['governance-decision'].steps.find(
                (step: { name?: string; }) => step.name === 'Record authenticated governance admission'
            )
        ).toMatchObject({
            if: '${{ steps.verify.outcome == \'success\' && steps.resolve.outputs.decision_only == \'true\' && steps.resolve.outputs.invalid_governance == \'false\' }}'
        });

        expect(distributed.jobs['governance-decision']).toMatchObject({
            permissions: { actions: 'read', contents: 'read' },
            outputs: {
                decision_only: '${{ steps.resolve.outputs.decision_only }}',
                invalid_governance: '${{ steps.resolve.outputs.invalid_governance }}'
            }
        });
        expect(distributed.jobs['invalid-governance-decision']).toMatchObject({
            needs: 'governance-decision',
            if: 'needs.governance-decision.outputs.invalid_governance == \'true\''
        });
        expect(distributed.jobs.selection.needs).toBe('governance-decision');
        expect(distributed.jobs.selection.if).toContain('always()');
        const selectionRun = distributed.jobs.selection.steps.find(
            (step: { name?: string; }) => step.name === 'Classify distributed validation risk'
        ).run as string;
        expect(selectionRun).toContain('reason_code=governance-decision');
        expect(selectionRun).toContain('selected=false');
    });

    it('keeps mixed or failed verification on every existing runtime path', () => {
        for (
            const workflowPath of [
                '.github/workflows/deploy.yml',
                '.github/workflows/hetzner-supported-distributed-manifests.yml'
            ]
        ) {
            const workflow = readWorkflow(workflowPath);
            const classifier = workflow.jobs['governance-decision'];
            const candidate = classifier.steps.find((step: { id?: string; }) => step.id === 'candidate');
            const verify = classifier.steps.find((step: { id?: string; }) => step.id === 'verify');
            const resolve = classifier.steps.find((step: { id?: string; }) => step.id === 'resolve');

            expect(candidate).toMatchObject({ 'continue-on-error': true });
            expect(candidate.run).toContain('governance_candidate=true');
            expect(verify).toMatchObject({
                'continue-on-error': true,
                env: { GOVERNANCE_APP_SLUG: '${{ vars.GOVERNANCE_APP_SLUG }}' }
            });
            expect(verify.run).toContain('governance:decide -- verify-commit');
            expect(resolve.if).toBe('${{ always() }}');
            expect(resolve.run).toContain('classify-governance-push.mjs resolve');

            const invalidJob = workflow.jobs['invalid-governance-decision'];
            expect(invalidJob.steps[0].run).toContain('exit 1');
        }

        const deploy = readWorkflow('.github/workflows/deploy.yml');
        expect(deploy.jobs['release-gate'].needs).toBe('governance-decision');
        expect(deploy.jobs['release-gate'].if).toContain('decision_only != \'true\'');
        expect(deploy.jobs['release-gate'].if).toContain('always()');
        const distributed = readWorkflow(
            '.github/workflows/hetzner-supported-distributed-manifests.yml'
        );
        expect(distributed.jobs.selection.needs).toBe('governance-decision');
        expect(distributed.jobs.selection.if).toContain('always()');
    });

    it('keeps receipt provenance on the retained Tier-3 path and out of ordinary PR checks', () => {
        const governanceGate = readWorkflow('.github/workflows/governance-gate.yml');
        const releaseGate = readWorkflow('.github/workflows/release-gate.yml');
        const deploy = readWorkflow('.github/workflows/deploy.yml');

        expect(governanceGate.permissions).toEqual({ contents: 'read' });
        expect(releaseGate.permissions).toEqual({ contents: 'read', actions: 'read' });
        expect(deploy.permissions).toMatchObject({ contents: 'read', actions: 'read' });
        for (
            const name of [
                'Check changed repository style',
                'Check changed test structure coupling'
            ]
        ) {
            expect(
                releaseGate.jobs['release-gate'].steps.find((step: any) => step.name === name).env
            ).toBeUndefined();
        }
        expect(deploy.jobs['governance-decision-checks']).toMatchObject({
            permissions: { actions: 'read', contents: 'read' }
        });
        expect(
            deploy.jobs['governance-decision-checks'].steps.find(
                (step: any) => step.name === 'Run focused governance verification'
            )
        ).toMatchObject({ env: { STRUCTURE_BASE: '${{ github.event.before }}' } });
    });
});

function readWorkflow(relativePath: string): any {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as any;
}
