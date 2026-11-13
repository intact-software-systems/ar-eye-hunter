import { load } from 'js-yaml';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
    readonly 'continue-on-error'?: boolean;
    readonly if?: string;
    readonly name?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
    readonly steps: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

interface ObservationWorkflowJob extends WorkflowJob {
    readonly 'continue-on-error'?: boolean;
    readonly env?: Readonly<Record<string, string>>;
}

interface ObservationWorkflowDocument {
    readonly jobs: Readonly<Record<string, ObservationWorkflowJob>>;
}

interface ActionInput {
    readonly default: string;
}

interface ActionRuns {
    readonly steps: readonly WorkflowStep[];
}

interface ActionDocument {
    readonly inputs: Readonly<Record<string, ActionInput>>;
    readonly runs: ActionRuns;
}

const repoRoot = path.resolve(__dirname, '../../..');
const LANE_SETUP_ACTION = './.github/actions/release-gate-setup';
const githubAutomationRoots = ['.github/actions', '.github/workflows'] as const;
const requiredActionReferences = {
    checkout: 'actions/checkout@v7',
    'setup-node': 'actions/setup-node@v7',
    'upload-artifact': 'actions/upload-artifact@v7'
} as const;

type GovernedActionName = keyof typeof requiredActionReferences;

async function findYamlFiles(relativeDirectory: string): Promise<string[]> {
    const entries = await readdir(path.join(repoRoot, relativeDirectory), {
        withFileTypes: true
    });
    const files: string[] = [];

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relativePath = path.join(relativeDirectory, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await findYamlFiles(relativePath)));
            continue;
        }

        if (/\.ya?ml$/u.test(entry.name)) {
            files.push(relativePath);
        }
    }

    return files;
}

function sourceLine(source: string, offset: number): number {
    return source.slice(0, offset).split('\n').length;
}

describe('GitHub Actions runtime governance', () => {
    it('resolves an immutable merge-base range and invokes both changed checkers directly', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );

        expect(releaseGate).toContain('node scripts/resolve-changed-review-range.mjs');
        expect(releaseGate).toContain('tee -a "$GITHUB_OUTPUT"');
        expect(releaseGate).toContain('steps.changed_review_range.outputs.base');
        expect(releaseGate).toContain('steps.changed_review_range.outputs.head');
        expect(releaseGate).toContain('node scripts/check-changed-repo-style.mjs');
        expect(releaseGate).toContain('node scripts/check-test-structure-coupling.mjs --changed');
        expect(releaseGate).not.toContain('npm run check:test-structure-coupling');
    });

    it('keeps the IDE navigation report out of the blocking Static checks lane', async () => {
        const releaseGate = await readYaml<WorkflowDocument>('.github/workflows/release-gate.yml');
        const steps = releaseGate.jobs.checks.steps;
        const setupIndex = steps.findIndex((step) => step.uses === LANE_SETUP_ACTION);
        const changedStyleIndex = steps.findIndex((step) => step.run?.startsWith('node scripts/check-changed-repo-style.mjs'));

        expect(steps.map((step) => step.run)).not.toContain('npm run check:repo-style:navigation-details');
        expect(setupIndex).toBeGreaterThan(-1);
        expect(changedStyleIndex).toBeGreaterThan(setupIndex);
    });

    it('reports IDE navigation in a non-blocking reusable workflow after lane setup', async () => {
        const observation = await readYaml<ObservationWorkflowDocument>('.github/workflows/navigation-report-observation.yml');
        const job = observation.jobs['navigation-report'];
        const steps = job.steps;
        const setupIndex = steps.findIndex((step) => step.uses === LANE_SETUP_ACTION);
        const navigationIndex = steps.findIndex((step) => step.run === 'npm run check:repo-style:navigation-details');

        expect(job['continue-on-error']).toBe(true);
        expect(job.env?.['NODE_OPTIONS']).toBe('--max-old-space-size=6144');
        expect(setupIndex).toBeGreaterThan(-1);
        expect(navigationIndex).toBeGreaterThan(setupIndex);
    });

    it('installs Bun through the shared setup action without a separate cache step', async () => {
        const releaseGate = await readYaml<WorkflowDocument>('.github/workflows/release-gate.yml');
        const setup = await readYaml<ActionDocument>('.github/actions/release-gate-setup/action.yml');
        const setupBunStep = setup.runs.steps.find((step) => step.uses === 'oven-sh/setup-bun@v2');
        const setupSteps = Object.values(releaseGate.jobs).flatMap((job) => job.steps).filter((step) => step.uses === LANE_SETUP_ACTION);
        const bunLanes = setupSteps.filter((step) => step.with?.['bun'] === 'true');

        expect(setupBunStep).toMatchObject({
            if: '${{ inputs.bun == \'true\' }}'
        });
        expect(setup.inputs['bun-version'].default).toBe('1.4.4');
        // No lane caches a runtime directly; npm handles its own cache through setup-node.
        expect(setup.runs.steps.filter((step) => step.uses?.startsWith('actions/cache'))).toEqual([]);
        expect(bunLanes.length).toBeGreaterThan(0);
        for (const job of Object.values(releaseGate.jobs)) {
            expect(job.steps[0]).toMatchObject({
                uses: 'actions/checkout@v7',
                with: { ref: '${{ github.event_name == \'workflow_dispatch\' && github.sha || inputs.candidate_ref }}' }
            });
            expect(job.steps.filter((step) => step.uses === 'actions/cache@v6')).toEqual([]);
        }
    });

    it('uses the exact merge base when the trusted base tip has diverged', async () => {
        const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rallar-changed-review-range-'));
        try {
            runGit(fixtureRoot, ['init']);
            runGit(fixtureRoot, ['config', 'user.email', 'test@example.com']);
            runGit(fixtureRoot, ['config', 'user.name', 'Test User']);
            mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
            writeFileSync(path.join(fixtureRoot, 'contract.txt'), 'common\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'common']);
            const common = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
            runGit(fixtureRoot, ['branch', 'feature']);
            writeFileSync(path.join(fixtureRoot, 'base.txt'), 'advanced base\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'advance trusted base']);
            const trustedBaseTip = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
            runGit(fixtureRoot, ['switch', 'feature']);
            writeFileSync(path.join(fixtureRoot, 'feature.txt'), 'candidate\n');
            runGit(fixtureRoot, ['add', '.']);
            runGit(fixtureRoot, ['commit', '-m', 'candidate']);
            const candidateHead = runGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();

            const output = execFileSync(
                process.execPath,
                [
                    path.join(repoRoot, 'scripts/resolve-changed-review-range.mjs'),
                    trustedBaseTip,
                    candidateHead
                ],
                { cwd: fixtureRoot, encoding: 'utf8' }
            );

            expect(output).toContain(`trusted_base_tip=${trustedBaseTip}`);
            expect(output).toContain(`base=${common}`);
            expect(output).toContain(`head=${candidateHead}`);
            expect(output).not.toContain(`base=${trustedBaseTip}`);
        }
        finally {
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });

    it('cannot bypass structure review by replacing the package script with a no-op', async () => {
        const releaseGate = await readFile(
            path.join(repoRoot, '.github/workflows/release-gate.yml'),
            'utf8'
        );
        const structureCommand = releaseGate.match(
            /node scripts\/check-test-structure-coupling\.mjs\s+--changed/u
        )?.[0];

        expect(structureCommand).toBeDefined();
        expect(structureCommand).not.toContain('npm run');
        expect(structureCommand).not.toContain('check:test-structure-coupling');
    });

    it('uses the Node 24 action releases throughout executable automation', async () => {
        const yamlFiles = (await Promise.all(githubAutomationRoots.map(findYamlFiles))).flat();
        const observedActions = new Set<GovernedActionName>();
        const violations: string[] = [];
        const actionReference = /uses:\s*actions\/(checkout|setup-node|upload-artifact)@([^\s#'"]+)/gu;

        for (const relativePath of yamlFiles) {
            const source = await readFile(path.join(repoRoot, relativePath), 'utf8');

            for (const match of source.matchAll(actionReference)) {
                const actionName = match[1] as GovernedActionName;
                const actualReference = `actions/${actionName}@${match[2]}`;
                const expectedReference = requiredActionReferences[actionName];

                observedActions.add(actionName);

                if (actualReference !== expectedReference) {
                    violations.push(
                        `${relativePath}:${sourceLine(source, match.index)} uses ${actualReference}; expected ${expectedReference}`
                    );
                }
            }
        }

        expect([...observedActions].sort()).toEqual(Object.keys(requiredActionReferences).sort());
        expect(violations).toEqual([]);
    });
});

function runGit(root: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

async function readYaml<T>(relativePath: string): Promise<T> {
    return load(await readFile(path.join(repoRoot, relativePath), 'utf8')) as T;
}
