import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

interface TimingCaptureFiles {
    readonly records: string;
    readonly summary: Readonly<Record<string, ApiJsonValue>>;
}

const script = 'apps/rallar-black-box/scripts/run-full-stack-api-with-timing.ts';
const timingFlags = { RALLAR_TIMING_LOGS: 'true', RALLAR_APP_INBOX_PHASE_TIMING: 'true' };
const event = {
    type: 'rallar.timing',
    component: 'app-inbox-phase',
    operation: 'transaction',
    status: 'ok',
    durationMs: 4.25,
    atEpochMs: 1234,
    requestId: 'request-1',
    serviceId: 'api-1',
    details: {
        type: 'create-group',
        topicId: 'AppInbox',
        contextId: 'context-1',
        resourceId: 'request-1',
        senderId: 'controller-05',
        attempt: 2,
        selectedLane: 'RETRY',
        queueAgeMs: 51,
        dueAgeMs: 3,
        resultStatus: 'COMPLETED',
        readMs: 1,
        authorization: 'AUTH_SENTINEL',
        data: 'PAYLOAD_SENTINEL',
        errorMessage: 'ERROR_SENTINEL'
    },
    error: { message: 'ERROR_SENTINEL' },
    headers: { authorization: 'AUTH_SENTINEL' },
    data: 'PAYLOAD_SENTINEL'
};

async function readCapture(directory: string): Promise<TimingCaptureFiles> {
    const summary: unknown = JSON.parse(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'));
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error('Capture summary must be a JSON object.');
    }
    return {
        records: await readFile(path.join(directory, 'api-setup-timing.jsonl'), 'utf8'),
        summary: summary as Readonly<Record<string, ApiJsonValue>>
    };
}

function runCapture(directory: string, fixture: string) {
    return spawnSync(process.execPath, ['--import', 'tsx', script, directory, '--', process.execPath, fixture], {
        encoding: 'utf8',
        env: { ...process.env, ...timingFlags },
        timeout: 15_000
    });
}

describe('full-stack API timing stdio capture', () => {
    it('retains chunked safe timing projections and the actual nonzero child exit without raw logs', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        const fixture = path.join(directory, 'test-only-child.cjs');
        try {
            const http = {
                type: 'rallar.timing',
                component: 'http',
                operation: 'request',
                status: 'error',
                durationMs: 50,
                atEpochMs: 1235,
                requestId: 'http-request',
                method: 'POST',
                path: '/api/groups/group-1',
                httpStatus: 500,
                details: { clientId: 'controller-05', origin: 'AUTH_SENTINEL', userAgent: 'PAYLOAD_SENTINEL' }
            };
            const lines = 'AUTH_SENTINEL raw stdout\n{bad-json\n' + JSON.stringify(event) + '\n' +
                JSON.stringify(http) + '\n' + JSON.stringify({ ...event, durationMs: -1 }) + '\n' +
                JSON.stringify({ ...event, component: { toString: null } }) + '\npartial';
            await writeFile(
                fixture,
                `process.stdout.write(${JSON.stringify(lines.slice(0, 50))});
                setTimeout(() => { process.stdout.write(${JSON.stringify(lines.slice(50))});
                process.stderr.write('ERROR_SENTINEL'); process.exitCode = 23; }, 10);`
            );
            const result = runCapture(directory, fixture);
            expect(result.status).toBe(23);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
            const { records, summary } = await readCapture(directory);
            expect(records).not.toMatch(/AUTH_SENTINEL|PAYLOAD_SENTINEL|ERROR_SENTINEL|headers|errorMessage|partial/);
            expect(records.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
                {
                    type: 'rallar.timing',
                    component: 'app-inbox-phase',
                    operation: 'transaction',
                    status: 'ok',
                    durationMs: 4.25,
                    atEpochMs: 1234,
                    serviceId: 'api-1',
                    requestId: 'request-1',
                    details: {
                        type: 'create-group',
                        topicId: 'AppInbox',
                        contextId: 'context-1',
                        resourceId: 'request-1',
                        senderId: 'controller-05',
                        attempt: 2,
                        selectedLane: 'RETRY',
                        queueAgeMs: 51,
                        dueAgeMs: 3,
                        resultStatus: 'COMPLETED'
                    }
                },
                {
                    type: 'rallar.timing',
                    component: 'http',
                    operation: 'request',
                    status: 'error',
                    durationMs: 50,
                    atEpochMs: 1235,
                    requestId: 'http-request',
                    method: 'POST',
                    path: '/api/groups/group-1',
                    httpStatus: 500,
                    details: { clientId: 'controller-05' }
                }
            ]);
            expect(summary).toMatchObject({
                retainedRecords: 2,
                rejectedLines: 4,
                trailingPartial: true,
                stdoutEof: true,
                childExitCode: 23,
                childSignal: null,
                cleanup: 'reaped',
                captureFailure: null,
                durableRequestCompletion: 'unverified',
                observation: 'partial',
                effectiveFlags: { timingLogs: true, appInboxPhaseTiming: true }
            });
            expect(summary.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('represents an empty clean stream without claiming that requests completed', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            await writeFile(fixture, 'process.exitCode = 0;');
            expect(runCapture(directory, fixture).status).toBe(0);
            const { records, summary } = await readCapture(directory);
            expect(records).toBe('');
            expect(summary).toMatchObject({
                stdoutEof: true,
                retainedRecords: 0,
                observation: 'missing',
                childExitCode: 0,
                durableRequestCompletion: 'unverified'
            });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps spawn failure visible without leaking operational error prose', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const result = spawnSync(process.execPath, ['--import', 'tsx', script, directory, '--', '/missing/AUTH_SENTINEL'], {
                encoding: 'utf8',
                env: { ...process.env, ...timingFlags },
                timeout: 15_000
            });
            expect(result.status).toBe(1);
            const { summary } = await readCapture(directory);
            expect(summary).toMatchObject({
                childFailure: 'spawn',
                childErrorCode: 'ENOENT',
                childExitCode: null,
                cleanup: 'not-started',
                durableRequestCompletion: 'unverified'
            });
            expect(result.stdout + result.stderr + JSON.stringify(summary)).not.toContain('AUTH_SENTINEL');
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('exposes recording failure while still preserving the child exit', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            await writeFile(
                fixture,
                `const fs = require('node:fs');
                fs.unlinkSync(${JSON.stringify(path.join(directory, 'api-setup-timing.jsonl'))});
                fs.mkdirSync(${JSON.stringify(path.join(directory, 'api-setup-timing.jsonl'))});
                process.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')}); process.exitCode = 31;`
            );
            const result = runCapture(directory, fixture);
            expect(result.status).toBe(31);
            expect(result.stderr).toContain('API timing capture failed: record-write');
            const summary = JSON.parse(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'));
            expect(summary).toMatchObject({ captureFailure: 'record-write', childExitCode: 31, cleanup: 'reaped', retainedRecords: 0, observation: 'partial' });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('retains the actual child signal and its conventional exit status', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            await writeFile(fixture, 'process.kill(process.pid, \'SIGUSR2\');');
            expect(runCapture(directory, fixture).status).toBe(process.platform === 'darwin' ? 159 : 140);
            const { summary } = await readCapture(directory);
            expect(summary).toMatchObject({ childSignal: 'SIGUSR2', childExitCode: null, cleanup: 'reaped', observation: 'partial' });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('preserves prior records and summary without starting a new API child', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            const marker = path.join(directory, 'child-started');
            await writeFile(fixture, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
            await writeFile(path.join(directory, 'api-setup-timing.jsonl'), 'prior-records');
            await writeFile(path.join(directory, 'api-setup-timing-summary.json'), 'prior-summary');
            const result = runCapture(directory, fixture);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('API timing capture failed: initialization');
            expect(await readFile(path.join(directory, 'api-setup-timing.jsonl'), 'utf8')).toBe('prior-records');
            expect(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8')).toBe('prior-summary');
            await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('makes summary-write failure visible and fails an otherwise successful child', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            const summaryPath = path.join(directory, 'api-setup-timing-summary.json');
            await writeFile(
                fixture,
                `const fs = require('node:fs'); fs.unlinkSync(${JSON.stringify(summaryPath)});
                fs.mkdirSync(${JSON.stringify(summaryPath)}); process.exitCode = 0;`
            );
            const result = runCapture(directory, fixture);
            expect(result.status).toBe(1);
            expect(result.stderr).toBe('API timing capture failed: summary-write\n');
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('bounds oversized lines and resumes safe capture at the next newline', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            await writeFile(
                fixture,
                `process.stdout.write('x'.repeat(70000));
                setTimeout(() => process.stdout.write('suffix\\n' + ${JSON.stringify(JSON.stringify(event) + '\n')}), 10);`
            );
            expect(runCapture(directory, fixture).status).toBe(0);
            const { records, summary } = await readCapture(directory);
            expect(records.trim().split('\n')).toHaveLength(1);
            expect(JSON.parse(records).requestId).toBe('request-1');
            expect(summary).toMatchObject({ retainedRecords: 1, rejectedLines: 1, oversizedLines: 1, trailingPartial: false });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('distinguishes clean timing stream completion from durable request completion', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            await writeFile(fixture, `process.stdout.write(${JSON.stringify(JSON.stringify(event) + '\n')});`);
            expect(runCapture(directory, fixture).status).toBe(0);
            const { summary } = await readCapture(directory);
            expect(summary).toMatchObject({
                observation: 'stream-complete',
                stdoutEof: true,
                childExitCode: 0,
                retainedRecords: 1,
                durableRequestCompletion: 'unverified'
            });
        }
        finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('forwards teardown and bounds cleanup for a child ignoring SIGTERM', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        let runner: ReturnType<typeof spawn> | undefined;
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            const ready = path.join(directory, 'ready');
            await writeFile(
                fixture,
                `process.on('SIGTERM', () => {});
                require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
            );
            runner = spawn(process.execPath, ['--import', 'tsx', script, directory, '--', process.execPath, fixture], {
                stdio: 'ignore',
                env: { ...process.env, ...timingFlags }
            });
            const closed = new Promise<number | null>((resolve) => runner!.once('close', resolve));
            await expect.poll(async () => await readFile(ready, 'utf8').catch(() => ''), { timeout: 5_000 }).not.toBe('');
            const childPid = Number(await readFile(ready, 'utf8'));
            runner.kill('SIGTERM');
            expect(await closed).toBe(137);
            const { summary } = await readCapture(directory);
            expect(summary).toMatchObject({
                requestedSignal: 'SIGTERM',
                childSignal: 'SIGKILL',
                childExitCode: null,
                cleanup: 'killed-and-reaped',
                stdoutEof: true,
                observation: 'partial'
            });
            expect(() => process.kill(childPid, 0)).toThrow();
        }
        finally {
            runner?.kill('SIGKILL');
            await rm(directory, { recursive: true, force: true });
        }
    }, 12_000);
});
