import {
    spawn,
    spawnSync,
    type ChildProcess,
    type SpawnSyncReturns
} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toSafeApiTimingRecord } from '../../../apps/rallar-black-box/scripts/to-safe-api-timing-record.ts';
import type { ApiJsonObject } from '../../shared/api/api-json-value.ts';

interface TimingCaptureFiles {
    readonly records: string;
    readonly summary: ApiJsonObject;
}

interface TimingCaptureCommandDto {
    readonly directory: string;
    readonly fixture: string;
    readonly appInboxPhaseTiming: string | undefined;
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
    traceId: 'trace-transaction-capture',
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
    return {
        records: await readFile(path.join(directory, 'api-setup-timing.jsonl'), 'utf8'),
        summary: toTimingCaptureObject(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'))
    };
}

function toTimingCaptureObject(serialized: string): ApiJsonObject {
    const value: unknown = JSON.parse(serialized);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Capture artifact must be a JSON object.');
    }
    return value as ApiJsonObject;
}

function runCapture(captureCommand: TimingCaptureCommandDto): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ['--import', 'tsx', script, captureCommand.directory, '--', process.execPath, captureCommand.fixture], {
        encoding: 'utf8',
        env: { ...process.env, ...timingFlags, RALLAR_APP_INBOX_PHASE_TIMING: captureCommand.appInboxPhaseTiming },
        timeout: 15_000
    });
}

describe('full-stack API timing stdio capture', () => {
    it.each([undefined, '', '0', 'FALSE', 'false ', 'invalid'])(
        'refuses invalid phase timing %j before starting its child or creating capture evidence',
        async (appInboxPhaseTiming) => {
            const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
            try {
                const fixture = path.join(directory, 'test-only-child.cjs');
                const marker = path.join(directory, 'child-started');
                await writeFile(fixture, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
                const result = runCapture({ directory, fixture, appInboxPhaseTiming });
                expect(result.status).toBe(1);
                expect(result.stdout).toBe('');
                expect(result.stderr).toBe('API timing capture failed: configuration\n');
                await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(readFile(path.join(directory, 'api-setup-timing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
                await expect(readFile(path.join(directory, 'api-setup-timing-summary.json'))).rejects.toMatchObject({ code: 'ENOENT' });
            }
            finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    );

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
                traceId: 'http-request',
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
            const result = runCapture({ directory, fixture, appInboxPhaseTiming: 'true' });
            expect(result.status).toBe(23);
            expect(result.stdout).toBe('');
            expect(result.stderr).toBe('');
            const { records, summary } = await readCapture(directory);
            expect(records).not.toMatch(/AUTH_SENTINEL|PAYLOAD_SENTINEL|ERROR_SENTINEL|headers|errorMessage|partial/);
            expect(records.trim().split('\n').map(toTimingCaptureObject)).toEqual([
                {
                    type: 'rallar.timing',
                    component: 'app-inbox-phase',
                    operation: 'transaction',
                    status: 'ok',
                    durationMs: 4.25,
                    atEpochMs: 1234,
                    serviceId: 'api-1',
                    requestId: 'request-1',
                    traceId: 'trace-transaction-capture',
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
                    traceId: 'http-request',
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

    it('retains only validated promotion identities through the spawned capture', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-api-timing-'));
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            const expected = 'group=8;presence=5;version=1;state=active';
            const planned = 'group=9;presence=6;version=2;state=active';
            const applicationId = `application-${'a'.repeat(300)}`;
            const promotion = {
                type: 'rallar.timing',
                component: 'group-topology-publication',
                operation: 'promote',
                status: 'ok',
                durationMs: 3.25,
                atEpochMs: 1792338493460,
                serviceId: 'api-1',
                requestId: `topology-publication:v1:apply:${
                    JSON.stringify({
                        groupRef: { applicationId, workspaceId: 'workspace-1', groupId: 'group-1' },
                        formationEpoch: 2,
                        expectedLayout: { groupRevision: 8, presenceRevision: 5, version: 1, state: 'active' }
                    })
                }`,
                traceId: 'trace-topology-promotion',
                applicationId,
                workspaceId: 'workspace-1',
                groupId: 'group-1',
                details: {
                    expected,
                    planned,
                    outcome: 'promoted-newer',
                    rejection: 'ERROR_SENTINEL',
                    headers: { authorization: 'AUTH_SENTINEL' }
                },
                error: { message: 'ERROR_SENTINEL' },
                payload: 'PAYLOAD_SENTINEL'
            };
            const invalid = [
                { ...promotion, details: { ...promotion.details, planned: 'none' } },
                { ...promotion, details: { ...promotion.details, planned: undefined } },
                { ...promotion, details: { ...promotion.details, expected: 'group=08;presence=5;version=1;state=active' } },
                { ...promotion, details: { ...promotion.details, planned: 'group=-1;presence=6;version=2;state=active' } },
                { ...promotion, details: { ...promotion.details, planned: 'group=9007199254740992;presence=6;version=2;state=active' } },
                { ...promotion, details: { ...promotion.details, planned: `${planned};extra=1` } },
                { ...promotion, details: { ...promotion.details, expected: 'group=8;presence=5;version=1;state=unknown' } },
                { ...promotion, details: { ...promotion.details, outcome: 'future-outcome' } },
                { ...promotion, groupId: undefined },
                { ...promotion, status: 'error' },
                { ...promotion, durationMs: null }
            ];
            const lines = [
                promotion,
                { ...promotion, details: { ...promotion.details, expected: 'none', outcome: 'promoted' } },
                { ...promotion, details: { ...promotion.details, planned: 'none', outcome: 'rejected' } },
                ...invalid
            ]
                .map((record) => JSON.stringify(record)).join('\n') +
                '\n' +
                JSON.stringify(promotion).replace('"durationMs":3.25', '"durationMs":1e309') + '\n';
            expect(promotion.requestId.length).toBeGreaterThan(512);
            await writeFile(fixture, `process.stdout.write(${JSON.stringify(lines)});`);

            expect(runCapture({ directory, fixture, appInboxPhaseTiming: 'true' }).status).toBe(0);
            const { records, summary } = await readCapture(directory);
            expect(summary.retainedRecords).toBe(3);
            expect(records.trim()).not.toBe('');
            expect(records.trim().split('\n').map(toTimingCaptureObject)).toEqual([
                {
                    type: 'rallar.timing',
                    component: 'group-topology-publication',
                    operation: 'promote',
                    status: 'ok',
                    durationMs: 3.25,
                    atEpochMs: 1792338493460,
                    serviceId: 'api-1',
                    traceId: 'trace-topology-promotion',
                    applicationId,
                    workspaceId: 'workspace-1',
                    groupId: 'group-1',
                    details: { expected, planned, outcome: 'promoted-newer' }
                },
                {
                    type: 'rallar.timing',
                    component: 'group-topology-publication',
                    operation: 'promote',
                    status: 'ok',
                    durationMs: 3.25,
                    atEpochMs: 1792338493460,
                    serviceId: 'api-1',
                    traceId: 'trace-topology-promotion',
                    applicationId,
                    workspaceId: 'workspace-1',
                    groupId: 'group-1',
                    details: { expected: 'none', planned, outcome: 'promoted' }
                },
                {
                    type: 'rallar.timing',
                    component: 'group-topology-publication',
                    operation: 'promote',
                    status: 'ok',
                    durationMs: 3.25,
                    atEpochMs: 1792338493460,
                    serviceId: 'api-1',
                    traceId: 'trace-topology-promotion',
                    applicationId,
                    workspaceId: 'workspace-1',
                    groupId: 'group-1',
                    details: { expected, planned: 'none', outcome: 'rejected' }
                }
            ]);
            expect(records).not.toMatch(/requestId|formationEpoch|v1:apply|PAYLOAD_SENTINEL|AUTH_SENTINEL|ERROR_SENTINEL|headers|rejection/);
            expect(summary).toMatchObject({ retainedRecords: 3, rejectedLines: 12, observation: 'partial', captureFailure: null });
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
            expect(runCapture({ directory, fixture, appInboxPhaseTiming: 'true' }).status).toBe(0);
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
            const result = runCapture({ directory, fixture, appInboxPhaseTiming: 'true' });
            expect(result.status).toBe(31);
            expect(result.stderr).toContain('API timing capture failed: record-write');
            const summary = toTimingCaptureObject(await readFile(path.join(directory, 'api-setup-timing-summary.json'), 'utf8'));
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
            expect(runCapture({ directory, fixture, appInboxPhaseTiming: 'true' }).status).toBe(process.platform === 'darwin' ? 159 : 140);
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
            const result = runCapture({ directory, fixture, appInboxPhaseTiming: 'true' });
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
            const result = runCapture({ directory, fixture, appInboxPhaseTiming: 'true' });
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
            expect(runCapture({ directory, fixture, appInboxPhaseTiming: 'true' }).status).toBe(0);
            const { records, summary } = await readCapture(directory);
            expect(records.trim().split('\n')).toHaveLength(1);
            expect(toTimingCaptureObject(records).requestId).toBe('request-1');
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
            expect(runCapture({ directory, fixture, appInboxPhaseTiming: 'true' }).status).toBe(0);
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
        let runner: ChildProcess | undefined;
        try {
            const fixture = path.join(directory, 'test-only-child.cjs');
            const ready = path.join(directory, 'ready');
            await writeFile(
                fixture,
                `process.on('SIGTERM', () => {});
                require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
            );
            const capturedRunner = spawn(process.execPath, ['--import', 'tsx', script, directory, '--', process.execPath, fixture], {
                stdio: 'ignore',
                env: { ...process.env, ...timingFlags }
            });
            runner = capturedRunner;
            const closed = new Promise<number | null>((resolve) => capturedRunner.once('close', resolve));
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

const passBoundary = {
    type: 'rallar.timing',
    component: 'app-inbox-phase',
    operation: 'dequeue-pass-boundary',
    status: 'ok',
    durationMs: 6.5,
    atEpochMs: 1234,
    serviceId: 'server-1',
    details: {
        queueType: 'APP_INBOX',
        passWallMs: 6.5,
        lanesProbed: 'NEW,RETRY',
        probeMs: 1.25,
        probeToPassMs: 5,
        claimedInPass: 3,
        claimedNew: 2,
        claimedRetry: 1,
        claimedFairness: 0,
        claimedTimeout: 0,
        claimedFinalization: 0
    }
};

describe('safe dequeue-pass boundary projection', () => {
    it('retains the boundary of a claiming pass with its queue, probe timing and claims per lane', () => {
        expect(toSafeApiTimingRecord(JSON.stringify(passBoundary))).toEqual(passBoundary);
    });

    it('retains the boundary of an outbox pass that claimed nothing and followed no probe', () => {
        const unprobed = {
            ...passBoundary,
            details: {
                queueType: 'APP_OUTBOX',
                passWallMs: 0.5,
                lanesProbed: '',
                claimedInPass: 0,
                claimedNew: 0,
                claimedRetry: 0,
                claimedFairness: 0,
                claimedTimeout: 0,
                claimedFinalization: 0
            }
        };

        expect(toSafeApiTimingRecord(JSON.stringify(unprobed))).toEqual(unprobed);
    });

    it('drops a boundary field that is not its closed form, and the boundary fields on any other operation', () => {
        const malformed = {
            ...passBoundary,
            details: {
                ...passBoundary.details,
                queueType: 'APP_INBOX_SECRET',
                lanesProbed: 'NEW,SECRET',
                probeMs: -1,
                claimedRetry: 'one'
            }
        };
        const kept = {
            passWallMs: 6.5,
            probeToPassMs: 5,
            claimedInPass: 3,
            claimedNew: 2,
            claimedFairness: 0,
            claimedTimeout: 0,
            claimedFinalization: 0
        };

        expect(toSafeApiTimingRecord(JSON.stringify(malformed))).toEqual({ ...passBoundary, details: kept });
        expect(toSafeApiTimingRecord(JSON.stringify({ ...passBoundary, operation: 'transaction' }))).toEqual({
            ...passBoundary,
            operation: 'transaction',
            details: {}
        });
    });
});

const transactionLine = {
    type: 'rallar.timing',
    component: 'app-inbox-phase',
    operation: 'transaction',
    status: 'ok',
    durationMs: 9,
    atEpochMs: 1234,
    serviceId: 'server-1',
    requestId: 'request-1',
    traceId: 'trace-transaction-line',
    details: { type: 'GROUP_CREATE', resourceId: 'request-1', selectedLane: 'NEW', beginWaitMs: 7.25 }
};

describe('safe transaction projection', () => {
    it('retains the wait from the begin call to the transaction callback entry', () => {
        expect(toSafeApiTimingRecord(JSON.stringify(transactionLine))).toEqual(transactionLine);
    });

    it('drops a begin wait that is not a non-negative number, and the begin wait on any other operation', () => {
        const kept = { type: 'GROUP_CREATE', resourceId: 'request-1', selectedLane: 'NEW' };

        for (const beginWaitMs of [-1, '7', null, Number.NaN]) {
            expect(toSafeApiTimingRecord(JSON.stringify({
                ...transactionLine,
                details: { ...transactionLine.details, beginWaitMs }
            }))).toEqual({ ...transactionLine, details: kept });
        }
        expect(toSafeApiTimingRecord(JSON.stringify({ ...transactionLine, operation: 'handler-action' }))).toEqual({
            ...transactionLine,
            operation: 'handler-action',
            details: kept
        });
    });
});

const claimedEntryPass = {
    type: 'rallar.timing',
    component: 'app-inbox-phase',
    operation: 'dequeue-pass',
    status: 'ok',
    durationMs: 4,
    atEpochMs: 1234,
    serviceId: 'server-1',
    requestId: 'request-1',
    details: {
        type: 'GROUP_CREATE',
        resourceId: 'request-1',
        selectedLane: 'NEW',
        queueAgeMs: 5,
        statements: 4,
        executorWaitMs: 3.5,
        lanesProbed: 'NEW,RETRY,FAIRNESS',
        claimedInPass: 2,
        passWallMs: 8,
        handlersMs: 5
    }
};

describe('safe dequeue-pass claimed-entry projection', () => {
    it('retains the pass cost outside the handlers, the probed lanes and the claims of the pass', () => {
        expect(toSafeApiTimingRecord(JSON.stringify(claimedEntryPass))).toEqual(claimedEntryPass);
    });

    it('drops a cost field that is not its closed form, and the cost fields on any other operation', () => {
        const malformed = {
            ...claimedEntryPass,
            details: { ...claimedEntryPass.details, lanesProbed: 'NEW;DROP', statements: -1, handlersMs: '5' }
        };
        const kept = {
            type: 'GROUP_CREATE',
            resourceId: 'request-1',
            selectedLane: 'NEW',
            queueAgeMs: 5,
            executorWaitMs: 3.5,
            claimedInPass: 2,
            passWallMs: 8
        };

        expect(toSafeApiTimingRecord(JSON.stringify(malformed))).toEqual({ ...claimedEntryPass, details: kept });
        expect(toSafeApiTimingRecord(JSON.stringify({ ...claimedEntryPass, operation: 'handler-action' }))).toEqual({
            ...claimedEntryPass,
            operation: 'handler-action',
            details: { type: 'GROUP_CREATE', resourceId: 'request-1', selectedLane: 'NEW', queueAgeMs: 5 }
        });
    });
});

describe('safe trace projection', () => {
    it.each([['a space', 'trace with space'], ['a quote', 'trace"1'], ['513 characters', 'a'.repeat(513)], ['a number', 1]])(
        'drops a trace with %s, as any identity outside the identity grammar',
        (_label, traceId) => {
            expect(toSafeApiTimingRecord(JSON.stringify({ ...transactionLine, traceId }))).toEqual(
                toSafeApiTimingRecord(JSON.stringify({ ...transactionLine, traceId: undefined }))
            );
            expect(toSafeApiTimingRecord(JSON.stringify({ ...transactionLine, traceId }))).not.toHaveProperty('traceId');
        }
    );
});
