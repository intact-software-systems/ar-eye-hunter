import { createRtcB05ObservationDenoRuntime } from '../observation/rtc-b05-observation-deno-runtime.ts';
import { createRtcB05ObservationRunner } from '../observation/rtc-b05-observation-runner.ts';
import { createRtcB06ObservationDenoRuntime } from '../observation/rtc-b06-observation-deno-runtime.ts';
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
import {
    resolveRtcBaselineCaptureAdmission,
    RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME,
    type RtcBaselineCaptureAdmission
} from '../runtime/rtc-baseline-capture-admission.ts';
import { createDenoRtcBaselineAdapters } from '../runtime/rtc-baseline-deno-adapters.ts';
import { createRtcBaselineDenoRuntime } from '../runtime/rtc-baseline-deno-runtime.ts';
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

interface RtcBaselineCliComposition {
    readonly envelope: RtcBaselineEnvelope;
    readonly observation: RtcPerformanceObservationCliDependencies;
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
    if (!dispatched.result.ok) {
        input.writeStderr(`${JSON.stringify(dispatched.result.issues)}\n`);
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
            input.writeStdout(`${columns.join('\t')}\n`);
        }
    }
    else if (dispatched.kind === 'repeat-required') {
        if (dispatched.result.value.workloadIds.length === 0) {
            return 3;
        }
        input.writeStdout(`${[...dispatched.result.value.workloadIds].sort().join(',')}\n`);
    }
    else if (dispatched.kind === 'compare-paired') {
        input.writeStdout(`${JSON.stringify(dispatched.result.value)}\n`);
        if (dispatched.result.value.outcome === 'inconclusive-still-noisy') {
            return 2;
        }
    }
    return 0;
}

function defaultRuntime() {
    const deno = Deno;
    return {
        envGet: (name: string) => deno.env.get(name),
        get build() {
            return deno.build;
        },
        get version() {
            return deno.version;
        },
        get pid() {
            return deno.pid;
        },
        get errors() {
            return deno.errors;
        },
        lstat: (path: string) => deno.lstat(path),
        open: (path: string, options: Deno.OpenOptions) => deno.open(path, options),
        mkdir: (path: string, options?: { recursive?: boolean; }) => deno.mkdir(path, options),
        readFile: (path: string) => deno.readFile(path),
        writeFile: (path: string, bytes: Uint8Array, options?: { createNew?: boolean; }) =>
            deno.writeFile(path, bytes, options),
        remove: (path: string, options?: { recursive?: boolean; }) => deno.remove(path, options),
        readDir: (path: string) => deno.readDir(path),
        hostname: () => deno.hostname(),
        randomUuid: () => crypto.randomUUID(),
        kill: (processId: number, signal: Deno.Signal | number) => deno.kill(processId, signal),
        async command(executable: string, arguments_: readonly string[]) {
            return new deno.Command(executable, { args: [...arguments_] }).output();
        },
        writeStdout: async (bytes: Uint8Array) => {
            await deno.stdout.write(bytes);
        },
        writeStderr: async (bytes: Uint8Array) => {
            await deno.stderr.write(bytes);
        },
        now: () => new Date(),
        performanceNow: () => performance.now(),
        systemMemoryInfo: () => deno.systemMemoryInfo(),
        availableParallelism: () => navigator.hardwareConcurrency
    };
}

export function createDefaultRtcBaselineEnvelope() {
    return createRtcBaselineDenoRuntime(createDenoRtcBaselineAdapters(defaultRuntime()));
}

function createDefaultRtcBaselineCliComposition(
    captureAdmission: RtcBaselineCaptureAdmission | undefined
): RtcBaselineCliComposition {
    const runtime = defaultRuntime();
    const adapters = createDenoRtcBaselineAdapters(runtime);
    const envelope = createRtcBaselineDenoRuntime(adapters, captureAdmission);
    const browserObservation = createRtcB05ObservationDenoRuntime({
        runtime,
        adapters,
        envelope
    });
    const liveRtcObservation = createRtcB06ObservationDenoRuntime({
        runtime,
        adapters,
        envelope,
        producerOutput: runtime,
        rtcCaptureMode: captureAdmission?.mode
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
    const deno = Deno;
    const parsed = isRtcPerformanceObservationCommand(deno.args[0])
        ? parseRtcPerformanceObservationCommand(deno.args)
        : parseRtcBaselineCommand(deno.args);
    if (!parsed.ok) {
        writeRtcBaselineCliOutput(deno.stderr, `${JSON.stringify(parsed.issues)}\n`);
        return 64;
    }
    const admission = parsed.value.kind === 'observe-live-rtc'
        ? resolveRtcBaselineCaptureAdmission(
            parsed.value.rtcCaptureMode,
            deno.env.get(RTC_BASELINE_CAPTURE_ENVIRONMENT_NAME)
        )
        : { ok: true as const, value: undefined };
    if (!admission.ok) {
        writeRtcBaselineCliOutput(deno.stderr, `${JSON.stringify(admission.issues)}\n`);
        return 64;
    }
    const composition = createDefaultRtcBaselineCliComposition(admission.value);
    const code = await runRtcBaselineCli({
        command: parsed.value,
        ...composition,
        writeStdout: (value) => writeRtcBaselineCliOutput(deno.stdout, value),
        writeStderr: (value) => writeRtcBaselineCliOutput(deno.stderr, value)
    });
    return code;
}

if (import.meta.main) {
    Deno.exit(await runDefaultRtcBaselineCli());
}
