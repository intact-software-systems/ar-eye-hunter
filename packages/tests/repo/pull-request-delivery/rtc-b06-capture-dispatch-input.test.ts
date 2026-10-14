import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    CORE_SCHEMA,
    load,
    YAML11_SCHEMA
} from 'js-yaml';
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
    readonly options: readonly string[] | undefined;
}

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

describe('RTC-B06 capture dispatch input', () => {
    it.each([CORE_SCHEMA, YAML11_SCHEMA])('offers readable string choices under YAML scalar schema %#', (schema) => {
        const workflow = decodeWorkflowMapping(
            load(readFileSync(path.join(repoRoot, '.github/workflows/rtc-b06-performance-observation.yml'), 'utf8'), { schema })
        );
        const dispatch = Reflect.get(Reflect.get(workflow, 'on') ?? Reflect.get(workflow, 'true'), 'workflow_dispatch');
        const capture = decodeCaptureDispatchInput(Reflect.get(Reflect.get(dispatch, 'inputs'), 'rtc_capture_mode'));

        expect(capture).toMatchObject({ type: 'choice', required: true, default: 'signaling' });
        expect(capture.options).toEqual(['disabled', 'signaling', 'native']);
    });

    it.each([
        ['observe-live-rtc', 'main', 'Native'],
        ['observe-live-rtc', 'main', 'disabled'],
        ['capture-live-rtc', 'codex/rtc-baseline-refresh', 'Native'],
        ['capture-live-rtc', 'codex/rtc-baseline-refresh', 'disabled']
    ])('refuses noncanonical capture at the actual %s entry before environment or producer admission', (command, sourceRef, selection) => {
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
            `--rtc-capture-mode=${selection}`
        ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' } });

        expect(result.status).toBe(64);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr.trim())).toEqual([
            expect.objectContaining({ path: '$.rtc-capture-mode', code: 'invalid-rtc-capture-mode' })
        ]);
    });
});

function decodeCaptureDispatchInput(value: unknown): RtcB06CaptureDispatchInput {
    const capture = decodeWorkflowMapping(value);
    const type = Reflect.get(capture, 'type');
    const required = Reflect.get(capture, 'required');
    const defaultMode = Reflect.get(capture, 'default');
    const description = Reflect.get(capture, 'description');
    const options = Reflect.get(capture, 'options');
    if (typeof type !== 'string' || typeof required !== 'boolean' || typeof defaultMode !== 'string' || typeof description !== 'string') {
        throw new Error('RTC-B06 capture input must define its type, required flag, default and description.');
    }
    if (options !== undefined && (!Array.isArray(options) || !options.every((option) => typeof option === 'string'))) {
        throw new Error('RTC-B06 capture choices must be strings.');
    }
    return { type, required, default: defaultMode, description, options };
}

function decodeWorkflowMapping(value: unknown): object {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('RTC-B06 workflow value must be a mapping.');
    }
    return value;
}
