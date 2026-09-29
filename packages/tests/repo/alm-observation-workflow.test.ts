import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
    readonly run?: string;
}

interface WorkflowJob {
    readonly if?: string;
    readonly needs?: string | readonly string[];
    readonly steps?: readonly WorkflowStep[];
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const ALM_WORKFLOW = './.github/workflows/alm-conformance-observation.yml';

describe('ALM conformance observation workflow', () => {
    it('runs the observation lane in its own reusable workflow, outside the Release Gate', () => {
        const observation = readWorkflow('.github/workflows/alm-conformance-observation.yml');
        const releaseGate = readWorkflow('.github/workflows/release-gate.yml');
        const commands = Object.values(observation.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''));

        expect(commands).toContain('npm run test:rallar:full-stack:memory:alm');
        expect(Object.keys(releaseGate.jobs)).not.toContain('alm-conformance-observation');
    });

    it('starts the observation beside the Branch Release Gate without making its result wait for it', () => {
        const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');
        const observation = workflow.jobs['alm-conformance-observation'];
        const result = workflow.jobs['branch-release-result'];

        expect(observation.uses).toBe(ALM_WORKFLOW);
        expect(observation.with?.candidate_ref).toBe('${{ github.event.pull_request.head.sha }}');
        expect(observation.if).toContain('!cancelled()');
        expect(observation.if).toContain('outputs.mode == \'broad\'');
        expect(toNeeds(result)).not.toContain('alm-conformance-observation');
        expect(toNeeds(workflow.jobs['publish-validation-evidence'])).not.toContain('alm-conformance-observation');
    });

    it('starts the observation beside the main deploy without making a deployment wait for it', () => {
        const workflow = readWorkflow('.github/workflows/deploy.yml');

        expect(workflow.jobs['alm-conformance-observation'].uses).toBe(ALM_WORKFLOW);
        expect(workflow.jobs['alm-conformance-observation'].with?.candidate_ref).toBe('${{ github.sha }}');
        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            expect(toNeeds(job), jobId).not.toContain('alm-conformance-observation');
        }
    });
});

function readWorkflow(relativePath: string): WorkflowDocument {
    return load(readFileSync(path.join(repoRoot, relativePath), 'utf8')) as WorkflowDocument;
}

function toNeeds(job: WorkflowJob): readonly string[] {
    return typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
}
