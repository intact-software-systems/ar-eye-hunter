import { spawn } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';

import {
    ApiCpuCapture,
    runControllerCommand,
    toApiCaptureConfiguration
} from '../../../scripts/hosted-rallar/controller/rallar-api-cpu-capture.mjs';

export class ApiCpuCaptureFixture {
    constructor(root) {
        this.root = root;
        this.effects = [];
        this.capabilityInvocations = [];
        this.failAt = null;
        this.pid = 123;
        this.source = '0'.repeat(40);
        this.children = [];
        this.healthAttempts = 0;
        this.inspectorStopped = false;
        this.captureJournal = null;
        this.configuration = toApiCaptureConfiguration({
            RALLAR_API_CAPTURE_ROOT: root,
            RALLAR_API_CAPTURE_OVERRIDE: path.join(root, 'unit', 'override.conf'),
            RALLAR_OPERATION_ARTIFACT_ROOT: path.join(root, 'operations'),
            RALLAR_DISTRIBUTED_ARTIFACT_DIR: path.join(root, 'distributed'),
            RALLAR_API_SERVER_TIMING: 'true',
            RALLAR_PRESERVE_PUBLIC_SETTINGS: '1',
            RALLAR_ROLLOUT_BEFORE_RUN: 'true',
            RALLAR_HETZNER_OPERATOR_PHASE: 'prepare',
            RALLAR_REPO_REF: 'a'.repeat(40),
            RALLAR_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
            RALLAR_DISTRIBUTED_RUN_ID: 'dist-owned',
            RALLAR_CAPTURE_WORKFLOW_RUN_ID: '123',
            RALLAR_CAPTURE_WORKFLOW_RUN_ATTEMPT: '1',
            RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS: '300',
            RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS: '330'
        });
        this.original = {
            deployedCommit: this.source,
            dirty: false,
            failureFence: false,
            activity: { rolloutProcessPresent: false, recipeProcessPresent: false },
            services: { api: 'active', control: 'active' },
            health: { apiLoopback: '200', controlLoopback: '200' },
            operatorSettingsSha256: 'c'.repeat(64),
            configuration: Object.fromEntries(
                [
                    'RALLAR_TIMING_LOGS',
                    'RALLAR_APP_INBOX_PHASE_TIMING',
                    'RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT',
                    'RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE',
                    'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE',
                    'RALLAR_RTC_TOPOLOGY_MESH_PARAM_K'
                ].map((key) => [key, { present: false, value: null, source: null }])
            )
        };
        this.capture = new ApiCpuCapture(this.configuration, this);
    }

    /** @param {{ environment: NodeJS.ProcessEnv, capabilityDirectory?: string }} execution */
    run(program, args, execution) {
        const { environment, capabilityDirectory } = execution;
        const command = `${program} ${args.join(' ')}`;
        this.effects.push(command);
        if (program === 'runuser' || (program === 'timeout' && args.includes('runuser'))) {
            this.capabilityInvocations.push({ program, args, capabilityDirectory });
            if (args.includes('probe') && this.failAt === 'preflight') {
                throw new Error('Linux capability probe failed');
            }
            return args.includes('--version') ? 'deno 2.9.5\nv8 15.0\n' : '';
        }
        if (program === 'timeout') {
            return this.runScript(args.slice(6), environment);
        }
        if (program === 'bash') {
            return this.runScript(args, environment);
        }
        if (program === 'free' && this.failAt === 'resources') {
            throw new Error('Resource snapshot failed');
        }
        if (program === 'curl') {
            this.healthAttempts += 1;
            if (this.failAt === 'health-starting' && this.healthAttempts === 1) {
                throw new Error('curl connection refused');
            }
        }
        if (program === 'git') {
            return this.source;
        }
        if (program === 'readlink') {
            return '/usr/local/bin/deno';
        }
        if (program === 'cat') {
            return '/usr/local/bin/deno\0run\0--allow-net\0/opt/api/main.ts\0';
        }
        if (program === 'systemd-run' && args.some((arg) => arg.endsWith('-inspector'))) {
            this.startInspector(args.at(-1));
        }
        if (program === 'systemctl') {
            return this.readSystemd(args);
        }
        return '';
    }

    runScript(args, environment) {
        if (args[0].endsWith('07-status-controller.sh')) {
            return JSON.stringify({ ...this.original, deployedCommit: this.source });
        }
        if (args[0].endsWith('08-rollout-controller.sh')) {
            if (this.failAt === 'restore' && environment.RALLAR_REPO_REF === this.original.deployedCommit) {
                throw new Error('Store migration fence');
            }
            if (environment.RALLAR_API_RESTORE_CONFIGURATION) {
                this.cleanupRolloutArtifacts(args[0]);
                this.replayedConfiguration = JSON.parse(readFileSync(environment.RALLAR_API_RESTORE_CONFIGURATION, 'utf8'));
            }
            this.source = environment.RALLAR_REPO_REF;
        }
        if (args[0].endsWith('15-logs.sh')) {
            if (this.failAt === 'partial-journal') {
                throw Object.assign(new Error('Journal timed out'), { stdout: 'partial redacted journal' });
            }
            if (this.failAt === 'export') {
                throw new Error('Journal export failed');
            }
            return this.captureJournal ?? `2026-10-19 deno[${this.pid}]: [${this.pid}:0xabc:0] 40 ms: GC: {"pause":1.0,"gc":"s"}\n`;
        }
        return '';
    }

    cleanupRolloutArtifacts(script) {
        runControllerCommand('bash', [script], {
            environment: {
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'cleanup-disk-pressure',
                RALLAR_CHECKOUT_DIR: path.join(this.root, 'checkout'),
                RALLAR_DISTRIBUTED_ARTIFACT_DIR: this.configuration.environment.RALLAR_DISTRIBUTED_ARTIFACT_DIR,
                RALLAR_ROLLOUT_CONTROL_STATE_DIR: path.join(this.root, 'control'),
                RALLAR_ROLLOUT_TMP_DIR: path.join(this.root, 'tmp'),
                RALLAR_ROLLOUT_NPM_CACHE_DIR: path.join(this.root, 'npm-cache'),
                RALLAR_ROLLOUT_NPM_LOG_DIR: path.join(this.root, 'npm-log')
            }
        });
        this.artifactsDeletedDuringRestore = !existsSync(path.join(this.configuration.environment.RALLAR_DISTRIBUTED_ARTIFACT_DIR, 'dist-owned'));
    }

    readSystemd(args) {
        if (args[0] === 'stop' && args[1].endsWith('-inspector.service')) {
            this.profilePresentAtInspectorStop = existsSync(path.join(this.inspectorDirectory, 'api.cpuprofile'));
            if (this.failAt === 'inspector-stop') {
                throw new Error('Inspector stop refused');
            }
            this.inspectorStopped = true;
            if (this.failAt === 'inspector-collected' || this.failAt === 'inspector-race') {
                throw new Error('Inspector unit not loaded');
            }
        }
        if (args[0] === 'start' && args[1] === 'rallar-api-v1.service') {
            if (this.failAt === 'start') {
                throw new Error('API start failed after override');
            }
            this.pid += 1;
        }
        if (args[0] === 'is-active') {
            return this.failAt === 'lost-inspector' ? 'failed' : 'active';
        }
        if (args.includes('--property=User')) {
            return 'rallar';
        }
        if (args.includes('--property=ExecStart')) {
            return '{ path=/usr/local/bin/deno ; argv[]=/usr/local/bin/deno run --allow-net /opt/api/main.ts ; }';
        }
        if (args[0] === 'show' && args.at(-1).endsWith('-inspector.service')) {
            if (this.inspectorStopped && this.failAt === 'inspector-failed-during-stop') {
                return 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=exit-code\nExecMainCode=1\nExecMainStatus=23\n';
            }
            if (this.inspectorStopped || this.failAt === 'inspector-collected') {
                return 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n';
            }
            if (this.failAt === 'inspector-failed') {
                return 'LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\nExecMainCode=1\nExecMainStatus=23\n';
            }
            return 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=456\nResult=success\nExecMainCode=0\nExecMainStatus=0\n';
        }
        if (args[0] === 'show') {
            return `MainPID=${this.pid}\nExecMainStartTimestampMonotonic=10000\nCPUUsageNSec=2000\nMemoryCurrent=100000\nActiveState=active\n`;
        }
        return '';
    }

    startInspector(directory) {
        this.inspectorDirectory = directory;
        writeFileSync(path.join(directory, 'started.json'), JSON.stringify({ pid: this.pid }));
        const result = { status: this.failAt === 'invalid-profile' ? 'failed' : 'valid', pid: this.pid };
        const child = spawn(process.execPath, [
            '-e',
            `
            const fs = require('node:fs');
            const path = require('node:path');
            const directory = process.argv[1];
            const timer = setInterval(() => {
                if (fs.existsSync(path.join(directory, 'stop'))) {
                    fs.writeFileSync(path.join(directory, 'api.cpuprofile'), JSON.stringify({nodes:[{id:1,callFrame:{}}],samples:[1],timeDeltas:[10],startTime:10,endTime:20}));
                    fs.writeFileSync(path.join(directory, 'profile-result.json'), process.argv[2]);
                    clearInterval(timer);
                }
            }, 10);
            setTimeout(() => { clearInterval(timer); }, 5000).unref();
        `,
            directory,
            JSON.stringify(result)
        ], { stdio: 'ignore' });
        this.children.push({ child, closed: new Promise((resolve) => child.once('close', resolve)) });
    }

    readState() {
        return JSON.parse(readFileSync(this.capture.stateFile, 'utf8'));
    }
    async dispose() {
        for (const owned of this.children) {
            if (owned.child.exitCode === null && owned.child.signalCode === null) {
                owned.child.kill('SIGKILL');
            }
            await owned.closed;
        }
    }
}
