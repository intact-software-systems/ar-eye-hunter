import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it
} from 'vitest';

interface RtcB06CaptureDispatchInput {
    readonly type: string;
    readonly required: boolean;
    readonly default: string;
    readonly description: string;
    readonly hasChoiceEnumeration: boolean;
}

interface RtcB06BaselineCaptureStep {
    readonly run: string;
    readonly captureEnvironment: string;
}

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

describe('RTC-B06 capture dispatch input', () => {
    it('accepts text entry with signaling as the default and leaves mode validation to the CLI', () => {
        const capture = readCaptureDispatchInput();

        expect(capture).toMatchObject({ type: 'string', required: true, default: 'signaling' });
        expect(capture.hasChoiceEnumeration).toBe(false);
        expect(capture.description).toEqual(expect.stringContaining('off'));
        expect(capture.description).toEqual(expect.stringContaining('signaling'));
        expect(capture.description).toEqual(expect.stringContaining('native'));
    });

    it.each(['off', 'signaling', 'native', undefined])('forwards baseline selection %s unchanged to the CLI', (selection) => {
        const capture = readCaptureDispatchInput();
        const step = readBaselineCaptureStep();
        expect(step.captureEnvironment).toBe('${{ inputs.rtc_capture_mode }}');
        const selectedMode = selection ?? capture.default;
        const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rtc-b06-dispatch-input-'));
        try {
            mkdirSync(path.join(fixtureRoot, 'bin'));
            writeFileSync(path.join(fixtureRoot, 'bin/npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$RTC_B06_ARGUMENT_RECORD"\n');
            chmodSync(path.join(fixtureRoot, 'bin/npm'), 0o755);
            const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                    RTC_CAPTURE_MODE: selectedMode,
                    RTC_SOURCE_REF: 'codex/rtc-baseline-refresh',
                    RTC_OBSERVATION_OUTPUT: fixtureRoot,
                    RTC_B06_ARGUMENT_RECORD: path.join(fixtureRoot, 'arguments.txt'),
                    RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'inherited-invalid-mode',
                    GITHUB_RUN_ID: '123456789',
                    GITHUB_RUN_ATTEMPT: '2',
                    GITHUB_SERVER_URL: 'https://github.com',
                    GITHUB_REPOSITORY: 'example/repository'
                }
            });

            expect(result).toMatchObject({ status: 0, stderr: '' });
            const arguments_ = readFileSync(path.join(fixtureRoot, 'arguments.txt'), 'utf8').trim().split('\n');
            expect(arguments_.filter((argument) => argument.startsWith('--rtc-capture-mode=')))
                .toEqual([`--rtc-capture-mode=${selection ?? 'signaling'}`]);
            expect(arguments_.slice(0, 5)).toEqual(['run', '--silent', 'perf:rtc-baseline', '--', 'capture-live-rtc']);
        }
        finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });

    it.each([
        ['observe-live-rtc', 'main'],
        ['capture-live-rtc', 'codex/rtc-baseline-refresh']
    ])('refuses invalid text at the actual %s entry before environment or producer admission', (command, sourceRef) => {
        const result = spawnSync('deno', [
            'run',
            '--cached-only',
            '--no-check',
            '--config=packages/shared-rtc-bench/deno.json',
            '--allow-read',
            '--deny-env',
            '--deny-run',
            'packages/shared-rtc-bench/baseline/command/run-rtc-baseline-cli.ts',
            command,
            `--source-ref=${sourceRef}`,
            '--github-run-id=123456789',
            '--github-run-attempt=2',
            '--github-run-url=https://github.com/example/repository/actions/runs/123456789',
            '--output=tmp/observation',
            '--rtc-capture-mode=Native'
        ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' } });

        expect(result.status).toBe(64);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr.trim())).toEqual([
            expect.objectContaining({ path: '$.rtc-capture-mode', code: 'invalid-rtc-capture-mode' })
        ]);
    });
});

function readCaptureDispatchInput(): RtcB06CaptureDispatchInput {
    const workflow = decodeWorkflowMapping(load(readFileSync(path.join(repoRoot, '.github/workflows/rtc-b06-performance-observation.yml'), 'utf8')));
    const dispatch = Reflect.get(Reflect.get(workflow, 'on'), 'workflow_dispatch');
    return decodeCaptureDispatchInput(Reflect.get(Reflect.get(dispatch, 'inputs'), 'rtc_capture_mode'));
}

function readBaselineCaptureStep(): RtcB06BaselineCaptureStep {
    const workflow = decodeWorkflowMapping(load(readFileSync(path.join(repoRoot, '.github/workflows/rtc-b06-performance-observation.yml'), 'utf8')));
    const steps = Reflect.get(Reflect.get(Reflect.get(workflow, 'jobs'), 'capture'), 'steps');
    if (!Array.isArray(steps)) {
        throw new Error('RTC-B06 capture steps must be an array.');
    }
    return decodeBaselineCaptureStep(steps.find((value) => Reflect.get(decodeWorkflowMapping(value), 'name') === 'Capture RTC-B06 governed branch baseline'));
}

function decodeCaptureDispatchInput(value: unknown): RtcB06CaptureDispatchInput {
    const capture = decodeWorkflowMapping(value);
    const type = Reflect.get(capture, 'type');
    const required = Reflect.get(capture, 'required');
    const defaultMode = Reflect.get(capture, 'default');
    const description = Reflect.get(capture, 'description');
    if (typeof type !== 'string' || typeof required !== 'boolean' || typeof defaultMode !== 'string' || typeof description !== 'string') {
        throw new Error('RTC-B06 capture input must define its type, required flag, default and description.');
    }
    return { type, required, default: defaultMode, description, hasChoiceEnumeration: 'options' in capture };
}

function decodeBaselineCaptureStep(value: unknown): RtcB06BaselineCaptureStep {
    const step = decodeWorkflowMapping(value);
    const run = Reflect.get(step, 'run');
    const captureEnvironment = Reflect.get(Reflect.get(step, 'env'), 'RTC_CAPTURE_MODE');
    if (typeof run !== 'string' || typeof captureEnvironment !== 'string') {
        throw new Error('RTC-B06 baseline command and capture environment must be strings.');
    }
    return { run, captureEnvironment };
}

function decodeWorkflowMapping(value: unknown): object {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('RTC-B06 workflow value must be a mapping.');
    }
    return value;
}
