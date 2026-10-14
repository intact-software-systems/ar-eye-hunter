import { load } from 'js-yaml';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';

import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';
import { createDefaultStateWritePerformanceArtifact } from '../shared-server/performance/state-write/test-support/state-write-performance-artifact-fixture.ts';

type JsonValue = string | number | boolean | null | JsonRecord | readonly JsonValue[];
interface JsonRecord {
    readonly [key: string]: JsonValue;
}

interface WorkflowStep {
    readonly name: string;
    readonly run: string;
    readonly uses: string;
    readonly condition: string;
    readonly settings: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}
interface MeasurementWorkflow {
    readonly admission: string;
    readonly concurrency: Readonly<Record<string, string | number | boolean | readonly string[]>>;
    readonly inputs: Readonly<Record<string, Readonly<Record<string, string | number | boolean | readonly string[]>>>>;
    readonly environment: Readonly<Record<string, string>>;
    readonly steps: readonly WorkflowStep[];
}
interface MeasurementPolicy {
    readonly mode: 'comparison' | 'diagnostic';
    readonly concurrency: string;
    readonly steps: readonly WorkflowStep[];
}
interface CommandCall {
    readonly command: string;
    readonly benchmarkAlive: boolean | null;
    readonly descendantAlive: boolean | null;
    readonly args: readonly string[];
}
interface MeasurementFixture {
    readonly root: string;
    readonly output: string;
    readonly environment: NodeJS.ProcessEnv;
}

const repoRoot = path.resolve(__dirname, '../../..');
const candidate = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const workflowPath = '.github/workflows/api-v1-state-write-pr-measurement.yml';
const owner = 'apps/api-v1/scripts/perf/run-api-v1-state-write-measurement.mjs';

describe('hosted state-write admission', { timeout: 20000 }, () => {
    it('defaults manual runs and the supported same-repository label to comparison and isolates unrelated labels and modes', () => {
        const workflow = readWorkflow();
        expect(workflow.inputs.mode).toMatchObject({ required: false, type: 'choice', default: 'comparison', options: ['comparison', 'diagnostic'] });
        const admit = new Function('github', 'inputs', `return (${workflow.admission});`);
        expect(decodeMeasurementCondition(admit({ event_name: 'workflow_dispatch', event: {} }, { mode: 'diagnostic' }))).toBe(true);
        expect(
            decodeMeasurementCondition(admit({
                event_name: 'pull_request',
                repository: 'owner/repo',
                event: { label: { name: 'measure-state-write' }, pull_request: { head: { repo: { full_name: 'owner/repo' } } } }
            }, {}))
        ).toBe(true);
        expect(
            decodeMeasurementCondition(admit({
                event_name: 'pull_request',
                repository: 'owner/repo',
                event: { label: { name: 'unrelated' }, pull_request: { head: { repo: { full_name: 'owner/repo' } } } }
            }, {}))
        ).toBe(false);
        expect(
            decodeMeasurementCondition(admit({
                event_name: 'pull_request',
                repository: 'owner/repo',
                event: { label: { name: 'measure-state-write' }, pull_request: { head: { repo: { full_name: 'fork/repo' } } } }
            }, {}))
        ).toBe(false);
        expect(workflow.steps.find((step) => step.uses.startsWith('actions/checkout@'))?.settings['persist-credentials']).toBe(false);
    });

    it('evaluates mode and label isolation and selects the comparison or diagnostic workflow steps', () => {
        const workflow = readWorkflow();
        const manual = { workflow: 'measurement', ref: 'refs/heads/topic', event_name: 'workflow_dispatch', event: { label: { name: '' }, pull_request: {} } };
        const defaults = evaluateMeasurementPolicy(workflow, manual, { ref: 'topic' });
        const comparison = evaluateMeasurementPolicy(workflow, manual, { ref: 'topic', mode: 'comparison' });
        const diagnostic = evaluateMeasurementPolicy(workflow, manual, { ref: 'topic', mode: 'diagnostic' });
        expect(defaults.mode).toBe('comparison');
        expect(comparison.mode).toBe('comparison');
        expect(diagnostic.mode).toBe('diagnostic');
        expect(defaults.concurrency).toBe(comparison.concurrency);
        expect(diagnostic.concurrency).not.toBe(comparison.concurrency);
        const supported = evaluateMeasurementPolicy(workflow, {
            workflow: 'measurement',
            ref: 'refs/pull/42/merge',
            event_name: 'pull_request',
            event: { label: { name: 'measure-state-write' }, pull_request: { number: 42 } }
        }, {});
        const unrelated = evaluateMeasurementPolicy(workflow, {
            workflow: 'measurement',
            ref: 'refs/pull/42/merge',
            event_name: 'pull_request',
            event: { label: { name: 'unrelated' }, pull_request: { number: 42 } }
        }, {});
        expect(supported.mode).toBe('comparison');
        expect(unrelated.concurrency).not.toBe(supported.concurrency);
        for (const policy of [defaults, comparison, supported]) {
            expect(policy.steps.some((step) => step.run.includes('resolve-changed-review-range.mjs'))).toBe(true);
            expect(policy.steps.some((step) => step.run.includes('write-api-v1-state-write-pooled-results.mjs'))).toBe(true);
        }
        expect(
            diagnostic.steps.some((step) =>
                step.run.includes('resolve-changed-review-range.mjs') || step.run.includes('write-api-v1-state-write-pooled-results.mjs')
            )
        ).toBe(false);
        expect(diagnostic.steps.filter((step) => step.run.includes(owner))).toHaveLength(1);
        expect(diagnostic.steps.some((step) => step.run.includes('npm ci') && step.run.includes('deno check'))).toBe(true);
    });

    it.for(['dependencies', 'comparator', 'scripts'])('refuses comparison %s changes before preparing either measurement source', async (failure, context) => {
        const fixture = createFixture(context, 'comparison', failure);
        const admission = readWorkflow().steps.find((step) => step.run.includes('resolve-changed-review-range.mjs'));
        expect(admission).toBeDefined();
        await expect(runShell(context, fixture, admission!.run)).rejects.toThrow();
        expect(readCalls(fixture).some((call) => call.command === 'npm' && call.args.includes('perf:api-v1:state-write'))).toBe(false);
    });
});

describe('selected hosted measurement lifecycle', { timeout: 20000 }, () => {
    it('runs exactly one bounded diagnostic with fresh sibling outputs and retains source, original-byte and validity evidence', async (context) => {
        const fixture = createFixture(context, 'diagnostic', '');
        await runShell(context, fixture, lifecycleShell());
        const calls = readCalls(fixture);
        expect(calls.filter((call) => call.command === 'npm' && call.args.includes('perf:api-v1:state-write')).map((call) => call.args)).toEqual([
            [
                'run',
                'perf:api-v1:state-write',
                '--',
                '--backend=postgres',
                '--warmup=1',
                '--runs=3',
                '--concurrency=10',
                '--out=tmp/perf/state-write-diagnostic/12345-2/artifacts/state-write.json',
                '--diagnostics-dir=tmp/perf/state-write-diagnostic/12345-2/diagnostics'
            ]
        ]);
        expect(
            calls.some((call) =>
                call.args.some((arg) =>
                    arg.includes('pooled-results') || arg.includes('compare-api-v1-state-write-results') || arg.includes('resolve-changed-review-range')
                )
            )
        ).toBe(false);
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({
            status: 'complete',
            primary: null,
            secondary: [],
            rawAcquisitionAdmitted: true
        });
        expect(readJson(path.join(fixture.output, 'source.json'))).toMatchObject({
            commit: candidate,
            tree: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            trackedClean: true
        });
        expect(readFileSync(path.join(fixture.root, 'github-output'), 'utf8')).toContain('raw-admitted=true');
        expect(readFileSync(path.join(fixture.output, 'artifacts/preflight.json.acquisition/image.tar'), 'utf8')).toBe('original archive bytes');
        expect(readJson(path.join(fixture.output, 'diagnostic-validity.json'))).toMatchObject({
            status: 'complete',
            phases: 12,
            totalCommands: 8400,
            measuredCommands: 6300
        });
    });

    it.for(['cpu', 'cpu-invalid', 'overlap', 'preflight', 'source-change'])('refuses %s before any benchmark', async (failure, context) => {
        const fixture = createFixture(context, 'diagnostic', failure);
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readCalls(fixture).filter((call) => call.command === 'npm' && call.args.includes('perf:api-v1:state-write'))).toEqual([]);
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ status: 'failed' });
    });

    it.for(['benchmark', 'secondary'])('preserves %s failure and attempts postflight, logs and owned cleanup', async (failure, context) => {
        const fixture = createFixture(context, 'diagnostic', failure);
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ primary: { stage: 'benchmark', exitCode: 19 } });
        const calls = readCalls(fixture);
        expect(
            calls.some((call) => call.args.includes('--stage') && call.args.includes('postflight') && call.args.some((arg) => arg.endsWith('environment.txt')))
        ).toBe(true);
        expect(calls.some((call) => call.command === 'docker' && call.args[0] === 'logs')).toBe(true);
        expect(calls.some((call) => call.command === 'docker' && call.args.includes('down') && call.args.includes('-v'))).toBe(true);
        const pid = Number(
            readFileSync(path.join(fixture.root, 'benchmark.pid'), 'utf8')
        );
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
    });

    it('settles an exited parent and its continuing descendant with inherited pipes before later native effects', async (context) => {
        const fixture = createFixture(context, 'diagnostic', 'inherited-pipe');
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'commands/benchmark-0-terminal.json'))).toMatchObject({ exitCode: 19, signal: null });
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ primary: { stage: 'benchmark', exitCode: 19, signal: null } });
        const parent = Number(readFileSync(path.join(fixture.root, 'benchmark.pid'), 'utf8'));
        const descendant = Number(readFileSync(path.join(fixture.root, 'descendant.pid'), 'utf8'));
        expect(parent).toBeGreaterThan(0);
        expect(descendant).toBeGreaterThan(0);
        expect(() => process.kill(parent, 0)).toThrow();
        expect(() => process.kill(descendant, 0)).toThrow();
        expect(existsSync(path.join(fixture.root, 'descendant-fallback'))).toBe(false);
        const terminalCalls = readCalls(fixture).filter((call) =>
            call.args.some((arg) => arg.endsWith('/environment.txt')) || call.args[0] === 'logs' || call.args.includes('down')
        );
        expect(terminalCalls).toHaveLength(3);
        expect(terminalCalls.map((call) => call.benchmarkAlive)).toEqual([false, false, false]);
        expect(terminalCalls.map((call) => call.descendantAlive)).toEqual([false, false, false]);
    });

    it.for(['recording', 'interrupt', 'metadata'])('settles the actual child on %s before capture, logs and cleanup', async (failure, context) => {
        const fixture = createFixture(context, 'diagnostic', failure);
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'commands/benchmark-0-terminal.json'))).toMatchObject({ signal: 'SIGKILL' });
        const pid = Number(
            readFileSync(failure === 'metadata' ? path.join(fixture.output, 'commands/benchmark-0.pid') : path.join(fixture.root, 'benchmark.pid'), 'utf8')
        );
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ status: 'failed' });
        const terminalCalls = readCalls(fixture).filter((call) =>
            call.args.some((arg) => arg.endsWith('/environment.txt')) || call.args[0] === 'logs' || call.args.includes('down')
        );
        expect(terminalCalls).toHaveLength(3);
        expect(terminalCalls.map((call) => call.benchmarkAlive)).toEqual([false, false, false]);
        if (failure !== 'metadata') {
            const descendant = Number(readFileSync(path.join(fixture.root, 'descendant.pid'), 'utf8'));
            expect(descendant).toBeGreaterThan(0);
            expect(() => process.kill(descendant, 0)).toThrow();
            expect(terminalCalls.map((call) => call.descendantAlive)).toEqual([false, false, false]);
        }
    });

    it.for(['unexpected-env', 'unexpected-mount', 'ownership', 'cleanup-env'])(
        'refuses original raw upload for %s without disclosing unexpected configuration',
        async (failure, context) => {
            const fixture = createFixture(context, 'diagnostic', failure);
            await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
            const terminal = readFileSync(path.join(fixture.output, 'terminal.json'), 'utf8');
            expect(decodeJsonRecord(JSON.parse(terminal))).toMatchObject({ rawAcquisitionAdmitted: false });
            expect(terminal).not.toContain('do-not-disclose');
            expect(readFileSync(path.join(fixture.root, 'github-output'), 'utf8')).toContain('raw-admitted=false');
            if (failure === 'ownership') {
                expect(readCalls(fixture).some((call) => call.command === 'docker' && call.args.includes('down'))).toBe(false);
            }
        }
    );

    it('refuses upload when a later comparison acquisition fails before its raw bytes are admitted', async (context) => {
        const fixture = createFixture(context, 'comparison', 'late-preflight');
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ rawAcquisitionAdmitted: false });
        expect(readFileSync(path.join(fixture.root, 'github-output'), 'utf8')).toContain('raw-admitted=false');
        expect(readCalls(fixture).filter((call) => call.command === 'npm' && call.args.includes('perf:api-v1:state-write'))).toHaveLength(1);
    });

    it('refuses deleting a substituted container even when its fixture labels and project inventory match', async (context) => {
        const fixture = createFixture(context, 'diagnostic', 'replacement');
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ primary: { stage: 'cleanup-refused-or-failed' } });
        expect(readCalls(fixture).some((call) => call.command === 'docker' && call.args.includes('down'))).toBe(false);
    });

    it.for(['incomplete', 'capacity', 'canonical'])('keeps %s evidence failed even with a complete-looking receipt', async (failure, context) => {
        const fixture = createFixture(context, 'diagnostic', failure);
        await expect(runShell(context, fixture, lifecycleShell())).rejects.toThrow();
        expect(readJson(path.join(fixture.output, 'terminal.json'))).toMatchObject({ primary: { stage: 'diagnostic-validity' } });
    });

    it('preserves comparison A-B-B-A nine-run captures through the same terminal and cleanup protocol', async (context) => {
        const fixture = createFixture(context, 'comparison', '');
        await runShell(context, fixture, lifecycleShell());
        const calls = readCalls(fixture);
        expect(calls.filter((call) => call.command === 'npm' && call.args.includes('perf:api-v1:state-write')).map((call) => call.args)).toEqual([
            [
                'run',
                'perf:api-v1:state-write',
                '--',
                '--backend=postgres',
                '--warmup=1',
                '--runs=9',
                '--concurrency=10',
                '--out=tmp/perf/state-write-comparison/position-1.json'
            ],
            [
                'run',
                'perf:api-v1:state-write',
                '--',
                '--backend=postgres',
                '--warmup=1',
                '--runs=9',
                '--concurrency=10',
                '--out=tmp/perf/state-write-comparison/position-2.json'
            ],
            [
                'run',
                'perf:api-v1:state-write',
                '--',
                '--backend=postgres',
                '--warmup=1',
                '--runs=9',
                '--concurrency=10',
                '--out=tmp/perf/state-write-comparison/position-3.json'
            ],
            [
                'run',
                'perf:api-v1:state-write',
                '--',
                '--backend=postgres',
                '--warmup=1',
                '--runs=9',
                '--concurrency=10',
                '--out=tmp/perf/state-write-comparison/position-4.json'
            ]
        ]);
        expect(calls.filter((call) => call.command === 'git' && call.args[0] === 'checkout').map((call) => call.args)).toEqual([
            ['checkout', '--detach', 'cccccccccccccccccccccccccccccccccccccccc'],
            ['checkout', '--detach', candidate],
            ['checkout', '--detach', candidate],
            ['checkout', '--detach', 'cccccccccccccccccccccccccccccccccccccccc']
        ]);
        expect(calls.filter((call) => call.command === 'docker' && call.args.includes('down'))).toHaveLength(4);
        const verdict = readWorkflow().steps.find((step) => step.run.includes('write-api-v1-state-write-pooled-results.mjs'));
        expect(verdict).toBeDefined();
        await runShell(context, fixture, verdict!.run);
        expect(
            readCalls(fixture).filter((call) => call.args.includes('apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs')).map((call) => call.args)
        ).toEqual([[
            '--max-old-space-size=12288',
            'apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs',
            path.join(fixture.output, 'approved-base.json'),
            path.join(fixture.output, 'candidate.json')
        ]]);
    });
});

function evaluateMeasurementPolicy(workflow: MeasurementWorkflow, github: JsonRecord, inputs: Readonly<Record<string, string>>): MeasurementPolicy {
    const modeExpression = workflow.environment.MEASUREMENT_MODE.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const mode = decodeMeasurementPolicyMode(new Function('github', 'inputs', `return (${modeExpression});`)(github, inputs));
    const group = workflow.concurrency.group;
    if (typeof group !== 'string') {
        throw new Error('Invalid measurement policy result');
    }
    const concurrency = group.replace(
        /\$\{\{\s*(.*?)\s*\}\}/g,
        (_match, expression: string) => decodeMeasurementConcurrencyPart(new Function('github', 'inputs', `return (${expression});`)(github, inputs))
    );
    const steps = workflow.steps.filter((step) =>
        step.run !== '' &&
        (step.condition === '' ||
            decodeMeasurementCondition(new Function('github', 'inputs', 'env', `return (${step.condition});`)(github, inputs, { MEASUREMENT_MODE: mode })))
    );
    return { mode, concurrency, steps };
}

function decodeMeasurementPolicyMode(value: unknown): MeasurementPolicy['mode'] {
    if (typeof value !== 'string' || value !== 'comparison' && value !== 'diagnostic') {
        throw new Error('Invalid measurement mode at the workflow policy boundary');
    }
    return value;
}

function decodeMeasurementConcurrencyPart(value: unknown): string {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Invalid concurrency identity at the workflow policy boundary');
    }
    return String(value);
}

function decodeMeasurementCondition(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new Error('Invalid condition at the workflow policy boundary');
    }
    return value;
}

function createFixture(context: TestContext, mode: string, failure: string): MeasurementFixture {
    const root = mkdtempSync(path.join(tmpdir(), 'state-write-hosted-'));
    context.onTestFinished(() => {
        for (const name of ['benchmark.pid', 'descendant.pid']) {
            try {
                process.kill(Number(readFileSync(path.join(root, name), 'utf8')), 'SIGKILL');
            }
            catch {}
        }
        rmSync(root, { recursive: true, force: true });
    });
    createCommandPorts(root);
    for (const name of ['apps', '.github']) {
        symlinkSync(path.join(repoRoot, name), path.join(root, name));
    }
    for (const name of ['package.json', 'package-lock.json', 'docker-compose.perf-bench.yml']) {
        copyFileSync(path.join(repoRoot, name), path.join(root, name));
    }
    const artifact = createDefaultStateWritePerformanceArtifact();
    artifact.gitCommit = candidate;
    writeFileSync(path.join(root, 'artifact.json'), JSON.stringify(artifact));
    const output = mode === 'diagnostic' ? 'tmp/perf/state-write-diagnostic/12345-2' : 'tmp/perf/state-write-comparison';
    mkdirSync(path.join(root, output), { recursive: true });
    return {
        root,
        output: path.join(root, output),
        environment: {
            ...process.env,
            PATH: path.join(root, 'bin') + ':' + process.env.PATH,
            REAL_NODE: process.execPath,
            PORT_ROOT: root,
            PORT_FAILURE: failure,
            GITHUB_WORKSPACE: root,
            GITHUB_RUN_ID: '12345',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_ENV: path.join(root, 'github-env'),
            GITHUB_OUTPUT: path.join(root, 'github-output'),
            RUNNER_ENVIRONMENT: 'github-hosted',
            MEASUREMENT_MODE: mode,
            MEASUREMENT_OUTPUT: output,
            COMPOSE_PROJECT_NAME: 'state-write-comparison',
            DATABASE_URL: 'postgres://app:app@localhost:5433/appdb',
            CANDIDATE_COMMIT: candidate,
            BASE_MEASUREMENT_COMMIT: 'cccccccccccccccccccccccccccccccccccccccc',
            COMPARATOR_FILES: readWorkflow().environment.COMPARATOR_FILES,
            FROZEN_ENVIRONMENT_FILES: readWorkflow().environment.FROZEN_ENVIRONMENT_FILES
        }
    };
}

function createCommandPorts(root: string): void {
    mkdirSync(path.join(root, 'bin'));
    copyFileSync(path.join(repoRoot, 'packages/tests/repo/state-write-measurement-command-port.mjs'), path.join(root, 'port.mjs'));
    for (const name of ['node', 'npm', 'docker', 'git', 'deno', 'nproc', 'ps', 'lscpu', 'free']) {
        writeFileSync(
            path.join(root, 'bin', name),
            '#!/bin/bash\n' + (name === 'node' ? 'case "$1" in *run-api-v1-state-write-measurement.mjs) exec "$REAL_NODE" "$@";; esac\n' : '') +
                'exec "$REAL_NODE" "$PORT_ROOT/port.mjs" ' + name + ' "$@"\n'
        );
        chmodSync(path.join(root, 'bin', name), 0o755);
    }
}

function runShell(context: TestContext, fixture: MeasurementFixture, shell: string) {
    return runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-e', '-o', 'pipefail', '-c', shell],
        options: { cwd: fixture.root, env: fixture.environment, timeout: 20000 }
    });
}
function readCalls(fixture: MeasurementFixture): readonly CommandCall[] {
    return readFileSync(path.join(fixture.root, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => {
        const value = decodeJsonRecord(JSON.parse(line));
        if (typeof value.command !== 'string' || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) {
            throw new Error('Invalid command-port outcome');
        }
        if (
            value.benchmarkAlive !== null && typeof value.benchmarkAlive !== 'boolean' ||
            value.descendantAlive !== null && typeof value.descendantAlive !== 'boolean'
        ) {
            throw new Error('Invalid command-port child fact');
        }
        return { command: value.command, args: value.args, benchmarkAlive: value.benchmarkAlive, descendantAlive: value.descendantAlive };
    });
}
function readJson(file: string): JsonRecord {
    return decodeJsonRecord(JSON.parse(readFileSync(file, 'utf8')));
}
function lifecycleShell(): string {
    const step = readWorkflow().steps.find((step) => step.run.includes(owner));
    if (!step) {
        throw new Error('Measurement lifecycle is missing');
    }
    return step.run;
}
function readWorkflow(): MeasurementWorkflow {
    const document = decodeJsonRecord(load(readFileSync(path.join(repoRoot, workflowPath), 'utf8')));
    const jobs = decodeJsonRecord(document.jobs);
    const job = decodeJsonRecord(jobs.compare);
    const triggers = decodeJsonRecord(document.on);
    const inputs = decodeJsonRecord(decodeJsonRecord(triggers.workflow_dispatch).inputs);
    if (typeof job.if !== 'string' || !Array.isArray(job.steps)) {
        throw new Error('Invalid workflow job');
    }
    const environment = decodeJsonRecord(job.env);
    if (!Object.values(environment).every((value) => typeof value === 'string')) {
        throw new Error('Invalid workflow environment');
    }
    return {
        admission: job.if,
        concurrency: decodeWorkflowScalars(document.concurrency),
        inputs: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, decodeWorkflowScalars(input, true)])),
        environment: environment as Readonly<Record<string, string>>,
        steps: job.steps.map(decodeWorkflowStep)
    };
}
function decodeWorkflowStep(value: unknown): WorkflowStep {
    const step = decodeJsonRecord(value);
    for (const field of ['name', 'run', 'uses', 'if']) {
        if (step[field] !== undefined && typeof step[field] !== 'string') {
            throw new Error('Invalid workflow step text');
        }
    }
    return {
        name: typeof step.name === 'string' ? step.name : '',
        run: typeof step.run === 'string' ? step.run : '',
        uses: typeof step.uses === 'string' ? step.uses : '',
        condition: typeof step.if === 'string' ? step.if : '',
        settings: step.with === undefined ? {} : decodeWorkflowScalars(step.with)
    };
}
function decodeWorkflowScalars(value: unknown, allowArrays = false): Record<string, string | number | boolean | readonly string[]> {
    const record = decodeJsonRecord(value);
    if (
        !Object.values(record).every((entry) =>
            ['string', 'number', 'boolean'].includes(typeof entry) || allowArrays && Array.isArray(entry) && entry.every((item) => typeof item === 'string')
        )
    ) {
        throw new Error('Invalid workflow scalar settings');
    }
    return record as Record<string, string | number | boolean | readonly string[]>;
}
function decodeJsonRecord(value: unknown): JsonRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected an object at the YAML/JSON boundary');
    }
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, decodeJsonValue(entry)]));
}

function decodeJsonValue(value: unknown): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(decodeJsonValue);
    }
    return decodeJsonRecord(value);
}
