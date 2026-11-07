import { spawn } from 'node:child_process';
import { writeSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { availableParallelism, hostname, totalmem } from 'node:os';

import { RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS } from '../evidence/rtc-baseline-writer-lock.ts';
import { createRtcB05ObservationBunRuntime } from '../observation/rtc-b05-observation-bun-runtime.ts';
import { createRtcB05ObservationRunner } from '../observation/rtc-b05-observation-runner.ts';
import { createRtcB06ObservationBunRuntime } from '../observation/rtc-b06-observation-bun-runtime.ts';
import { createRtcB06ObservationRunner } from '../observation/rtc-b06-observation-runner.ts';
import { verifyRtcPerformanceObservationArchive } from '../observation/rtc-performance-observation-archive.ts';
import {
    isRtcPerformanceObservationCommand,
    parseRtcPerformanceObservationCommand,
    type RtcPerformanceObservationParsedCommand
} from '../observation/rtc-performance-observation-cli-grammar.ts';
import {
    runRtcPerformanceObservationCommand,
    type RtcPerformanceObservationCliDependencies
} from '../observation/rtc-performance-observation-cli.ts';
import { createBunRtcBaselineAdapters } from '../runtime/rtc-baseline-bun-adapters.ts';
import type { RtcBaselineBunFile, RtcBaselineBunPort } from '../runtime/rtc-baseline-bun-port.ts';
import { createRtcBaselineBunRuntime } from '../runtime/rtc-baseline-bun-runtime.ts';
import {
    resolveRtcBaselineCaptureAdmission,
    RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME,
    type RtcBaselineCaptureAdmission
} from '../runtime/rtc-baseline-capture-admission.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import { parseRtcBaselineCommand, type RtcBaselineParsedCommand } from './rtc-baseline-cli-grammar.ts';
import { writeRtcBaselineCliOutput } from './write-rtc-baseline-cli-output.ts';

interface RtcBaselineCliDependencies {
    envelope: RtcBaselineEnvelope;
    observation?: RtcPerformanceObservationCliDependencies;
    writeStdout(value: string): void;
    writeStderr(value: string): void;
}

type RtcBaselineCliInput =
    & RtcBaselineCliDependencies
    & (
        | { readonly args: readonly string[]; }
        | { readonly command: RtcBaselineParsedCommand | RtcPerformanceObservationParsedCommand; }
    );

type RtcBaselineCliDispatch = Awaited<ReturnType<typeof dispatch>>;

interface RtcBaselineCliComposition {
    readonly envelope: RtcBaselineEnvelope;
    readonly observation: RtcPerformanceObservationCliDependencies;
}

export async function runRtcBaselineCli(input: RtcBaselineCliInput) {
    const parsed = 'command' in input
        ? { ok: true as const, value: input.command }
        : isRtcPerformanceObservationCommand(input.args[0])
        ? parseRtcPerformanceObservationCommand(input.args)
        : parseRtcBaselineCommand(input.args);
    if (!parsed.ok) {
        input.writeStderr(`${JSON.stringify(parsed.issues)}\n`);
        return 64;
    }
    const command = parsed.value;
    if (
        command.kind === 'observe-browser' || command.kind === 'observe-live-rtc' ||
        command.kind === 'capture-live-rtc' ||
        command.kind === 'verify-observation'
    ) {
        if (input.observation === undefined) {
            input.writeStderr(
                '[{"path":"$.observation","code":"missing-observation-runtime","message":"Observation runtime is unavailable."}]\n'
            );
            return 1;
        }
        return runRtcPerformanceObservationCommand({
            command,
            ...input.observation,
            writeStdout: input.writeStdout,
            writeStderr: input.writeStderr
        });
    }
    const dispatched = await dispatch(input.envelope, command);
    return writeRtcBaselineDispatchOutput(dispatched, input);
}

function writeRtcBaselineDispatchOutput(
    dispatched: RtcBaselineCliDispatch,
    output: Pick<RtcBaselineCliDependencies, 'writeStdout' | 'writeStderr'>
): number {
    if (!dispatched.result.ok) {
        output.writeStderr(`${JSON.stringify(dispatched.result.issues)}\n`);
        return 1;
    }
    if (dispatched.kind === 'list-external-attempts') {
        for (const attempt of dispatched.result.value) {
            const columns = [
                attempt.caseId,
                attempt.intendedPhase,
                attempt.outerOrdinal,
                attempt.environmentId
            ];
            output.writeStdout(`${columns.join('\t')}\n`);
        }
    }
    else if (dispatched.kind === 'repeat-required') {
        if (dispatched.result.value.workloadIds.length === 0) {
            return 3;
        }
        output.writeStdout(`${[...dispatched.result.value.workloadIds].sort().join(',')}\n`);
    }
    else if (dispatched.kind === 'compare-paired') {
        output.writeStdout(`${JSON.stringify(dispatched.result.value)}\n`);
        if (dispatched.result.value.outcome === 'inconclusive-still-noisy') {
            return 2;
        }
    }
    return 0;
}

function captureRequest(command: Extract<RtcBaselineParsedCommand, { kind: 'initialize'; }>) {
    return {
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId: command.baselineId,
        workloadIds: command.workloadIds,
        environmentId: command.environmentId,
        retainedSampleMultiplier: command.retainedSampleMultiplier,
        repeatLink: null,
        conditionalEnvironmentDecisions: command.conditionalEnvironmentDecision === null
            ? []
            : [command.conditionalEnvironmentDecision],
        ...(command.repeatOf === null ? {} : { repeatOf: command.repeatOf })
    };
}

async function dispatch(envelope: RtcBaselineEnvelope, command: RtcBaselineParsedCommand) {
    if (command.kind === 'initialize') {
        return {
            kind: command.kind,
            result: await envelope.initializeBaseline(captureRequest(command))
        };
    }
    if (command.kind === 'capture') {
        return {
            kind: command.kind,
            result: await envelope.captureWorkload({
                baselineId: command.baselineId,
                workloadId: command.workloadId
            })
        };
    }
    if (command.kind === 'list-external-attempts') {
        return {
            kind: command.kind,
            result: await envelope.readExternalAttempts({
                baselineId: command.baselineId,
                workloadId: command.workloadId
            })
        };
    }
    if (command.kind === 'record-browser') {
        const { kind: _kind, ...input } = command;
        return { kind: command.kind, result: await envelope.recordBrowser(input) };
    }
    if (command.kind === 'record-external') {
        const { kind: _kind, ...input } = command;
        return { kind: command.kind, result: await envelope.recordExternalAttempt(input) };
    }
    if (command.kind === 'record-external-cohort') {
        const { kind: _kind, ...input } = command;
        return {
            kind: command.kind,
            result: await envelope.recordExternalCohortAssertion(input)
        };
    }
    if (
        command.kind === 'repeat-required' || command.kind === 'compare-paired' || command.kind === 'validate' ||
        command.kind === 'finalize'
    ) {
        return dispatchBaselineRead(envelope, command);
    }
    throw new Error(`Unsupported baseline command ${command.kind}.`);
}

async function dispatchBaselineRead(
    envelope: RtcBaselineEnvelope,
    command: Extract<
        RtcBaselineParsedCommand,
        { kind: 'repeat-required' | 'compare-paired' | 'validate' | 'finalize'; }
    >
) {
    if (command.kind === 'repeat-required') {
        return {
            kind: command.kind,
            result: await envelope.readRepeatRequirement({ baselineId: command.baselineId })
        };
    }
    if (command.kind === 'compare-paired') {
        const { kind: _kind, ...input } = command;
        return { kind: command.kind, result: await envelope.readPairedComparison(input) };
    }
    if (command.kind === 'validate') {
        return {
            kind: command.kind,
            result: await envelope.readBaselineValidation({ baselineId: command.baselineId })
        };
    }
    return {
        kind: command.kind,
        result: await envelope.finalize({ baselineId: command.baselineId })
    };
}

class RtcBaselineNotFound extends Error {}
class RtcBaselineAlreadyExists extends Error {}
class RtcBaselinePermissionDenied extends Error {}

function translateNodeError(error: unknown): never {
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            throw new RtcBaselineNotFound('File not found.');
        }
        if (code === 'EEXIST') {
            throw new RtcBaselineAlreadyExists('File already exists.');
        }
        if (code === 'EACCES' || code === 'EPERM') {
            throw new RtcBaselinePermissionDenied('Permission denied.');
        }
    }
    throw error;
}

async function translateError<Value>(operation: () => Promise<Value>): Promise<Value> {
    try {
        return await operation();
    }
    catch (error) {
        translateNodeError(error);
    }
}

function toFileInfo(stat: Stats) {
    return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymlink: stat.isSymbolicLink(),
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size
    };
}

function toOpenFlags(options: { read: boolean; write: boolean; createNew?: boolean; }): string {
    if (options.createNew) {
        return options.read ? 'wx+' : 'wx';
    }
    if (options.read && options.write) {
        return 'r+';
    }
    return options.read ? 'r' : 'w';
}

async function openNodeFile(
    path: string,
    options: { read: boolean; write: boolean; createNew?: boolean; }
): Promise<RtcBaselineBunFile> {
    try {
        const handle = await open(path, toOpenFlags(options));
        return wrapFileHandle(path, handle);
    }
    catch (error) {
        translateNodeError(error);
    }
}

function isAlreadyExists(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readLockAgeMs(lockDir: string): Promise<number> {
    const lockStat = await stat(lockDir);
    return Date.now() - lockStat.mtimeMs;
}

async function tryAcquireLock(lockDir: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await mkdir(lockDir); // atomic: exactly one process succeeds
            return true;
        }
        catch (error) {
            if (!isAlreadyExists(error)) {
                throw error;
            }
        }
        // The holder may release between the failed mkdir and this stale check, so the
        // lock dir can vanish before it is stat'd. Treat ENOENT as losing the race and
        // retry the acquire loop.
        try {
            const ageMs = await readLockAgeMs(lockDir);
            if (ageMs < RTC_BASELINE_WRITER_LOCK_STALE_AFTER_MS) {
                return false; // live lock — never touch a fresh lock
            }
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
            continue;
        }
        try {
            await rm(lockDir, { recursive: true, force: false }); // one reclaimer wins
        }
        catch {
            // Lost the reclamation race; retry mkdir on the next loop.
        }
    }
    return false;
}

export function wrapFileHandle(path: string, handle: FileHandle): RtcBaselineBunFile {
    let position = 0;
    let lockHeld = false;
    const lockDir = `${path}.lock`;

    async function acquireOrReclaimLock(): Promise<boolean> {
        if (lockHeld) {
            return true;
        }
        const acquired = await tryAcquireLock(lockDir);
        lockHeld = acquired;
        return acquired;
    }

    return {
        stat: async () => toFileInfo(await handle.stat()),
        async seek(offset, whence) {
            if (whence === 0) {
                position = offset;
            }
            else if (whence === 1) {
                position += offset;
            }
            else {
                position = (await handle.stat()).size + offset;
            }
            return position;
        },
        async read(buffer) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (bytesRead === 0) {
                return null;
            }
            position += bytesRead;
            return bytesRead;
        },
        async write(bytes) {
            const { bytesWritten } = await handle.write(bytes, 0, bytes.length, position);
            position += bytesWritten;
            return bytesWritten;
        },
        truncate: (length) => handle.truncate(length),
        sync: () => handle.sync(),
        async lock() {
            while (!(await acquireOrReclaimLock())) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        },
        tryLock: () => acquireOrReclaimLock(),
        async unlock() {
            if (lockHeld) {
                lockHeld = false;
                await rm(lockDir, { recursive: true, force: true });
            }
        },
        close: () => handle.close()
    };
}

function runNodeCommand(
    executable: string,
    arguments_: readonly string[]
): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array; }> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({
                code: code ?? 0,
                stdout: Buffer.concat(stdoutChunks),
                stderr: Buffer.concat(stderrChunks)
            });
        });
    });
}

function defaultRuntime() {
    return {
        envGet: (name: string) => process.env[name],
        get build() {
            return { os: process.platform, arch: process.arch };
        },
        get version() {
            return { bun: process.versions.bun ?? process.versions.node };
        },
        get pid() {
            return process.pid;
        },
        get errors() {
            return {
                NotFound: RtcBaselineNotFound,
                AlreadyExists: RtcBaselineAlreadyExists,
                PermissionDenied: RtcBaselinePermissionDenied
            };
        },
        lstat: (path: string) => translateError(async () => toFileInfo(await lstat(path))),
        open: (path: string, options: { read: boolean; write: boolean; createNew?: boolean; }) =>
            openNodeFile(path, options),
        mkdir: (path: string, options?: { recursive?: boolean; }) =>
            translateError(async () => {
                await mkdir(path, options);
            }),
        readFile: (path: string) => translateError(() => readFile(path)),
        writeFile: (path: string, bytes: Uint8Array, options?: { createNew?: boolean; }) =>
            translateError(() => writeFile(path, bytes, { flag: options?.createNew ? 'wx' : 'w' })),
        remove: (path: string, options?: { recursive?: boolean; }) => translateError(() => rm(path, options)),
        readDir: async function* (path: string) {
            const entries = await translateError(() => readdir(path, { withFileTypes: true }));
            for (const entry of entries) {
                yield {
                    name: entry.name,
                    isFile: entry.isFile(),
                    isDirectory: entry.isDirectory(),
                    isSymlink: entry.isSymbolicLink()
                };
            }
        },
        hostname: () => hostname(),
        randomUuid: () => crypto.randomUUID(),
        kill: (processId: number, signal: number) => {
            try {
                process.kill(processId, signal);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                    throw new RtcBaselineNotFound('Process not found.');
                }
                throw error;
            }
        },
        command: (executable: string, arguments_: readonly string[]) => runNodeCommand(executable, arguments_),
        writeStdout: async (bytes: Uint8Array) => {
            writeSync(1, bytes);
        },
        writeStderr: async (bytes: Uint8Array) => {
            writeSync(2, bytes);
        },
        now: () => new Date(),
        performanceNow: () => performance.now(),
        systemMemoryInfo: () => ({ total: totalmem() }),
        availableParallelism: () => availableParallelism()
    };
}

function createDefaultRtcBaselineCliComposition(
    captureAdmission: RtcBaselineCaptureAdmission | undefined
): RtcBaselineCliComposition {
    const runtime = defaultRuntime();
    const adapters = createBunRtcBaselineAdapters(runtime);
    const envelope = createRtcBaselineBunRuntime(adapters, captureAdmission);
    const browserObservation = createRtcB05ObservationBunRuntime({
        runtime,
        adapters,
        envelope
    });
    const liveRtcObservation = createRtcB06ObservationBunRuntime({
        repositoryRoot: process.cwd(),
        runtime,
        adapters,
        envelope,
        producerOutput: runtime
    });
    return {
        envelope,
        observation: {
            browserRunner: createRtcB05ObservationRunner(browserObservation),
            liveRtcRunner: createRtcB06ObservationRunner(liveRtcObservation),
            readFile: runtime.readFile,
            verifyArchive: verifyRtcPerformanceObservationArchive
        }
    };
}

async function runDefaultRtcBaselineCli() {
    const arguments_ = process.argv.slice(2);
    const stdoutWriter = { writeSync: (bytes: Uint8Array) => writeSync(1, bytes) };
    const stderrWriter = { writeSync: (bytes: Uint8Array) => writeSync(2, bytes) };
    const parsed = isRtcPerformanceObservationCommand(arguments_[0])
        ? parseRtcPerformanceObservationCommand(arguments_)
        : parseRtcBaselineCommand(arguments_);
    if (!parsed.ok) {
        writeRtcBaselineCliOutput(stderrWriter, `${JSON.stringify(parsed.issues)}\n`);
        return 64;
    }
    const admission = (parsed.value.kind === 'observe-live-rtc' || parsed.value.kind === 'capture-live-rtc')
        ? resolveRtcBaselineCaptureAdmission(
            parsed.value.rtcCaptureMode,
            process.env[RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME]
        )
        : { ok: true as const, value: undefined };
    if (!admission.ok) {
        writeRtcBaselineCliOutput(stderrWriter, `${JSON.stringify(admission.issues)}\n`);
        return 64;
    }
    const composition = createDefaultRtcBaselineCliComposition(admission.value);
    const code = await runRtcBaselineCli({
        command: parsed.value,
        ...composition,
        writeStdout: (value) => writeRtcBaselineCliOutput(stdoutWriter, value),
        writeStderr: (value) => writeRtcBaselineCliOutput(stderrWriter, value)
    });
    return code;
}

if (import.meta.main) {
    process.exit(await runDefaultRtcBaselineCli());
}
