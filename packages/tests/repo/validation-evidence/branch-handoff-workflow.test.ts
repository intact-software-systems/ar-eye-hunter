import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it
} from 'vitest';

interface HandoffStep {
    readonly name?: string;
    readonly if?: string;
    readonly run?: string;
}

interface HandoffJob {
    readonly if?: string;
    readonly needs?: string | readonly string[];
    readonly steps?: readonly HandoffStep[];
}

interface HandoffWorkflow {
    readonly on: { readonly pull_request: { readonly types: readonly string[]; }; };
    readonly jobs: Readonly<Record<string, HandoffJob>>;
}

interface HandoffScenario {
    readonly draft: boolean;
    readonly cancelled: boolean;
    readonly governanceResult: string;
}

const workflowPath = path.resolve(__dirname, '../../../../.github/workflows/branch-release-gate.yml');

describe('PR handoff admission', () => {
    it.each(['opened', 'synchronize', 'reopened', 'converted_to_draft', 'labeled', 'unlabeled'])(
        'keeps draft %s events inexpensive without approving release',
        (event) => {
            const workflow = readHandoffWorkflow();
            const scenario = { draft: true, cancelled: false, governanceResult: 'success' };

            expect(workflow.on.pull_request.types).toContain(event);
            expect(isAdmitted(workflow.jobs['governance-gate'].if, scenario)).toBe(true);
            expect(isAdmitted(workflow.jobs['draft-checks']?.if, scenario)).toBe(true);
            for (
                const job of [
                    'validation-evidence',
                    'game-changes',
                    'release-gate',
                    'games-release-gate',
                    'alm-conformance-observation',
                    'publish-validation-evidence',
                    'rtc-observation-integrity'
                ]
            ) {
                expect(isAdmitted(workflow.jobs[job].if, scenario), job).toBe(false);
            }
            const result = workflow.jobs['branch-release-result'];
            expect(isAdmitted(result.if, scenario)).toBe(true);
            expect(isAdmitted(readStep(result, 'Await release handoff').if, scenario)).toBe(true);
            expect(isAdmitted(readStep(result, 'Conclude Branch Release Gate').if, scenario)).toBe(false);
        }
    );

    it.each(['ready_for_review', 'synchronize', 'reopened'])(
        'validates ready candidates on %s using the broad suite',
        (event) => {
            const workflow = readHandoffWorkflow();
            const scenario = { draft: false, cancelled: false, governanceResult: 'success' };

            expect(workflow.on.pull_request.types).toContain(event);
            expect(workflow.jobs['draft-checks']).toBeDefined();
            expect(isAdmitted(workflow.jobs['draft-checks']?.if, scenario)).toBe(false);
            for (const job of ['validation-evidence', 'game-changes', 'release-gate', 'games-release-gate', 'publish-validation-evidence']) {
                expect(isAdmitted(workflow.jobs[job].if, scenario), job).toBe(true);
            }
            const result = workflow.jobs['branch-release-result'];
            expect(isAdmitted(readStep(result, 'Await release handoff').if, scenario)).toBe(false);
            expect(isAdmitted(readStep(result, 'Conclude Branch Release Gate').if, scenario)).toBe(true);
        }
    );

    it.each([
        { draft: false, cancelled: true, governanceResult: 'cancelled' },
        { draft: false, cancelled: false, governanceResult: 'failure' }
    ])('still concludes an unsuccessful ready run: %j', (scenario) => {
        const workflow = readHandoffWorkflow();

        expect(isAdmitted(workflow.jobs['release-gate'].if, scenario)).toBe(false);
        expect(isAdmitted(workflow.jobs['games-release-gate'].if, scenario)).toBe(false);
        expect(isAdmitted(workflow.jobs['branch-release-result'].if, scenario)).toBe(true);
    });

    it('refuses draft release approval with an actionable summary', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'branch-handoff-'));
        try {
            const step = readStep(readHandoffWorkflow().jobs['branch-release-result'], 'Await release handoff');
            expect(step.run).toBeTypeOf('string');
            const summaryPath = path.join(directory, 'summary.md');
            const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run!], {
                cwd: directory,
                env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
                encoding: 'utf8'
            });

            expect(result.status).toBe(1);
            expect(readFileSync(summaryPath, 'utf8')).toMatch(/draft.*ready for review/is);
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

function readHandoffWorkflow(): HandoffWorkflow {
    const workflow = load(readFileSync(workflowPath, 'utf8'));
    if (typeof workflow !== 'object' || workflow === null || !('jobs' in workflow) || !('on' in workflow)) {
        throw new Error('Branch workflow must declare jobs and triggers');
    }
    return workflow as HandoffWorkflow;
}

function readStep(job: HandoffJob, name: string): HandoffStep {
    const step = job.steps?.find((candidate) => candidate.name === name);
    if (step === undefined) {
        throw new Error(`Missing handoff step: ${name}`);
    }
    return step;
}

function isAdmitted(condition: string | undefined, scenario: HandoffScenario): boolean {
    const successful = scenario.governanceResult === 'success' && !scenario.cancelled;
    if (condition === undefined) {
        return successful;
    }
    const expression = /^\$\{\{([\s\S]+)\}\}$/u.exec(condition)?.[1];
    if (expression === undefined) {
        throw new Error(`Unsupported handoff condition: ${condition}`);
    }
    if (!/\b(?:always|cancelled|success|failure)\s*\(/u.test(expression) && !successful) {
        return false;
    }
    return runInNewContext(expression.replace(/needs\.([\w-]+)/gu, 'needs["$1"]'), {
        github: { event: { pull_request: { draft: scenario.draft } } },
        needs: {
            'governance-gate': { result: scenario.governanceResult },
            'validation-evidence': { result: 'success', outputs: { mode: 'broad' } },
            'game-changes': { result: 'success', outputs: { run_games: 'true' } },
            'release-gate': { result: 'success' },
            'games-release-result': { outputs: { result: 'success' } }
        },
        always: () => true,
        cancelled: () => scenario.cancelled
    });
}
