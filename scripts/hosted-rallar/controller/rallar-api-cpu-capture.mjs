import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const controllerDirectory = path.dirname(fileURLToPath(import.meta.url));
const diagnosticKeys = [
    'RALLAR_TIMING_LOGS',
    'RALLAR_APP_INBOX_PHASE_TIMING',
    'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT',
    'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE',
    'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE',
    'RALLAR_RTC_TOPOLOGY_MESH_PARAM_K'
];
const cleanupFiles = [
    'rallar-api-cpu-capture.mjs',
    'rallar-api-cpu-capture.sh',
    'rallar-api-inspector.mjs',
    'rallar-controller-lock.sh',
    '08-rollout-controller.sh',
    '07-status-controller.sh',
    '17-export-run-journals.sh',
    '15-logs.sh',
    'rallar-api-prod-profile.sh',
    'rallar-apt-sources.sh',
    'rallar-api-effective-env.sh',
    'rallar-deno-runtime.sh',
    'rallar-public-spa-env.sh',
    'rallar-playwright-install.sh',
    'rallar-deployment-readiness.sh'
];
const resourceProperties = [
    'MainPID',
    'ExecMainStartTimestampMonotonic',
    'ActiveState',
    'CPUUsageNSec',
    'MemoryCurrent',
    'MemoryPeak',
    'IOReadBytes',
    'IOWriteBytes'
];

export function toApiCaptureConfiguration(environment) {
    const operation = environment.RALLAR_DISTRIBUTED_RUN_ID;
    const source = environment.RALLAR_REPO_REF;
    const manifest = environment.RALLAR_SOURCE_MANIFEST_SHA256;
    const workflow = environment.RALLAR_CAPTURE_WORKFLOW_RUN_ID;
    const attempt = environment.RALLAR_CAPTURE_WORKFLOW_RUN_ATTEMPT;
    if (
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(operation ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '') ||
        !/^[a-f0-9]{64}$/.test(manifest ?? '') || !/^\d+$/.test(workflow ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')
    ) {
        throw new Error('Capture requires exact operation, source, manifest and workflow identities');
    }
    if (
        !['1', 'true'].includes(environment.RALLAR_API_SERVER_TIMING) ||
        !['1', 'true'].includes(environment.RALLAR_PRESERVE_PUBLIC_SETTINGS) ||
        (environment.RALLAR_HETZNER_OPERATOR_PHASE !== 'run' &&
            !['1', 'true'].includes(environment.RALLAR_ROLLOUT_BEFORE_RUN))
    ) {
        throw new Error('Capture requires timing and preserving rollout');
    }
    const ready = readPositiveSeconds(environment.RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS);
    const terminal = readPositiveSeconds(environment.RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS);
    const identity = { operation, source, manifest, workflow, attempt };
    const id = `api-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
    return {
        id,
        identity,
        environment,
        root: environment.RALLAR_API_CAPTURE_ROOT ?? '/var/lib/rallar-api-capture',
        override: environment.RALLAR_API_CAPTURE_OVERRIDE ??
            '/run/systemd/system/rallar-api-v1.service.d/90-rallar-cpu-capture.conf',
        checkout: environment.RALLAR_CHECKOUT_DIR ?? '/opt/rallar/ar-eye-hunter',
        controllerDirectory,
        operationRoot: environment.RALLAR_OPERATION_ARTIFACT_ROOT ?? '/tmp/rallar-distributed-operations',
        remainingSeconds: 75 * 60 + ready * 2 + terminal + 120 + 300,
        deadlineBudgets: {
            preparationSeconds: 360 * 60,
            agentJobSeconds: 75 * 60,
            readinessSeconds: ready * 2,
            terminalSeconds: terminal,
            teardownSeconds: 120,
            cleanupMarginSeconds: 300
        }
    };
}

export class ApiCpuCapture {
    constructor(configuration, commands) {
        this.configuration = configuration;
        this.commands = commands;
        this.directory = path.join(configuration.root, configuration.id);
        this.evidence = path.join(this.directory, 'evidence');
        this.tooling = path.join(this.directory, 'tooling');
        this.stateFile = path.join(this.directory, 'state.json');
    }

    begin() {
        if (lstatSync(this.configuration.override, { throwIfNoEntry: false })) {
            throw new Error('Pre-existing capture override is not owned');
        }
        if (existsSync(path.join(this.configuration.root, 'active'))) {
            throw new Error('Another capture owns the controller');
        }
        mkdirSync(this.directory, { recursive: false, mode: 0o755 });
        mkdirSync(this.evidence);
        this.state = {
            identity: this.configuration.identity,
            id: this.configuration.id,
            status: 'preflight',
            mutationStarted: false,
            recipeExitCode: null,
            profileStatus: 'not-started',
            exportStatus: 'pending',
            restoreStatus: 'not-required',
            deadlineExpired: false,
            startedEpochMs: Date.now(),
            deadlineBudgets: this.configuration.deadlineBudgets,
            errors: []
        };
        writeFileSync(path.join(this.configuration.root, 'active'), this.configuration.id, { flag: 'wx' });
        this.writeState();
        try {
            this.preflight();
            this.armDeadline(360 * 60 + this.configuration.remainingSeconds);
            this.state.mutationStarted = true;
            this.state.restoreStatus = 'required';
            this.writeState();
            this.rollout(this.configuration.identity.source, null);
            this.armDeadline(this.configuration.remainingSeconds);
            this.startProfile();
            this.state.status = 'capturing';
            this.writeState();
            this.exportEvidence();
        }
        catch (error) {
            this.state.errors.push(error.message);
            this.finish('prepare-failed', 1);
            throw error;
        }
    }

    preflight() {
        this.state.original = JSON.parse(
            this.run('bash', [
                path.join(this.configuration.controllerDirectory, '07-status-controller.sh'),
                '--inspect'
            ])
        );
        const original = this.state.original;
        writeJson(path.join(this.evidence, 'preflight.json'), original);
        if (
            original.dirty || original.failureFence || original.activity.rolloutProcessPresent ||
            original.activity.recipeProcessPresent ||
            original.services.api !== 'active' || original.services.control !== 'active'
        ) {
            throw new Error('Controller is not idle and healthy for capture');
        }
        for (const key of diagnosticKeys) {
            if (original.configuration[key].source === 'secret') {
                throw new Error('Capture cannot modify diagnostic secret-file overrides');
            }
        }
        mkdirSync(this.tooling);
        for (const file of cleanupFiles) {
            copyFileSync(path.join(this.configuration.controllerDirectory, file), path.join(this.tooling, file));
        }
        this.state.api = this.readApiProcess();
        this.state.serviceUser = this.run('systemctl', ['show', '--property=User', '--value', 'rallar-api-v1.service'])
            .trim();
        if (this.state.serviceUser !== 'rallar') {
            throw new Error('Unsupported API service user');
        }
        this.state.launchArguments = this.readLaunchArguments();
        this.probeInspector();
        this.state.resourcesOriginal = this.readResources();
        this.writeState();
    }

    probeInspector() {
        this.run('chown', ['-R', 'rallar:rallar', this.evidence]);
        this.run('runuser', [
            '-u',
            'rallar',
            '--',
            this.state.launchArguments[0],
            'run',
            '--no-config',
            '--allow-all',
            path.join(this.tooling, 'rallar-api-inspector.mjs'),
            'probe',
            path.join(this.evidence, 'preflight-probe')
        ]);
        this.run('runuser', [
            '-u',
            'rallar',
            '--',
            this.state.launchArguments[0],
            'eval',
            '--no-config',
            'const socket=Deno.listen({hostname:"127.0.0.1",port:9229});socket.close();'
        ]);
    }

    readLaunchArguments() {
        const args = this.run('cat', [`/proc/${this.state.api.pid}/cmdline`]).split('\0').filter(Boolean);
        const executable = this.run('readlink', ['-f', `/proc/${this.state.api.pid}/exe`]).trim();
        const service = this.run('systemctl', ['show', '--property=ExecStart', '--value', 'rallar-api-v1.service']);
        if (
            args[1] !== 'run' || this.run('readlink', ['-f', args[0]]).trim() !== executable ||
            args.some((arg) => /[\s$%\\"']/.test(arg)) ||
            args.some((arg) => arg.startsWith('--inspect') || arg.startsWith('--v8-flags')) ||
            !service.includes(`argv[]=${args.join(' ')} ;`)
        ) {
            throw new Error('Cannot preserve the actual API ExecStart exactly');
        }
        return args;
    }

    armDeadline(seconds) {
        const unit = `rallar-${this.configuration.id}-deadline`;
        if (this.state.deadlineEpochMs) {
            this.run('systemctl', ['stop', `${unit}.timer`]);
        }
        this.state.deadlineEpochMs = Date.now() + seconds * 1000;
        this.writeState();
        this.run('systemd-run', [
            '--quiet',
            '--collect',
            `--unit=${unit}`,
            `--on-active=${seconds}s`,
            '--timer-property=AccuracySec=1s',
            '--property=Type=oneshot',
            '/bin/bash',
            path.join(this.tooling, 'rallar-api-cpu-capture.sh'),
            'deadline',
            this.directory
        ]);
    }

    startProfile() {
        const args = [...this.state.launchArguments];
        args.splice(2, 0, '--inspect=127.0.0.1:9229', '--v8-flags=--trace-gc-nvp');
        this.state.overrideContents = `# Owned by ${this.configuration.id}\n[Service]\nExecStart=\nExecStart=${
            args.join(' ')
        }\n`;
        mkdirSync(path.dirname(this.configuration.override), { recursive: true });
        writeFileSync(this.configuration.override, this.state.overrideContents, { flag: 'wx', mode: 0o644 });
        this.writeState();
        this.run('systemctl', ['daemon-reload']);
        this.run('systemctl', ['stop', 'rallar-api-v1.service']);
        const launch = { epochMs: Date.now(), monotonicMs: performance.now() };
        this.state.launch = launch;
        this.run('systemctl', ['start', 'rallar-api-v1.service']);
        this.state.api = this.readApiProcess();
        this.state.segment = path.join(this.evidence, `pid-${this.state.api.pid}-${this.state.api.start}`);
        mkdirSync(this.state.segment);
        writeJson(path.join(this.state.segment, 'target.json'), {
            pid: this.state.api.pid,
            endpoint: 'http://127.0.0.1:9229',
            launch,
            deadlineEpochMs: this.state.deadlineEpochMs,
            identity: this.configuration.identity,
            process: this.state.api
        });
        this.run('chown', ['-R', 'rallar:rallar', this.state.segment]);
        this.run('systemd-run', [
            '--quiet',
            `--unit=rallar-${this.configuration.id}-inspector`,
            '--property=User=rallar',
            `--property=RuntimeMaxSec=${this.configuration.remainingSeconds}s`,
            '--property=KillMode=control-group',
            this.state.launchArguments[0],
            'run',
            '--no-config',
            '--allow-all',
            path.join(this.tooling, 'rallar-api-inspector.mjs'),
            'capture',
            this.state.segment
        ]);
        this.waitForFile(path.join(this.state.segment, 'started.json'), 15000);
        this.verifyProcess();
        this.run('curl', ['--fail', '--silent', '--max-time', '10', 'http://127.0.0.1:8080/api/config']);
        this.state.profileStatus = 'recording';
        this.state.resourcesBefore = this.readResources();
    }

    check() {
        this.readState();
        if (this.state.status !== 'capturing' || Date.now() >= this.state.deadlineEpochMs) {
            throw new Error('Capture is not live or its deadline expired');
        }
        this.verifyProcess();
        const profileResult = path.join(this.state.segment, 'profile-result.json');
        if (existsSync(profileResult)) {
            throw new Error('Inspector session ended before the run');
        }
        if (
            this.run('systemctl', ['is-active', `rallar-${this.configuration.id}-inspector.service`]).trim() !==
                'active'
        ) {
            throw new Error('Inspector session is not active');
        }
    }

    finish(reason, recipeExitCode) {
        if (!this.state) {
            this.readState();
        }
        if (this.state.restoreStatus === 'restored') {
            this.exportEvidence();
            rmSync(path.join(this.configuration.root, 'active'), { force: true });
            return this.success();
        }
        if (this.state.recipeExitCode === null) {
            this.state.recipeExitCode = recipeExitCode;
        }
        this.state.deadlineExpired ||= reason === 'deadline' || Date.now() >= this.state.deadlineEpochMs;
        this.state.finishReason = reason;
        if (this.state.segment && !this.state.profileFinalized) {
            try {
                this.exportJournals();
            }
            catch (error) {
                this.state.exportStatus = 'failed';
                this.state.errors.push(error.message);
            }
            this.stopProfile();
        }
        if (this.state.mutationStarted) {
            try {
                this.restore();
            }
            catch (error) {
                this.state.restoreStatus = 'failed';
                this.state.errors.push(`Restore failed: ${error.message}`);
            }
        }
        else {
            this.state.restoreStatus = 'not-required';
        }
        this.state.status = this.success() ? 'complete' : 'failed';
        this.writeState();
        this.exportEvidence();
        if (['restored', 'not-required'].includes(this.state.restoreStatus)) {
            rmSync(path.join(this.configuration.root, 'active'), { force: true });
        }
        return this.success();
    }

    stopProfile() {
        let valid = true;
        try {
            this.verifyProcess();
            this.state.resourcesAfter = this.readResources();
        }
        catch (error) {
            valid = false;
            this.state.errors.push(error.message);
        }
        // This segment signals the existing connection only; never attach to a replacement process.
        try {
            writeFileSync(path.join(this.state.segment, 'stop'), '');
            this.waitForFile(path.join(this.state.segment, 'profile-result.json'), 15000);
            const result = readJson(path.join(this.state.segment, 'profile-result.json'));
            if (result.status !== 'valid' || result.pid !== this.state.api.pid) {
                throw new Error('Inspector profile validation failed');
            }
            this.verifyProcess();
        }
        catch (error) {
            valid = false;
            this.state.errors.push(error.message);
        }
        this.state.profileStatus = valid ? 'valid' : 'failed';
        this.state.profileFinalized = true;
        try {
            this.run('systemctl', ['stop', `rallar-${this.configuration.id}-inspector.service`]);
        }
        catch (error) {
            this.state.profileStatus = 'failed';
            this.state.errors.push(error.message);
        }
    }

    restore() {
        if (lstatSync(this.configuration.override, { throwIfNoEntry: false })) {
            if (readFileSync(this.configuration.override, 'utf8') !== this.state.overrideContents) {
                throw new Error('Override ownership changed; manual restoration required');
            }
            rmSync(this.configuration.override);
        }
        this.run('systemctl', ['daemon-reload']);
        const current = this.run('git', ['-C', this.configuration.checkout, 'rev-parse', 'HEAD']).trim();
        if (![this.configuration.identity.source, this.state.original.deployedCommit].includes(current)) {
            throw new Error('Deployed source changed; manual restoration required');
        }
        const configurationFile = path.join(this.directory, 'restore-configuration.json');
        writeJson(configurationFile, this.state.original.configuration);
        this.rollout(this.state.original.deployedCommit, configurationFile);
        const restored = JSON.parse(
            this.run('bash', [path.join(this.tooling, '07-status-controller.sh'), '--inspect'])
        );
        writeJson(path.join(this.evidence, 'restored.json'), restored);
        if (
            restored.deployedCommit !== this.state.original.deployedCommit ||
            restored.operatorSettingsSha256 !== this.state.original.operatorSettingsSha256 ||
            JSON.stringify(restored.configuration) !== JSON.stringify(this.state.original.configuration) ||
            restored.failureFence ||
            restored.services.api !== 'active' || restored.services.control !== 'active' ||
            Object.values(restored.health).some((code) => !/^2/.test(code)) || existsSync(this.configuration.override)
        ) {
            throw new Error('Restoration verification failed');
        }
        this.run('systemctl', ['stop', `rallar-${this.configuration.id}-deadline.timer`]);
        this.state.restoreStatus = 'restored';
    }

    rollout(source, configurationFile) {
        const environment = {
            ...this.configuration.environment,
            RALLAR_REPO_REF: source,
            RALLAR_API_CAPTURE_OWNER: this.configuration.id,
            RALLAR_PRESERVE_PUBLIC_SETTINGS: '1',
            RALLAR_INSTALL_PLAYWRIGHT: '0'
        };
        if (configurationFile) {
            environment.RALLAR_API_RESTORE_CONFIGURATION = configurationFile;
        }
        this.commands.run('bash', [path.join(this.tooling, '08-rollout-controller.sh')], environment);
    }

    verifyProcess() {
        const current = this.readApiProcess();
        writeJson(path.join(this.evidence, 'latest-process.json'), current);
        if (current.pid !== this.state.api.pid || current.start !== this.state.api.start) {
            throw new Error('API PID/start changed; refusing single-process attribution');
        }
        const source = this.run('git', ['-C', this.configuration.checkout, 'rev-parse', 'HEAD']).trim();
        if (source !== this.configuration.identity.source) {
            throw new Error('Capture source changed');
        }
    }

    readApiProcess() {
        const values = this.run('systemctl', [
            'show',
            '--property=MainPID,ExecMainStartTimestampMonotonic',
            'rallar-api-v1.service'
        ]);
        const properties = toProperties(values);
        const pid = Number(properties.MainPID);
        const start = properties.ExecMainStartTimestampMonotonic;
        if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[1-9]\d*$/.test(start ?? '')) {
            throw new Error('API process identity unavailable');
        }
        return { pid, start };
    }

    readResources() {
        const services = {};
        for (const unit of ['rallar-api-v1.service', 'rallar-black-box-control.service']) {
            const properties = toProperties(
                this.run('systemctl', ['show', `--property=${resourceProperties.join(',')}`, unit])
            );
            services[unit] = Object.fromEntries(resourceProperties.map((key) => [key, properties[key] || null]));
            services[unit].process = this.run('ps', [
                '-p',
                properties.MainPID,
                '-o',
                'pid=,ppid=,pcpu=,pmem=,rss=,comm='
            ]);
        }
        return {
            epochMs: Date.now(),
            services,
            memory: this.run('free', ['-h']),
            meaning: 'Whole-capture snapshots; no stall-window resource attribution'
        };
    }

    exportJournals() {
        const since = `@${Math.floor(this.state.launch.epochMs / 1000)}`;
        this.runJournalExport([
            path.join(this.tooling, '17-export-run-journals.sh'),
            '--since',
            since,
            '--output-dir',
            this.evidence
        ], 180);
        const journal = this.readCaptureJournal(since);
        writeFileSync(path.join(this.evidence, 'api-capture-journal.log'), journal);
        const lines = journal.split('\n');
        writeFileSync(
            path.join(this.evidence, 'api-gc-journal.log'),
            lines.filter((line) => line.includes(`[${this.state.api.pid}:`) && /pause=/.test(line)).join('\n')
        );
        writeJson(path.join(this.evidence, 'journal-coverage.json'), {
            lineCap: 1000000,
            byteCap: 128 * 1024 * 1024,
            timeoutSeconds: 30,
            sourceJournalBounds: { lineCapPerService: 50000, byteCapPerFile: 64 * 1024 * 1024, timeoutSeconds: 180 },
            suppressionScope: 'Selected API unit only; journald-wide loss remains unverified',
            since,
            untilEpochMs: Date.now(),
            pid: this.state.api.pid,
            lines: lines.length,
            truncationPossible: lines.length >= 1000000,
            suppressionReported: /suppressed \d+ messages/i.test(journal),
            gcEvents: 'Unverified: empty or incomplete output does not prove no GC',
            gcClock:
                'Process-launch to first-evaluation interval; trace prefix is observation time, not exact pause end'
        });
        if (lines.length >= 1000000 || /suppressed \d+ messages/i.test(journal)) {
            throw new Error('Journal coverage incomplete');
        }
    }

    readCaptureJournal(since) {
        try {
            return this.runJournalExport([
                path.join(this.tooling, '15-logs.sh'),
                '--raw',
                '--no-color',
                '--services',
                'api',
                '--since',
                since,
                '--lines',
                '1000000'
            ], 30);
        }
        catch (error) {
            writeFileSync(path.join(this.evidence, 'api-capture-journal.log'), error.stdout ?? '');
            writeJson(path.join(this.evidence, 'journal-coverage.json'), {
                status: 'incomplete',
                byteCap: 128 * 1024 * 1024,
                timeoutSeconds: 30,
                since,
                error: error.message,
                partialStdoutRetained: Boolean(error.stdout)
            });
            throw error;
        }
    }

    runJournalExport(args, seconds) {
        // GNU timeout owns the export process group; the shell file limit also bounds redirected journals.
        return this.run('timeout', [
            '--kill-after=5s',
            `${seconds}s`,
            'bash',
            '-c',
            'ulimit -f 65536; exec bash "$@"',
            'rallar-capture-export',
            ...args
        ]);
    }

    exportEvidence() {
        try {
            const output = path.join(
                this.configuration.operationRoot,
                this.configuration.identity.operation,
                'api-cpu-capture',
                this.configuration.id
            );
            mkdirSync(output, { recursive: true });
            copyEvidence(this.evidence, output);
            this.state.exportStatus = this.state.exportStatus === 'failed' ? 'failed' : 'copied-to-operation-directory';
            this.writeState();
            copyFileSync(this.stateFile, path.join(output, 'capture.json'));
            writeJson(path.join(output, 'sha256.json'), hashEvidence(output));
        }
        catch (error) {
            this.state.exportStatus = 'failed';
            this.state.errors.push(`Artifact export failed: ${error.message}`);
            this.writeState();
            throw error;
        }
    }

    readState() {
        this.state = readJson(this.stateFile);
        if (
            this.state.id !== this.configuration.id ||
            JSON.stringify(this.state.identity) !== JSON.stringify(this.configuration.identity)
        ) {
            throw new Error('Capture identity mismatch');
        }
        const active = path.join(this.configuration.root, 'active');
        if (existsSync(active) && readFileSync(active, 'utf8') !== this.configuration.id) {
            throw new Error('Capture lock belongs to another operation');
        }
    }

    writeState() {
        writeJson(this.stateFile, this.state);
        writeJson(path.join(this.directory, 'configuration.json'), { ...this.configuration, environment: undefined });
    }

    waitForFile(file, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (!existsSync(file)) {
            if (Date.now() >= deadline) {
                throw new Error('Inspector acknowledgement timed out');
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }

    success() {
        return this.state.recipeExitCode === 0 && this.state.profileStatus === 'valid' &&
            this.state.restoreStatus === 'restored' && !this.state.deadlineExpired &&
            this.state.exportStatus !== 'failed';
    }
    run(program, args) {
        return this.commands.run(program, args, this.configuration.environment);
    }
}

function readPositiveSeconds(value) {
    if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('Capture requires finite readiness and terminal bounds');
    }
    return Number(value);
}
function toProperties(text) {
    return Object.fromEntries(
        text.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
}
function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
}
function copyEvidence(source, destination) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const target = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            mkdirSync(target, { recursive: true });
            copyEvidence(path.join(source, entry.name), target);
        }
        else if (entry.isFile()) {
            copyFileSync(path.join(source, entry.name), target);
        }
        else {
            throw new Error('Unexpected evidence symlink');
        }
    }
}
function hashEvidence(directory) {
    const hashes = {};
    for (const file of readdirSync(directory, { recursive: true })) {
        const full = path.join(directory, file);
        if (statSync(full).isFile() && file !== 'sha256.json') {
            hashes[file] = createHash('sha256').update(readFileSync(full)).digest('hex');
        }
    }
    return hashes;
}

function runControllerCommand(program, args, environment) {
    const inheritedLock = process.env.RALLAR_CONTROLLER_LOCK_HELD === '1';
    const stdio = inheritedLock
        ? ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9]
        : ['ignore', 'pipe', 'pipe'];
    const result = spawnSync(program, args, {
        env: { ...process.env, ...environment },
        encoding: 'utf8',
        timeout: 360 * 60 * 1000,
        maxBuffer: 128 * 1024 * 1024,
        stdio
    });
    if (result.error || result.status !== 0) {
        const error = new Error(
            `Controller command failed: ${path.basename(program)} (exit ${result.status ?? 'unavailable'})`
        );
        if (program === 'timeout') {
            error.stdout = result.stdout;
        }
        throw error;
    }
    return result.stdout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [operation, directory, reason = 'finish', recipeExit = '1'] = process.argv.slice(2);
    try {
        const configuration = ['begin', 'directory'].includes(operation)
            ? toApiCaptureConfiguration(process.env)
            : readJson(path.join(directory, 'configuration.json'));
        configuration.environment = process.env;
        const capture = new ApiCpuCapture(configuration, { run: runControllerCommand });
        if (operation === 'directory') {
            console.log(capture.directory);
        }
        else if (operation === 'begin') {
            capture.begin();
            console.log(capture.directory);
        }
        else if (operation === 'check') {
            capture.check();
        }
        else if (['finish', 'deadline'].includes(operation)) {
            if (
                !capture.finish(
                    operation === 'deadline' ? 'deadline' : reason,
                    operation === 'deadline' ? null : Number(recipeExit)
                )
            ) {
                process.exitCode = 1;
            }
        }
        else {
            throw new Error('Unsupported capture operation');
        }
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
