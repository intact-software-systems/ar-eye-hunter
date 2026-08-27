import { describe, expect, it, vi } from 'vitest';

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

describe('RTC performance observation CLI', () => {
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
            runner: { run },
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
            runner: { run: vi.fn() },
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
