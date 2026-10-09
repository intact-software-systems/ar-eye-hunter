import { spawnSync } from 'node:child_process';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    isRtcPerformanceObservationCommand,
    parseRtcPerformanceObservationCommand
} from '../../../baseline/observation/rtc-performance-observation-cli-grammar.ts';
import { runRtcPerformanceObservationCli } from '../../../baseline/observation/rtc-performance-observation-cli.ts';

const observeArguments = [
    'observe-browser',
    '--source-ref=main',
    '--github-run-id=123456789',
    '--github-run-attempt=2',
    '--github-run-url=https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
    '--output=tmp/observation'
];
const liveRtcObserveArguments = [
    'observe-live-rtc',
    '--source-ref=main',
    '--github-run-id=123456789',
    '--github-run-attempt=2',
    '--github-run-url=https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
    '--output=tmp/observation'
];

describe('governed branch RTC capture CLI', () => {
    it.each(['passed', 'failed', 'incomplete'] as const)(
        'returns truthful branch capture metadata and status for %s primary evidence',
        async (primaryOutcome) => {
            const output: string[] = [];
            const errors: string[] = [];
            const captured = {
                baselineId: 'branch-primary',
                startedAt: '2026-10-09T00:00:00.000Z',
                source: { ref: 'codex/rtc-baseline-refresh', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
                primaryOutcome,
                acceptedMetrics: primaryOutcome === 'passed',
                repeatDecision: 'not-required' as const,
                repeatOutcome: 'not-run' as const
            };
            const code = await runRtcPerformanceObservationCli({
                args: ['capture-live-rtc', '--source-ref=codex/rtc-baseline-refresh', ...liveRtcObserveArguments.slice(2), '--rtc-capture-mode=native'],
                browserRunner: {
                    run: async () => {
                        throw new Error('No browser observation');
                    }
                },
                liveRtcRunner: {
                    run: async () => {
                        throw new Error('No Main archive');
                    },
                    captureBaseline: async (capture) => {
                        expect(capture.sourceRef).toBe('codex/rtc-baseline-refresh');
                        expect(capture.rtcCaptureMode).toBe('native');
                        return { ok: true, value: captured };
                    }
                },
                readFile: async () => {
                    throw new Error('No verification input');
                },
                verifyArchive: async () => {
                    throw new Error('No permanent archive');
                },
                writeStdout: (value) => output.push(value),
                writeStderr: (value) => errors.push(value)
            });
            expect(code).toBe(primaryOutcome === 'passed' ? 0 : 1);
            expect(output.map((value) => JSON.parse(value))).toEqual([captured]);
            expect(errors).toEqual([]);
        }
    );

    it('admits an exact feature branch without weakening Main-only observation', () => {
        const args = [...liveRtcObserveArguments];
        args[0] = 'capture-live-rtc';
        args[1] = '--source-ref=codex/rtc-baseline-refresh';
        expect(parseRtcPerformanceObservationCommand([...args, '--rtc-capture-mode=native']))
            .toMatchObject({ ok: true, value: { kind: 'capture-live-rtc', sourceRef: 'codex/rtc-baseline-refresh', rtcCaptureMode: 'native' } });
        args[0] = 'observe-live-rtc';
        expect(parseRtcPerformanceObservationCommand(args)).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'unsupported-source-ref' })] });
    });
});

describe('RTC performance observation CLI', () => {
    it('refuses selected invalid ambient capture at the actual Deno entry before live process effects', () => {
        const result = spawnSync('deno', [
            'run',
            '--cached-only',
            '--no-check',
            '--config=packages/shared-rtc-bench/deno.json',
            '--allow-read',
            '--allow-env',
            '--deny-run',
            'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts',
            ...liveRtcObserveArguments
        ], { encoding: 'utf8', env: { ...process.env, DENO_NO_UPDATE_CHECK: '1', RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'Native' } });
        expect(result.status).toBe(64);
        expect(JSON.parse(result.stderr.trim())).toEqual([
            expect.objectContaining({ code: 'invalid-rtc-capture-mode' })
        ]);
    });

    it('parses invalid live selector before reading even denied ambient environment at the actual Deno entry', () => {
        const result = spawnSync('deno', [
            'run',
            '--cached-only',
            '--no-check',
            '--config=packages/shared-rtc-bench/deno.json',
            '--allow-read',
            '--deny-env',
            '--deny-run',
            'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts',
            ...liveRtcObserveArguments,
            '--rtc-capture-mode=Native'
        ], { encoding: 'utf8', env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' } });
        expect(result.status).toBe(64);
        expect(JSON.parse(result.stderr.trim())).toEqual([expect.objectContaining({ code: 'invalid-rtc-capture-mode' })]);
    });

    it('keeps browser observation independent of the live capture flag', () => {
        expect(parseRtcPerformanceObservationCommand([...observeArguments, '--rtc-capture-mode=native']))
            .toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'unsupported-option' })] });
    });

    it.each(['off', 'signaling', 'native'])('admits the finite live RTC capture selector %s', (mode) => {
        expect(parseRtcPerformanceObservationCommand([
            ...liveRtcObserveArguments,
            `--rtc-capture-mode=${mode}`
        ])).toMatchObject({ ok: true, value: { kind: 'observe-live-rtc', rtcCaptureMode: mode } });
    });

    it.each(['', 'Native', 'all', 'native,signaling'])('refuses invalid live RTC capture selector %s', (mode) => {
        expect(parseRtcPerformanceObservationCommand([
            ...liveRtcObserveArguments,
            `--rtc-capture-mode=${mode}`
        ])).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-rtc-capture-mode' })])
        });
    });

    it('delivers an admitted Native selector to the live observation operation', async () => {
        const run = vi.fn(async () => ({
            ok: true as const,
            value: {
                observation: { observationId: 'native-observation' },
                output: { archivePath: 'native.zip', indexEntryPath: 'native.jsonl' }
            }
        }));
        const errors: string[] = [];
        const code = await runRtcPerformanceObservationCli({
            args: [...liveRtcObserveArguments, '--rtc-capture-mode=native'],
            browserRunner: { run: vi.fn() },
            liveRtcRunner: { run, captureBaseline: vi.fn() },
            readFile: vi.fn(),
            verifyArchive: vi.fn(),
            writeStdout: vi.fn(),
            writeStderr: (value) => errors.push(value)
        });

        expect({ code, errors }).toEqual({ code: 0, errors: [] });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ rtcCaptureMode: 'native' }));
    });

    it('parses the exact observe and verify command contracts', () => {
        expect(parseRtcPerformanceObservationCommand(observeArguments)).toEqual({
            ok: true,
            value: {
                kind: 'observe-browser',
                sourceRef: 'main',
                githubRunId: 123456789,
                githubRunAttempt: 2,
                githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
                outputDirectory: 'tmp/observation'
            }
        });
        expect(parseRtcPerformanceObservationCommand(liveRtcObserveArguments)).toEqual({
            ok: true,
            value: {
                kind: 'observe-live-rtc',
                sourceRef: 'main',
                githubRunId: 123456789,
                githubRunAttempt: 2,
                githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
                outputDirectory: 'tmp/observation'
            }
        });
        expect(parseRtcPerformanceObservationCommand([
            'verify-observation',
            '--archive=tmp/observation.zip',
            '--index-entry=tmp/index-entry.jsonl'
        ])).toEqual({
            ok: true,
            value: {
                kind: 'verify-observation',
                archivePath: 'tmp/observation.zip',
                indexEntryPath: 'tmp/index-entry.jsonl'
            }
        });
        expect(isRtcPerformanceObservationCommand('observe-browser')).toBe(true);
        expect(isRtcPerformanceObservationCommand('observe-live-rtc')).toBe(true);
        expect(isRtcPerformanceObservationCommand('validate')).toBe(false);
    });

    it.each([
        [
            observeArguments.map((argument) => argument.startsWith('--source-ref=') ? '--source-ref=release' : argument),
            'unsupported-source-ref'
        ],
        [
            observeArguments.map((argument) => argument.startsWith('--github-run-id=') ? '--github-run-id=0' : argument),
            'integer-out-of-range'
        ],
        [
            observeArguments.map((argument) =>
                argument.startsWith('--github-run-url=')
                    ? '--github-run-url=https://example.com/actions/runs/7'
                    : argument
            ),
            'invalid-workflow-url'
        ]
    ])('rejects unsafe observation command input with %s', (args, code) => {
        expect(parseRtcPerformanceObservationCommand(args)).toMatchObject({
            ok: false,
            issues: expect.arrayContaining([expect.objectContaining({ code })])
        });
    });

    it('dispatches observe-browser to the injected runner and reports its output', async () => {
        const run = vi.fn(async () => ({
            ok: true as const,
            value: {
                observation: { observationId: 'observation-id' },
                output: { archivePath: 'observation.zip', indexEntryPath: 'index-entry.jsonl' }
            }
        }));
        const stdout: string[] = [];

        const code = await runRtcPerformanceObservationCli({
            args: observeArguments,
            browserRunner: { run },
            liveRtcRunner: { run: vi.fn(), captureBaseline: vi.fn() },
            readFile: vi.fn(),
            verifyArchive: vi.fn(),
            writeStdout: (value) => stdout.push(value),
            writeStderr: vi.fn()
        });

        expect(code).toBe(0);
        expect(run).toHaveBeenCalledWith({
            sourceRef: 'main',
            githubRunId: 123456789,
            githubRunAttempt: 2,
            githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
            outputDirectory: 'tmp/observation'
        });
        expect(stdout).toEqual([
            '{"observationId":"observation-id","archivePath":"observation.zip","indexEntryPath":"index-entry.jsonl"}\n'
        ]);
    });

    it('dispatches observe-live-rtc to the RTC-B06 runner', async () => {
        const run = vi.fn(async () => ({
            ok: true as const,
            value: {
                observation: { observationId: 'b06-observation-id' },
                output: { archivePath: 'b06.zip', indexEntryPath: 'index-entry.jsonl' }
            }
        }));
        const stdout: string[] = [];

        const code = await runRtcPerformanceObservationCli({
            args: liveRtcObserveArguments,
            browserRunner: {
                run: async () => {
                    throw new Error('observe-live-rtc must not invoke the browser observation runner');
                }
            },
            liveRtcRunner: { run, captureBaseline: vi.fn() },
            readFile: vi.fn(),
            verifyArchive: vi.fn(),
            writeStdout: (value) => stdout.push(value),
            writeStderr: vi.fn()
        });

        expect(code).toBe(0);
        expect(run).toHaveBeenCalledWith({
            sourceRef: 'main',
            githubRunId: 123456789,
            githubRunAttempt: 2,
            githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
            outputDirectory: 'tmp/observation'
        });
        expect(stdout).toEqual([
            '{"observationId":"b06-observation-id","archivePath":"b06.zip","indexEntryPath":"index-entry.jsonl"}\n'
        ]);
    });

    it('reads and verifies an archived index entry without trusting repository JSON', async () => {
        const archiveBytes = new Uint8Array([1, 2, 3]);
        const indexEntry = { schema: 'index-entry' };
        const verifyArchive = vi.fn(async () => ({
            ok: true as const,
            value: { observationId: 'observation-id' }
        }));
        const stdout: string[] = [];

        const code = await runRtcPerformanceObservationCli({
            args: [
                'verify-observation',
                '--archive=tmp/observation.zip',
                '--index-entry=tmp/index-entry.jsonl'
            ],
            browserRunner: { run: vi.fn() },
            liveRtcRunner: { run: vi.fn(), captureBaseline: vi.fn() },
            readFile: vi.fn(async (path) =>
                path.endsWith('.zip')
                    ? archiveBytes
                    : new TextEncoder().encode(`${JSON.stringify(indexEntry)}\n`)
            ),
            verifyArchive,
            writeStdout: (value) => stdout.push(value),
            writeStderr: vi.fn()
        });

        expect(code).toBe(0);
        expect(verifyArchive).toHaveBeenCalledWith({ bytes: archiveBytes, indexEntry });
        expect(stdout).toEqual(['{"observationId":"observation-id"}\n']);
    });
});
