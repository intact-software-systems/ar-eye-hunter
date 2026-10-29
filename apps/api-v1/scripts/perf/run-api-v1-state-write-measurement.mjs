#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    appendFile,
    lstat,
    mkdir,
    readdir,
    readFile,
    writeFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { validateStateWriteArtifact } from './compare-api-v1-state-write-results.mjs';

/** @typedef {{ stage: string, exitCode: number | null, signal: string | null }} MeasurementFailure */
/** @typedef {{ path: string, bytes: number, sha256: string }} MeasurementFile */
/** @typedef {{ commit: string, tree: string, trackedClean: boolean, inputs: MeasurementFile[] }} MeasurementSource */
/** @typedef {{ mode: 'comparison' | 'diagnostic' | 'cpu-profile', output: string, relativeOutput: string, databaseUrl: string, base: string, candidate: string, githubOutput: string, workflow: { commit: string, ref: string } | null }} MeasurementConfiguration */

const CAPTURE = 'apps/api-v1/scripts/perf/capture-api-v1-state-write-environment.mjs';
const COMPOSE = 'docker-compose.perf-bench.yml';
const PROJECT = 'state-write-comparison';
const CONTAINER = 'rallar-perf-bench-postgres';
const IMAGE = 'postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171';
const WORKLOADS = ['uncontended', 'shared', 'hot'];
const CPU_PROFILE_EVIDENCE = { mode: 'cpu-profile', purpose: 'whole-process-cpu-diagnostic', acceptance: false };
const TERMINAL_STAGES = ['postflight', 'database-logs', 'cleanup-identity', 'cleanup-inventory', 'cleanup'];

class StateWriteMeasurement {
    /** @param {MeasurementConfiguration} configuration */
    constructor(configuration) {
        this.configuration = configuration;
        this.commands = join(configuration.output, 'commands');
        /** @type {MeasurementFailure | null} */
        this.primary = null;
        /** @type {MeasurementFailure[]} */
        this.secondary = [];
        this.sequence = 0;
        this.position = 0;
        this.activeChild = null;
        this.activeGroupStopRequested = false;
        this.interrupted = false;
        this.rawAcquisitionAdmitted = false;
        this.acquisitionRefused = false;
        this.onInterrupt = () => {
            this.interrupted = true;
            this.recordFailure({ stage: 'interrupted', exitCode: null, signal: 'SIGTERM' });
            this.stopChild();
        };
    }

    async start() {
        await mkdir(this.configuration.output, { recursive: true });
        await mkdir(this.commands);
        process.on('SIGTERM', this.onInterrupt);
        process.on('SIGINT', this.onInterrupt);
        try {
            await this.admitRunner();
            if (this.configuration.mode === 'diagnostic') {
                const source = await this.readSource();
                await writeFile(join(this.configuration.output, 'source.json'), JSON.stringify(source) + '\n', {
                    flag: 'wx'
                });
                await this.capturePosition({ commit: source.commit, source });
            }
            else {
                if (this.configuration.mode === 'cpu-profile') {
                    await this.recordCpuAcquisitionSource();
                }
                for (
                    const commit of [
                        this.configuration.base,
                        this.configuration.candidate,
                        this.configuration.candidate,
                        this.configuration.base
                    ]
                ) {
                    if (this.primary !== null) {
                        break;
                    }
                    this.position += 1;
                    await this.capturePosition({ commit, source: null });
                }
            }
        }
        catch {
            this.recordFailure({ stage: 'admission-or-recording', exitCode: null, signal: null });
        }
        finally {
            process.off('SIGTERM', this.onInterrupt);
            process.off('SIGINT', this.onInterrupt);
            await this.writeTerminal();
        }
        process.exitCode = this.primary === null ? 0 : 1;
    }

    async admitRunner() {
        const cpus = Number(await this.readCommand('cpu', 'nproc', []));
        if (
            process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !Number.isSafeInteger(cpus) || cpus < 4
        ) {
            throw new Error('runner-admission');
        }
        await this.requireIdle();
        for (
            const [command, args] of [
                ['node', ['--version']],
                ['npm', ['--version']],
                ['deno', ['--version']],
                ['docker', ['version']],
                ['docker', ['compose', 'version']],
                ['lscpu', []],
                ['free', ['-b']]
            ]
        ) {
            await this.readCommand('runner-facts', command, args);
        }
    }

    async requireIdle() {
        const containers = await this.readCommand('container-admission', 'docker', ['ps', '-aq']);
        const processes = await this.readCommand('process-admission', 'ps', ['-A', '-o', 'command=']);
        if (
            containers.trim() !== '' ||
            processes.split('\n').some((line) =>
                line.includes('api-v1-state-write-concurrency-bench') && !line.includes('ps -A')
            )
        ) {
            throw new Error('overlap-admission');
        }
    }

    /** @returns {Promise<MeasurementSource>} */
    async readSource() {
        const commit = (await this.readCommand('source-commit', 'git', ['rev-parse', '--verify', 'HEAD'])).trim();
        const tree = (await this.readCommand('source-tree', 'git', ['rev-parse', 'HEAD^{tree}'])).trim();
        const tracked = await this.readCommand('source-clean', 'git', [
            'status',
            '--porcelain',
            '--untracked-files=no'
        ]);
        if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree) || tracked.trim() !== '') {
            throw new Error('source-binding');
        }
        const names = (await this.readCommand('source-inputs', 'git', [
            'ls-files',
            '--',
            '.github/workflows/api-v1-state-write-pr-measurement.yml',
            COMPOSE,
            'package.json',
            'package-lock.json',
            'apps/api-v1/deno.json',
            'apps/api-v1/deno.lock',
            'apps/api-v1/scripts/perf'
        ])).trim().split('\n');
        const inputs = [];
        for (const name of names) {
            if (name.startsWith('/') || name.split('/').includes('..') || name.length === 0) {
                throw new Error('source-input');
            }
            inputs.push(await readFileInventory(name));
        }
        return { commit, tree, trackedClean: true, inputs };
    }

    /** @param {{ commit: string, source: MeasurementSource | null }} position */
    async capturePosition(position) {
        const diagnostic = this.configuration.mode === 'diagnostic';
        const prefix = diagnostic ? join(this.configuration.output, 'artifacts') : this.configuration.output;
        await mkdir(prefix, { recursive: true });
        const preflight = join(prefix, diagnostic ? 'preflight.json' : `position-${this.position}-preflight.json`);
        const environment = join(prefix, diagnostic ? 'environment.txt' : `position-${this.position}-environment.txt`);
        let provisioned = false;
        this.rawAcquisitionAdmitted = false;
        try {
            if (!diagnostic) {
                await this.readCommand('checkout', 'git', ['checkout', '--detach', position.commit]);
            }
            await this.requireTrackedClean();
            const source = this.configuration.mode === 'cpu-profile'
                ? await this.prepareCpuProfile(position.commit)
                : position.source;
            await this.requireIdle();
            provisioned = true;
            await this.provisionDatabase(preflight);
            await this.admitOriginalAcquisition(preflight);
            if (
                source !== null && JSON.stringify(source) !== JSON.stringify(await this.readSource())
            ) {
                throw new Error('executable-inputs-changed');
            }
            await this.runBenchmark();
            if (this.configuration.mode === 'cpu-profile') {
                await this.writeCpuProfileValidity(source);
            }
        }
        catch {
            this.recordFailure({ stage: 'native-lifecycle', exitCode: null, signal: null });
        }
        finally {
            if (await fileExists(preflight)) {
                await this.attemptCommand(
                    'postflight',
                    'node',
                    this.captureArguments('postflight', preflight, environment)
                );
            }
            if (provisioned) {
                await this.attemptCommand('database-logs', 'docker', ['logs', CONTAINER]);
                await this.cleanupOwnedProject(preflight);
            }
        }
        if (this.primary === null && diagnostic) {
            await this.writeDiagnosticValidity(position.commit);
        }
    }

    async requireTrackedClean() {
        const tracked = await this.readCommand('tracked-clean', 'git', [
            'status',
            '--porcelain',
            '--untracked-files=no'
        ]);
        if (tracked.trim() !== '') {
            throw new Error('tracked-state');
        }
    }

    async recordCpuAcquisitionSource() {
        const source = await this.readSource();
        if (source.commit !== this.configuration.candidate) {
            throw new Error('cpu-acquisition-source');
        }
        const workflow = this.configuration.workflow;
        if (workflow === null) {
            throw new Error('cpu-workflow-source');
        }
        const workflowText = await this.readCommand('workflow-source', 'git', [
            'show',
            `${workflow.commit}:.github/workflows/api-v1-state-write-pr-measurement.yml`
        ]);
        const workflowPath = join(this.configuration.output, 'executing-workflow.yml');
        await writeFile(workflowPath, workflowText, { flag: 'wx' });
        await writeFile(
            join(this.configuration.output, 'acquisition-source.json'),
            JSON.stringify({
                ...CPU_PROFILE_EVIDENCE,
                scope: 'candidate-checkout-and-runner',
                source,
                workflow: { ...workflow, file: await readFileInventory(workflowPath) }
            }) + '\n',
            { flag: 'wx' }
        );
    }

    async prepareCpuProfile(commit) {
        const directory = join(this.configuration.output, `position-${this.position}-profile`);
        await mkdir(directory);
        const source = await this.readSource();
        if (source.commit !== commit) {
            throw new Error('cpu-profile-source');
        }
        await writeFile(
            join(directory, 'source.json'),
            JSON.stringify({ ...CPU_PROFILE_EVIDENCE, scope: 'measured-checkout', source }) + '\n',
            { flag: 'wx' }
        );
        return source;
    }

    async writeCpuProfileValidity(source) {
        try {
            if (source === null || JSON.stringify(source) !== JSON.stringify(await this.readSource())) {
                throw new Error('cpu-profile-source-changed');
            }
            const directory = join(this.configuration.output, `position-${this.position}-profile`);
            const profilePath = join(directory, `position-${this.position}.cpuprofile`);
            const profile = toObject(JSON.parse(await readFile(profilePath, 'utf8')));
            if (validateNativeCpuProfile(profile).length !== 0) {
                throw new Error('cpu-profile-invalid');
            }
            const validity = {
                ...CPU_PROFILE_EVIDENCE,
                status: 'complete',
                nodes: profile.nodes.length,
                samples: profile.samples.length,
                startTime: profile.startTime,
                endTime: profile.endTime,
                profile: await readFileInventory(profilePath),
                acquisitionSource: await readFileInventory(join(this.configuration.output, 'acquisition-source.json')),
                source: await readFileInventory(join(directory, 'source.json')),
                commandStart: await readFileInventory(join(this.commands, `benchmark-${this.position}-start.json`)),
                commandTerminal: await readFileInventory(
                    join(this.commands, `benchmark-${this.position}-terminal.json`)
                )
            };
            await writeFile(join(directory, 'validity.json'), JSON.stringify(validity) + '\n', { flag: 'wx' });
        }
        catch {
            this.recordFailure({ stage: 'cpu-profile-validity', exitCode: null, signal: null });
        }
    }

    async provisionDatabase(preflight) {
        await this.readCommand('provision', 'docker', ['compose', '-p', PROJECT, '-f', COMPOSE, 'up', '-d', '--wait']);
        await this.readCommand('migration', 'npm', ['run', 'db:migrate']);
        await this.readCommand('preflight', 'node', this.captureArguments('preflight', preflight, preflight));
        await this.readCommand(
            'preflight-validation',
            'node',
            this.captureArguments('postflight', preflight, `${preflight}.validation.txt`)
        );
    }

    captureArguments(stage, preflight, out) {
        const args = [
            CAPTURE,
            '--stage',
            stage,
            '--container',
            CONTAINER,
            '--database-url',
            this.configuration.databaseUrl,
            '--out',
            out
        ];
        if (stage === 'postflight') {
            args.push('--preflight', preflight);
        }
        return args;
    }

    async runBenchmark() {
        const diagnostic = this.configuration.mode === 'diagnostic';
        const out = diagnostic
            ? `${this.configuration.relativeOutput}/artifacts/state-write.json`
            : `${this.configuration.relativeOutput}/position-${this.position}.json`;
        const args = [
            '--backend=postgres',
            '--warmup=1',
            diagnostic ? '--runs=3' : '--runs=9',
            '--concurrency=10',
            `--out=${out}`
        ];
        if (diagnostic) {
            args.push(`--diagnostics-dir=${this.configuration.relativeOutput}/diagnostics`);
        }
        if (this.configuration.mode === 'cpu-profile') {
            await this.readCommand('benchmark', 'deno', [
                'run',
                '--cpu-prof',
                `--cpu-prof-dir=${join(this.configuration.output, `position-${this.position}-profile`)}`,
                `--cpu-prof-name=position-${this.position}.cpuprofile`,
                '-A',
                '--config',
                'apps/api-v1/deno.json',
                'apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts',
                ...args
            ]);
        }
        else {
            await this.readCommand('benchmark', 'npm', ['run', 'perf:api-v1:state-write', '--', ...args]);
        }
    }

    async cleanupOwnedProject(preflight) {
        try {
            const acquiredId = await fileExists(preflight)
                ? toText(toObject(JSON.parse(await readFile(preflight, 'utf8'))).containerId)
                : null;
            const inspection = toObject(
                JSON.parse(
                    await this.readCommand('cleanup-identity', 'docker', [
                        'inspect',
                        '--format',
                        '{{json .}}',
                        CONTAINER
                    ])
                )
            );
            await this.admitCleanupInspection(inspection, preflight);
            const config = toObject(inspection.Config);
            const labels = toObject(config.Labels);
            const containers = (await this.readCommand('cleanup-inventory', 'docker', ['ps', '-aq', '--no-trunc']))
                .trim().split('\n').filter(Boolean);
            if (
                acquiredId !== null && inspection.Id !== acquiredId ||
                inspection.Name !== `/${CONTAINER}` || config.Image !== IMAGE ||
                labels['com.docker.compose.project'] !== PROJECT ||
                labels['com.docker.compose.service'] !== 'perf-bench-postgres' ||
                labels['com.docker.compose.project.working_dir'] !== process.cwd() ||
                labels['com.docker.compose.project.config_files'] !== join(process.cwd(), COMPOSE) ||
                containers.length !== 1 || containers[0] !== inspection.Id
            ) {
                throw new Error('cleanup-ownership');
            }
            await this.readCommand('cleanup', 'docker', ['compose', '-p', PROJECT, '-f', COMPOSE, 'down', '-v']);
        }
        catch {
            this.recordFailure({ stage: 'cleanup-refused-or-failed', exitCode: null, signal: null });
        }
    }

    async admitCleanupInspection(container, preflight) {
        const imagePath = join(`${preflight}.acquisition`, 'image-inspect.json');
        if (await fileExists(imagePath)) {
            try {
                const image = toObject(JSON.parse(await readFile(imagePath, 'utf8')));
                const fixture = toPublicFixtureAcquisition({ container, image, workspace: process.cwd() });
                if (validatePublicFixture(fixture).length !== 0) {
                    throw new Error('public-fixture-refused');
                }
            }
            catch {
                this.acquisitionRefused = true;
                this.rawAcquisitionAdmitted = false;
                this.recordFailure({ stage: 'raw-acquisition-refused', exitCode: null, signal: null });
                throw new Error('raw-acquisition-refused');
            }
        }
    }

    async attemptCommand(stage, command, args) {
        try {
            await this.readCommand(stage, command, args);
        }
        catch {
            this.recordFailure({ stage, exitCode: null, signal: null });
        }
    }

    /** @param {MeasurementFailure} failure */
    recordFailure(failure) {
        if (this.primary === null) {
            this.primary = failure;
        }
        else {
            this.secondary.push(failure);
        }
    }

    stopChild() {
        if (this.activeChild !== null && this.activeChild.pid !== undefined && !this.activeGroupStopRequested) {
            try {
                process.kill(-this.activeChild.pid, 'SIGKILL');
                this.activeGroupStopRequested = true;
            }
            catch (error) {
                if (error.code !== 'ESRCH') {
                    this.recordFailure({ stage: 'child-stop', exitCode: null, signal: null });
                }
                else {
                    this.activeGroupStopRequested = true;
                }
            }
        }
    }

    async readCommand(stage, command, args) {
        if (this.interrupted && !TERMINAL_STAGES.includes(stage)) {
            throw new Error('interrupted');
        }
        const name = `${stage}-${stage === 'benchmark' ? this.position : this.sequence++}`;
        const stdoutPath = join(this.commands, `${name}.stdout`);
        const stderrPath = join(this.commands, `${name}.stderr`);
        const startedAt = new Date().toISOString();
        const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.activeChild = child;
        this.activeGroupStopRequested = false;
        child.once('exit', () => this.stopChild());
        const closed = new Promise((fulfill) =>
            child.once('close', (exitCode, signal) => fulfill({ exitCode, signal }))
        );
        let recording = Promise.resolve();
        let recordingFailed = false;
        const writeBytes = (path, bytes) => {
            recording = recording.then(() => appendFile(path, bytes)).catch(() => {
                recordingFailed = true;
                this.recordFailure({ stage: 'command-recording', exitCode: null, signal: null });
                this.stopChild();
            });
        };
        child.stdout.on('data', (bytes) => writeBytes(stdoutPath, bytes));
        child.stderr.on('data', (bytes) => writeBytes(stderrPath, bytes));
        child.on('error', () => this.recordFailure({ stage, exitCode: null, signal: null }));
        try {
            if (await this.writeCommandMetadata({ name, child, command, args, startedAt })) {
                recordingFailed = true;
            }
            const outcome = await closed;
            await recording;
            await this.recordCommandOutcome({ name, stage, outcome, recordingFailed });
            return stage === 'benchmark'
                ? ''
                : await readFile(stdoutPath, 'utf8').catch((error) =>
                    error.code === 'ENOENT' ? '' : Promise.reject(error)
                );
        }
        finally {
            this.stopChild();
            await closed;
            await recording;
            this.activeChild = null;
        }
    }

    async recordCommandOutcome({ name, stage, outcome, recordingFailed }) {
        await writeFile(
            join(this.commands, `${name}-terminal.json`),
            JSON.stringify({ ...outcome, endedAt: new Date().toISOString() }) + '\n',
            { flag: 'wx' }
        );
        if (outcome.exitCode !== 0 || outcome.signal !== null || recordingFailed) {
            this.recordFailure({ stage, ...outcome });
            throw new Error('command-failed');
        }
    }

    async writeCommandMetadata({ name, child, command, args, startedAt }) {
        try {
            await writeFile(join(this.commands, `${name}.pid`), String(child.pid) + '\n', { flag: 'wx' });
            await writeFile(
                join(this.commands, `${name}-start.json`),
                JSON.stringify({ command, args, cwd: process.cwd(), startedAt, pid: child.pid }) + '\n',
                { flag: 'wx' }
            );
            return false;
        }
        catch {
            this.recordFailure({ stage: 'command-metadata', exitCode: null, signal: null });
            this.stopChild();
            return true;
        }
    }

    async admitOriginalAcquisition(preflight) {
        try {
            const directory = `${preflight}.acquisition`;
            const container = toObject(JSON.parse(await readFile(join(directory, 'container-inspect.json'), 'utf8')));
            const image = toObject(JSON.parse(await readFile(join(directory, 'image-inspect.json'), 'utf8')));
            const fixture = toPublicFixtureAcquisition({ container, image, workspace: process.cwd() });
            const issues = validatePublicFixture(fixture);
            if (issues.length !== 0) {
                throw new Error('public-fixture-refused');
            }
            this.rawAcquisitionAdmitted = !this.acquisitionRefused;
        }
        catch {
            this.acquisitionRefused = true;
            this.rawAcquisitionAdmitted = false;
            this.recordFailure({ stage: 'raw-acquisition-refused', exitCode: null, signal: null });
            throw new Error('raw-acquisition-refused');
        }
    }

    async writeDiagnosticValidity(commit) {
        try {
            const artifact = toObject(
                JSON.parse(await readFile(join(this.configuration.output, 'artifacts/state-write.json'), 'utf8'))
            );
            if (
                validateStateWriteArtifact(artifact).length !== 0 || artifact.gitCommit !== commit ||
                toObject(artifact.measurement).measuredRuns !== 3
            ) {
                throw new Error('canonical-invalid');
            }
            const facts = await readDiagnosticValidity(join(this.configuration.output, 'diagnostics'));
            await writeFile(join(this.configuration.output, 'diagnostic-validity.json'), JSON.stringify(facts) + '\n', {
                flag: 'wx'
            });
        }
        catch {
            this.recordFailure({ stage: 'diagnostic-validity', exitCode: null, signal: null });
        }
    }

    async writeTerminal() {
        try {
            await writeFile(
                join(this.configuration.output, 'inventory.json'),
                JSON.stringify(
                    this.configuration.mode === 'cpu-profile'
                        ? { ...CPU_PROFILE_EVIDENCE, files: await readOutputInventory(this.configuration.output) }
                        : await readOutputInventory(this.configuration.output)
                ) + '\n',
                { flag: 'wx' }
            );
        }
        catch {
            this.recordFailure({ stage: 'inventory', exitCode: null, signal: null });
        }
        await writeFile(
            join(this.configuration.output, 'terminal.json'),
            JSON.stringify({
                ...(this.configuration.mode === 'cpu-profile' ? CPU_PROFILE_EVIDENCE : {}),
                status: this.primary === null ? 'complete' : 'failed',
                primary: this.primary,
                secondary: this.secondary,
                rawAcquisitionAdmitted: this.rawAcquisitionAdmitted
            }) + '\n',
            { flag: 'wx' }
        );
        if (this.configuration.githubOutput !== '') {
            await appendFile(this.configuration.githubOutput, `raw-admitted=${this.rawAcquisitionAdmitted}\n`);
        }
    }
}

function validateNativeCpuProfile(profile) {
    const issues = [];
    if (!Array.isArray(profile.samples) || profile.samples.length === 0) {
        issues.push('cpu-profile-samples');
    }
    if (
        !Array.isArray(profile.timeDeltas) || profile.timeDeltas.length !== profile.samples?.length ||
        profile.timeDeltas.some((delta) => !Number.isSafeInteger(delta))
    ) {
        issues.push('cpu-profile-deltas');
    }
    if (
        !Number.isSafeInteger(profile.startTime) || !Number.isSafeInteger(profile.endTime) ||
        profile.startTime < 0 || profile.endTime <= profile.startTime
    ) {
        issues.push('cpu-profile-clock');
    }
    if (!Array.isArray(profile.nodes) || profile.nodes.length === 0) {
        return [...issues, 'cpu-profile-nodes'];
    }
    const nodes = new Map();
    for (const node of profile.nodes) {
        const nodeIssues = validateNativeCpuNode(node);
        issues.push(...nodeIssues);
        if (nodeIssues.length !== 0) {
            continue;
        }
        if (nodes.has(node.id)) {
            issues.push('cpu-profile-duplicate-node');
        }
        nodes.set(node.id, node.children ?? []);
    }
    issues.push(...validateCpuProfileTree(nodes));
    if (
        Array.isArray(profile.samples) &&
        profile.samples.some((sample) => !Number.isSafeInteger(sample) || !nodes.has(sample))
    ) {
        issues.push('cpu-profile-sample-reference');
    }
    return issues;
}

function validateNativeCpuNode(node) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return ['cpu-profile-node'];
    }
    const issues = [];
    if (!Number.isSafeInteger(node.id) || node.id <= 0) {
        issues.push('cpu-profile-node-id');
    }
    if (
        node.children !== undefined &&
        (!Array.isArray(node.children) || node.children.some((id) => !Number.isSafeInteger(id)))
    ) {
        issues.push('cpu-profile-node-children');
    }
    const frame = node.callFrame;
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        return [...issues, 'cpu-profile-frame'];
    }
    if (
        typeof frame.functionName !== 'string' || typeof frame.scriptId !== 'string' || typeof frame.url !== 'string' ||
        !Number.isSafeInteger(frame.lineNumber) || frame.lineNumber < -1 ||
        !Number.isSafeInteger(frame.columnNumber) || frame.columnNumber < -1
    ) {
        issues.push('cpu-profile-frame-fields');
    }
    return issues;
}

function validateCpuProfileTree(nodes) {
    const issues = [];
    const parents = new Set();
    for (const children of nodes.values()) {
        for (const child of children) {
            if (!nodes.has(child) || parents.has(child)) {
                issues.push('cpu-profile-child-reference');
            }
            parents.add(child);
        }
    }
    const roots = [...nodes.keys()].filter((id) => !parents.has(id));
    if (roots.length !== 1) {
        issues.push('cpu-profile-root');
    }
    if (issues.length !== 0) {
        return issues;
    }
    const pending = [...roots];
    const visited = new Set();
    while (pending.length !== 0) {
        const id = pending.pop();
        if (visited.has(id)) {
            return ['cpu-profile-cycle'];
        }
        visited.add(id);
        for (const child of nodes.get(id)) {
            pending.push(child);
        }
    }
    return visited.size === nodes.size ? [] : ['cpu-profile-unreachable-node'];
}

function readConfiguration() {
    const mode = process.env.MEASUREMENT_MODE;
    const run = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT;
    const relativeOutput = mode === 'comparison'
        ? 'tmp/perf/state-write-comparison'
        : `tmp/perf/state-write-${mode}/${run}-${attempt}`;
    if (
        (mode !== 'comparison' && mode !== 'diagnostic' && mode !== 'cpu-profile') || !/^\d+$/.test(run ?? '') ||
        !/^\d+$/.test(attempt ?? '') ||
        process.env.MEASUREMENT_OUTPUT !== relativeOutput ||
        process.env.DATABASE_URL !== 'postgres://app:app@localhost:5433/appdb'
    ) {
        throw new Error('measurement-configuration-refused');
    }
    const base = process.env.BASE_MEASUREMENT_COMMIT ?? '';
    const candidate = process.env.CANDIDATE_COMMIT ?? '';
    if (
        mode !== 'diagnostic' &&
        (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(candidate) || base === candidate)
    ) {
        throw new Error('comparison-source-refused');
    }
    return {
        mode,
        relativeOutput,
        output: resolve(relativeOutput),
        databaseUrl: process.env.DATABASE_URL,
        base,
        candidate,
        githubOutput: process.env.GITHUB_OUTPUT ?? '',
        workflow: mode === 'cpu-profile' ? readWorkflowIdentity() : null
    };
}

function readWorkflowIdentity() {
    const commit = process.env.GITHUB_WORKFLOW_SHA;
    const ref = process.env.GITHUB_WORKFLOW_REF;
    if (
        !/^[a-f0-9]{40}$/.test(commit ?? '') ||
        typeof ref !== 'string' ||
        !/^[^/]+\/[^/]+\/\.github\/workflows\/api-v1-state-write-pr-measurement\.yml@.+$/.test(ref)
    ) {
        throw new Error('cpu-workflow-identity-refused');
    }
    return { commit, ref };
}

/** @typedef {{ type: string, name: string, source: string, destination: string, driver: string, mode: string, writable: boolean, propagation: string }} PublicFixtureMount */
/** @typedef {{ environment: string[], defaultEnvironment: string[], image: string, imageId: string, nativeImageId: string, imageDigests: string[], command: string[], entrypoint: string[], defaultEntrypoint: string[], labels: Record<string, string>, defaultLabels: Record<string, string>, imageVolumes: string[], mounts: PublicFixtureMount[], customMounts: boolean, workspace: string }} PublicFixtureAcquisition */

/** @returns {PublicFixtureAcquisition} */
function toPublicFixtureAcquisition({ container, image, workspace }) {
    const config = toObject(container.Config);
    const defaults = toObject(image.Config);
    const host = toObject(container.HostConfig);
    if (!Array.isArray(container.Mounts)) {
        throw new Error('invalid-native-mounts');
    }
    return {
        environment: toStrings(config.Env),
        defaultEnvironment: toStrings(defaults.Env),
        image: toText(config.Image),
        imageId: toText(container.Image),
        nativeImageId: toText(image.Id),
        imageDigests: toStrings(image.RepoDigests),
        command: toStrings(config.Cmd),
        entrypoint: toStrings(config.Entrypoint),
        defaultEntrypoint: toStrings(defaults.Entrypoint),
        labels: toLabels(config.Labels),
        defaultLabels: defaults.Labels == null ? {} : toLabels(defaults.Labels),
        imageVolumes: Object.keys(toObject(defaults.Volumes)),
        mounts: container.Mounts.map(toPublicFixtureMount),
        customMounts: [host.Binds, host.Mounts, host.VolumesFrom].some((value) =>
            value != null && (!Array.isArray(value) || value.length !== 0)
        ),
        workspace
    };
}

/** @param {unknown} value @returns {PublicFixtureMount} */
function toPublicFixtureMount(value) {
    const mount = toObject(value);
    if (typeof mount.RW !== 'boolean') {
        throw new Error('invalid-native-mount');
    }
    return {
        type: toText(mount.Type),
        name: toText(mount.Name),
        source: toText(mount.Source),
        destination: toText(mount.Destination),
        driver: toText(mount.Driver),
        mode: toText(mount.Mode),
        writable: mount.RW,
        propagation: toText(mount.Propagation)
    };
}

/** @param {PublicFixtureAcquisition} fixture */
function validatePublicFixture(fixture) {
    const overrides = ['POSTGRES_USER=app', 'POSTGRES_PASSWORD=app', 'POSTGRES_DB=appdb'];
    const expected = [
        ...fixture.defaultEnvironment.filter((entry) =>
            !overrides.some((override) => entry.split('=')[0] === override.split('=')[0])
        ),
        ...overrides
    ];
    const issues = [];
    if (
        JSON.stringify([...fixture.environment].sort()) !== JSON.stringify(expected.sort()) ||
        new Set(fixture.environment.map((entry) => entry.split('=')[0])).size !== fixture.environment.length
    ) {
        issues.push('environment');
    }
    if (
        fixture.image !== IMAGE || fixture.nativeImageId !== fixture.imageId || !fixture.imageDigests.includes(IMAGE) ||
        fixture.command.join(' ') !== 'postgres -c autovacuum=off' ||
        JSON.stringify(fixture.entrypoint) !== JSON.stringify(fixture.defaultEntrypoint)
    ) {
        issues.push('image-command');
    }
    if (fixture.customMounts) {
        issues.push('custom-mount');
    }
    const mount = fixture.mounts[0];
    if (
        fixture.imageVolumes.length !== 1 || fixture.imageVolumes[0] !== '/var/lib/postgresql/data' ||
        fixture.mounts.length !== 1 || !mount || mount.type !== 'volume' || !/^[a-f0-9]{64}$/.test(mount.name) ||
        mount.destination !== fixture.imageVolumes[0] ||
        mount.source !== `/var/lib/docker/volumes/${mount.name}/_data` || mount.driver !== 'local' || !mount.writable ||
        mount.mode !== '' || mount.propagation !== ''
    ) {
        issues.push('anonymous-volume');
    }
    return [...issues, ...validatePublicComposeLabels(fixture)];
}

/** @param {PublicFixtureAcquisition} fixture */
function validatePublicComposeLabels(fixture) {
    const fixed = {
        'com.docker.compose.project': PROJECT,
        'com.docker.compose.service': 'perf-bench-postgres',
        'com.docker.compose.container-number': '1',
        'com.docker.compose.oneoff': 'False',
        'com.docker.compose.project.working_dir': fixture.workspace,
        'com.docker.compose.project.config_files': join(fixture.workspace, COMPOSE),
        'com.docker.compose.depends_on': ''
    };
    const generated = ['com.docker.compose.config-hash', 'com.docker.compose.image', 'com.docker.compose.version'];
    const issues = [];
    if (
        Object.entries(fixed).some(([name, value]) => fixture.labels[name] !== value) ||
        Object.entries(fixture.labels).some(([name, value]) =>
            !(name in fixed) && !generated.includes(name) && fixture.defaultLabels[name] !== value
        )
    ) {
        issues.push('compose-context');
    }
    if (
        !/^[a-f0-9]{64}$/.test(fixture.labels['com.docker.compose.config-hash'] ?? '') ||
        fixture.labels['com.docker.compose.image'] !== fixture.imageId ||
        !/^\d+\.\d+\.\d+$/.test(fixture.labels['com.docker.compose.version'] ?? '')
    ) {
        issues.push('compose-labels');
    }
    return issues;
}

/** @param {unknown} value @returns {Record<string, string>} */
function toLabels(value) {
    const labels = toObject(value);
    if (!Object.values(labels).every((entry) => typeof entry === 'string')) {
        throw new Error('invalid-native-labels');
    }
    return /** @type {Record<string, string>} */ (labels);
}

/** @param {unknown} value @returns {string} */
function toText(value) {
    if (typeof value !== 'string') {
        throw new Error('invalid-native-text');
    }
    return value;
}

async function readDiagnosticValidity(directory) {
    const receipt = toObject(JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')));
    if (
        receipt.kind !== 'complete' || receipt.stage !== 'none' || receipt.phases !== 12 ||
        receipt.receiptReserveBytes !== 1024 ||
        receipt.byteAccounting !== 'phase-bytes-reserved-including-failed-writes'
    ) {
        throw new Error('diagnostic-receipt');
    }
    const names = await readdir(directory);
    if (
        names.length !== 13 ||
        names.some((name) => name !== 'receipt.json' && !/^phase-(?:[0-9]|1[01])\.ndjson$/.test(name))
    ) {
        throw new Error('diagnostic-files');
    }
    let bytes = 0;
    let totalCommands = 0;
    let measuredCommands = 0;
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
        const phase = await readDiagnosticPhase(join(directory, `phase-${ordinal}.ndjson`), ordinal);
        bytes += phase.bytes;
        totalCommands += phase.commands;
        if (phase.measured) {
            measuredCommands += phase.commands;
        }
    }
    if (receipt.bytes !== bytes || bytes + 1024 > 536870912 || totalCommands !== 8400 || measuredCommands !== 6300) {
        throw new Error('diagnostic-accounting');
    }
    return { status: 'complete', phases: 12, totalCommands, measuredCommands, bytes };
}

/** @typedef {{ bytes: number, commands: number, measured: boolean }} DiagnosticPhaseInventory */
/** @returns {Promise<DiagnosticPhaseInventory>} */
async function readDiagnosticPhase(path, ordinal) {
    const text = await readFile(path, 'utf8');
    const records = text.trimEnd().split('\n').map((line) => toObject(JSON.parse(line)));
    const phase = records[0];
    const footer = records.at(-1);
    const commands = records.filter((record) => record.record === 'command');
    if (
        Buffer.byteLength(text) > 33554432 || phase.record !== 'phase' ||
        phase.schema !== 'rallar.state-write.diagnostic.v3' ||
        phase.workload !== WORKLOADS[Math.floor(ordinal / 4)] ||
        phase.phase !== (ordinal % 4 === 0 ? 'warmup' : 'measured') ||
        phase.runIndex !== (ordinal % 4 === 0 ? 0 : ordinal % 4 - 1) || phase.outcome !== 'completed' ||
        commands.length !== 700 || commands.some((command, index) => command.commandOrdinal !== index) ||
        footer.record !== 'completeness' || footer.complete !== true
    ) {
        throw new Error('diagnostic-phase');
    }
    requireDiagnosticCapacity(footer);
    const timing = toObject(footer.timing);
    const releases = toObject(footer.releases);
    if (
        timing.retained + releases.retained > 110000 ||
        timing.unassociated !==
            records.filter((record) =>
                record.record === 'timing' && toObject(record.association).kind === 'process-unassociated'
            ).length ||
        releases.unassociated !== 0 || toObject(footer.boundaries).unassociated !== 0 ||
        records.length !== timing.retained + releases.retained + toObject(footer.boundaries).retained + 1 ||
        timing.retained !== records.filter((record) => record.record === 'timing').length ||
        releases.retained !== records.filter((record) => record.record === 'release').length ||
        toObject(footer.boundaries).retained !==
            records.filter((record) => ['phase', 'command', 'kind'].includes(record.record)).length
    ) {
        throw new Error('diagnostic-record-accounting');
    }
    requireValidReservationObservations(records, footer);
    return { bytes: Buffer.byteLength(text), commands: commands.length, measured: phase.phase === 'measured' };
}

function requireDiagnosticCapacity(footer) {
    for (const name of ['timing', 'releases', 'boundaries']) {
        const counts = toObject(footer[name]);
        if (
            counts.rejected !== 0 || counts.truncated !== 0 || !Number.isSafeInteger(counts.retained) ||
            counts.retained < 0 || counts.total !== counts.retained ||
            !Number.isSafeInteger(counts.unassociated) || counts.unassociated < 0 ||
            counts.unassociated > counts.retained ||
            name !== 'boundaries' && counts.retained > 110000
        ) {
            throw new Error('diagnostic-capacity');
        }
    }
}

async function readOutputInventory(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await readOutputInventory(path));
        }
        else if (entry.isFile()) {
            files.push(await readFileInventory(path));
        }
        else {
            throw new Error('non-regular-output');
        }
    }
    return files;
}

/** @returns {Promise<MeasurementFile>} */
async function readFileInventory(path) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    return { path, bytes, sha256: hash.digest('hex') };
}

async function fileExists(path) {
    try {
        return (await lstat(path)).isFile();
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function toObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid-record');
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {string[]} */
function toStrings(value) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error('invalid-strings');
    }
    return value;
}

function requireValidReservationObservations(records, footer) {
    const releases = records.filter((record) => record.record === 'release');
    let expected = 0;
    let available = 0;
    for (const release of releases) {
        const observation = toObject(release.reservationObservation);
        const reservationAttempt = release.attempt + (release.classification === 'not-ready' ? 1 : 0);
        if (
            !Number.isSafeInteger(reservationAttempt) || reservationAttempt < 1 ||
            observation.reservationAttempt !== reservationAttempt
        ) {
            throw new Error('diagnostic-reservation-identity');
        }
        if (release.selectedLane === 'RETRY') {
            expected += 1;
            if (
                observation.availability !== 'available' || observation.boundary !== 'postgres-update-returning' ||
                observation.association !== 'physical-key-and-reservation-attempt' ||
                !Number.isSafeInteger(observation.previousPersistedRetryDelayUs) ||
                !Number.isSafeInteger(observation.dueToReservationObservationUs) ||
                Object.keys(observation).some((key) =>
                    ![
                        'availability',
                        'boundary',
                        'association',
                        'reservationAttempt',
                        'previousPersistedRetryDelayUs',
                        'dueToReservationObservationUs'
                    ].includes(key)
                )
            ) {
                throw new Error('diagnostic-reservation-observation');
            }
            available += 1;
        }
        else if (
            !['NEW', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'].includes(release.selectedLane) ||
            observation.availability !== 'unavailable' || observation.boundary !== 'unavailable' ||
            observation.association !== 'unavailable' ||
            observation.reason !== (release.selectedLane === 'NEW' ? 'not-applicable' : 'lane-not-captured') ||
            Object.keys(observation).some((key) =>
                !['availability', 'boundary', 'association', 'reservationAttempt', 'reason'].includes(key)
            )
        ) {
            throw new Error('diagnostic-reservation-lane');
        }
    }
    const counts = toObject(footer.reservationObservations);
    if (counts.expected !== expected || counts.available !== available || counts.unavailable !== 0) {
        throw new Error('diagnostic-reservation-completeness');
    }
}

await new StateWriteMeasurement(readConfiguration()).start();
