import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface SetupTimingSummary {
    readonly sourceCommit: string | null;
    readonly apiEntry: string | null;
    readonly effectiveFlags: { readonly timingLogs: boolean; readonly appInboxPhaseTiming: boolean; };
    readonly durableRequestCompletion: 'unverified';
    retainedRecords: number;
    rejectedLines: number;
    oversizedLines: number;
    trailingPartial: boolean;
    stdoutEof: boolean;
    stderrBytes: number;
    childExitCode: number | null;
    childSignal: NodeJS.Signals | null;
    childFailure: 'spawn' | null;
    childErrorCode: string | null;
    requestedSignal: NodeJS.Signals | null;
    cleanup: 'not-started' | 'running' | 'reaped' | 'killed-and-reaped';
    captureFailure: 'record-write' | 'summary-write' | 'stdout-read' | 'stderr-read' | null;
    observation: 'missing' | 'partial' | 'stream-complete';
}

interface SafeSetupTimingRecordDto {
    readonly type: 'rallar.timing';
    readonly component: string;
    readonly operation: string;
    readonly status: 'ok' | 'error';
    readonly durationMs: number;
    readonly atEpochMs: number;
    [field: string]: string | number | Readonly<Record<string, string | number | boolean>>;
}

const MAX_LINE_BYTES = 65_536;
const IDENTITY_FIELDS = [
    'serviceId',
    'requestId',
    'applicationId',
    'workspaceId',
    'groupId',
    'principalId',
    'sessionId'
];
const DETAIL_IDENTITIES = ['clientId', 'type', 'topicId', 'contextId', 'resourceId', 'senderId'];
const DETAIL_NUMBERS = [
    'attempt',
    'attempts',
    'processingAttempts',
    'reservationAttempt',
    'queueAgeMs',
    'dueAgeMs',
    'nextAttempt',
    'delayMsecs',
    'elapsedMsecs',
    'waitMaxElapsedMsecs'
];
const COMPONENTS = ['http', 'app-inbox', 'app-inbox-phase', 'app-inbox-handler', 'group-state-service'];

class FullStackApiTimingCapture {
    private readonly recordsPath: string;
    private readonly summaryPath: string;
    private readonly summary: SetupTimingSummary;
    private readonly decoder = new StringDecoder('utf8');
    private pending = '';
    private discardingOversizedLine = false;
    private child: ChildProcess | undefined;
    private killTimeout: ReturnType<typeof setTimeout> | undefined;
    private forcedKill = false;

    constructor(directory: string, apiArguments: readonly string[]) {
        this.recordsPath = path.join(directory, 'api-setup-timing.jsonl');
        this.summaryPath = path.join(directory, 'api-setup-timing-summary.json');
        const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
        this.summary = {
            sourceCommit: commit.status === 0 && /^[a-f0-9]{40}$/.test(commit.stdout.trim())
                ? commit.stdout.trim()
                : null,
            apiEntry: apiArguments.includes('apps/api-v1/src/main.ts') ? 'apps/api-v1/src/main.ts' : null,
            effectiveFlags: {
                timingLogs: true,
                appInboxPhaseTiming: true
            },
            durableRequestCompletion: 'unverified',
            retainedRecords: 0,
            rejectedLines: 0,
            oversizedLines: 0,
            trailingPartial: false,
            stdoutEof: false,
            stderrBytes: 0,
            childExitCode: null,
            childSignal: null,
            childFailure: null,
            childErrorCode: null,
            requestedSignal: null,
            cleanup: 'not-started',
            captureFailure: null,
            observation: 'partial'
        };
        mkdirSync(directory, { recursive: true });
        // A caller owns a fresh recorder directory. Never replace evidence from another invocation.
        writeFileSync(this.summaryPath, JSON.stringify(this.summary, null, 2), { flag: 'wx', mode: 0o600 });
        writeFileSync(this.recordsPath, '', { flag: 'wx', mode: 0o600 });
    }

    async start(apiArguments: readonly string[]): Promise<number> {
        const [executable, ...argumentsToApi] = apiArguments;
        const child = spawn(executable, argumentsToApi, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.child = child;
        const onSigint = () => this.stop('SIGINT');
        const onSigterm = () => this.stop('SIGTERM');
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
        child.once('spawn', () => {
            this.summary.cleanup = 'running';
            this.writeSummary();
        });
        child.once('error', (error: NodeJS.ErrnoException) => {
            this.summary.childFailure = 'spawn';
            this.summary.childErrorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
                ? error.code
                : null;
        });
        child.stdout.on('data', (chunk: Buffer) => this.appendStdout(this.decoder.write(chunk)));
        child.stderr.on('data', (chunk: Buffer) => {
            this.summary.stderrBytes += chunk.length;
        });
        child.stdout.once('end', () => {
            this.appendStdout(this.decoder.end());
            this.summary.stdoutEof = true;
        });
        child.stdout.once('error', () => this.recordCaptureFailure('stdout-read'));
        child.stderr.once('error', () => this.recordCaptureFailure('stderr-read'));
        return await new Promise<number>((resolve) => {
            child.once('close', (code, signal) => {
                process.removeListener('SIGINT', onSigint);
                process.removeListener('SIGTERM', onSigterm);
                clearTimeout(this.killTimeout);
                resolve(this.finish(code, signal));
            });
        });
    }

    private stop(signal: NodeJS.Signals): void {
        if (this.summary.requestedSignal !== null) {
            return;
        }
        this.summary.requestedSignal = signal;
        this.child?.kill(signal);
        this.killTimeout = setTimeout(() => {
            this.forcedKill = this.child?.kill('SIGKILL') === true;
        }, 3_000);
        this.writeSummary();
    }

    private appendStdout(chunk: string): void {
        for (const segment of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
            const terminated = segment.endsWith('\n');
            if (this.discardingOversizedLine) {
                this.discardingOversizedLine = !terminated;
                continue;
            }
            this.pending += segment;
            if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) {
                this.summary.oversizedLines += 1;
                this.summary.rejectedLines += 1;
                this.pending = '';
                this.discardingOversizedLine = !terminated;
                continue;
            }
            if (terminated) {
                this.appendTimingRecord(this.pending);
                this.pending = '';
            }
        }
    }

    private appendTimingRecord(line: string): void {
        const record = toSafeTimingRecord(line);
        if (record === undefined) {
            this.summary.rejectedLines += 1;
            return;
        }
        if (this.summary.captureFailure !== null) {
            return;
        }
        try {
            appendFileSync(this.recordsPath, JSON.stringify(record) + '\n');
            this.summary.retainedRecords += 1;
        }
        catch {
            this.recordCaptureFailure('record-write');
        }
    }

    private finish(code: number | null, signal: NodeJS.Signals | null): number {
        this.summary.childExitCode = this.summary.childFailure === 'spawn' ? null : code;
        this.summary.childSignal = signal;
        this.summary.trailingPartial = this.pending.length > 0 || this.discardingOversizedLine;
        this.summary.cleanup = 'reaped';
        if (this.summary.childFailure === 'spawn') {
            this.summary.cleanup = 'not-started';
        }
        else if (this.forcedKill) {
            this.summary.cleanup = 'killed-and-reaped';
        }
        this.summary.observation = 'partial';
        const completeStream = this.summary.captureFailure === null && this.summary.stdoutEof &&
            !this.summary.trailingPartial && this.summary.rejectedLines === 0 && code === 0 && signal === null;
        if (completeStream) {
            this.summary.observation = 'missing';
            if (this.summary.retainedRecords > 0) {
                this.summary.observation = 'stream-complete';
            }
        }
        this.writeSummary();
        if (this.summary.childFailure === 'spawn') {
            return 1;
        }
        if (signal !== null) {
            return 128 + constants.signals[signal];
        }
        if (code !== null && code !== 0) {
            return code;
        }
        return Number(this.summary.captureFailure !== null);
    }

    private writeSummary(): void {
        try {
            writeFileSync(this.summaryPath, JSON.stringify(this.summary, null, 2));
        }
        catch {
            this.recordCaptureFailure('summary-write');
        }
    }

    private recordCaptureFailure(failure: NonNullable<SetupTimingSummary['captureFailure']>): void {
        if (this.summary.captureFailure === null) {
            this.summary.captureFailure = failure;
            process.stderr.write(`API timing capture failed: ${failure}\n`);
        }
    }
}

function toSafeTimingRecord(
    line: string
): SafeSetupTimingRecordDto | undefined {
    let record: unknown;
    try {
        record = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (
        !isRecord(record) || record.type !== 'rallar.timing' || !isAllowedString(record.component, COMPONENTS) ||
        !isSafeIdentity(record.operation) || (record.status !== 'ok' && record.status !== 'error') ||
        !isNonNegativeNumber(record.durationMs) || !isNonNegativeNumber(record.atEpochMs)
    ) {
        return undefined;
    }
    const safe: SafeSetupTimingRecordDto = {
        type: 'rallar.timing',
        component: record.component,
        operation: record.operation,
        status: record.status,
        durationMs: record.durationMs,
        atEpochMs: record.atEpochMs
    };
    for (const field of IDENTITY_FIELDS) {
        if (isSafeIdentity(record[field])) {
            safe[field] = record[field];
        }
    }
    if (isAllowedString(record.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])) {
        safe.method = record.method;
    }
    if (typeof record.path === 'string' && /^\/api\/[A-Za-z0-9_./%:-]{1,512}$/.test(record.path)) {
        safe.path = record.path;
    }
    if (isNonNegativeNumber(record.httpStatus) && Number.isInteger(record.httpStatus) && record.httpStatus <= 599) {
        safe.httpStatus = record.httpStatus;
    }
    if (isRecord(record.details)) {
        safe.details = toSafeTimingDetails(record.details);
    }
    return safe;
}

function toSafeTimingDetails(
    details: Readonly<Record<string, unknown>>
): Readonly<Record<string, string | number | boolean>> {
    const safe: Record<string, string | number | boolean> = {};
    for (const field of DETAIL_IDENTITIES) {
        if (isSafeIdentity(details[field])) {
            safe[field] = details[field];
        }
    }
    for (const field of DETAIL_NUMBERS) {
        if (isNonNegativeNumber(details[field])) {
            safe[field] = details[field];
        }
    }
    if (isAllowedString(details.selectedLane, ['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'])) {
        safe.selectedLane = details.selectedLane;
    }
    if (
        isAllowedString(details.resultStatus, [
            'NEW',
            'RETRY',
            'RESERVED',
            'COMPLETED',
            'FAILED',
            'ABORTED',
            'NON_RETRYABLE'
        ])
    ) {
        safe.resultStatus = details.resultStatus;
    }
    if (isAllowedString(details.classification, ['accepted', 'not-ready', 'retryable', 'non-retryable'])) {
        safe.classification = details.classification;
    }
    if (typeof details.exhaustion === 'boolean') {
        safe.exhaustion = details.exhaustion;
    }
    return safe;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIdentity(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_.:%|/@-]{1,512}$/.test(value);
}

function isAllowedString(value: unknown, allowed: readonly string[]): value is string {
    return typeof value === 'string' && allowed.includes(value);
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function startFullStackApiWithTiming(): Promise<void> {
    const [directory, separator, ...apiArguments] = process.argv.slice(2);
    if (
        !directory || !path.isAbsolute(directory) || separator !== '--' || apiArguments.length === 0 ||
        process.env.RALLAR_TIMING_LOGS !== 'true' || process.env.RALLAR_APP_INBOX_PHASE_TIMING !== 'true'
    ) {
        process.stderr.write('API timing capture failed: configuration\n');
        process.exitCode = 1;
        return;
    }
    try {
        const capture = new FullStackApiTimingCapture(directory, apiArguments);
        process.exitCode = await capture.start(apiArguments);
    }
    catch {
        process.stderr.write('API timing capture failed: initialization\n');
        process.exitCode = 1;
    }
}

await startFullStackApiWithTiming();
