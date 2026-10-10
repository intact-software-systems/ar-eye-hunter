import type { RtcBaselineJson, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcB05ObservationOutput, RtcB05ObservationRunInput } from './rtc-b05-observation-runner.ts';
import type {
    RtcB06BaselineCapture,
    RtcB06BaselineCaptureInput,
    RtcB06ObservationOutput,
    RtcB06ObservationRunInput
} from './rtc-b06-observation-runner.ts';
import type { VerifyRtcPerformanceObservationArchiveInput } from './rtc-performance-observation-archive.ts';
import {
    parseRtcPerformanceObservationCommand,
    type RtcPerformanceObservationParsedCommand
} from './rtc-performance-observation-cli-grammar.ts';

export interface RtcPerformanceObservationCliDependencies {
    readonly browserRunner: RtcPerformanceObservationRunner<RtcB05ObservationRunInput>;
    readonly liveRtcRunner: RtcPerformanceObservationRunner<RtcB06ObservationRunInput> & {
        captureBaseline(input: RtcB06BaselineCaptureInput): Promise<RtcBaselineResult<RtcB06BaselineCapture>>;
    };
    readonly readFile: (path: string) => Promise<Uint8Array>;
    readonly verifyArchive: (
        input: VerifyRtcPerformanceObservationArchiveInput
    ) => Promise<RtcBaselineResult<{ observationId: string; }>>;
}

interface RtcPerformanceObservationRunner<RunInput> {
    run(input: RunInput): Promise<
        RtcBaselineResult<{
            observation: { observationId: string; };
            output: RtcB05ObservationOutput | RtcB06ObservationOutput;
        }>
    >;
}

interface RtcPerformanceObservationCommandInput extends Omit<RtcPerformanceObservationCliInput, 'args'> {
    readonly command: RtcPerformanceObservationParsedCommand;
}

interface RtcPerformanceObservationCliInput extends RtcPerformanceObservationCliDependencies {
    readonly args: readonly string[];
    readonly writeStdout: (value: string) => void;
    readonly writeStderr: (value: string) => void;
}

const decoder = new TextDecoder();

export async function runRtcPerformanceObservationCli(
    input: RtcPerformanceObservationCliInput
) {
    const parsed = parseRtcPerformanceObservationCommand(input.args);
    if (!parsed.ok) {
        input.writeStderr(`${JSON.stringify(parsed.issues)}\n`);
        return 64;
    }
    return runRtcPerformanceObservationCommand({ ...input, command: parsed.value });
}

export async function runRtcPerformanceObservationCommand(
    input: RtcPerformanceObservationCommandInput
) {
    if (input.command.kind === 'capture-live-rtc') {
        return captureLiveRtcBaselineCommand(input, input.command);
    }
    if (input.command.kind !== 'verify-observation') {
        return runObservationCommand(input, input.command);
    }
    return verifyObservationCommand(input, input.command);
}

async function captureLiveRtcBaselineCommand(
    input: RtcPerformanceObservationCommandInput,
    command: Extract<RtcPerformanceObservationParsedCommand, { kind: 'capture-live-rtc'; }>
) {
    const { kind: _kind, ...capture } = command;
    const result = await input.liveRtcRunner.captureBaseline(capture);
    if (!result.ok) {
        input.writeStderr(`${JSON.stringify(result.issues)}\n`);
        return 1;
    }
    const { repeatArtifacts: _repeatArtifacts, ...captured } = result.value;
    input.writeStdout(`${JSON.stringify(captured)}\n`);
    return captured.acceptedMetrics && captured.repeatOutcome !== 'failed' && captured.repeatOutcome !== 'incomplete'
        ? 0
        : 1;
}

async function runObservationCommand(
    input: RtcPerformanceObservationCommandInput,
    command: Extract<RtcPerformanceObservationParsedCommand, { kind: 'observe-browser' | 'observe-live-rtc'; }>
) {
    const { kind: _kind, ...runInput } = command;
    const result = command.kind === 'observe-browser'
        ? await input.browserRunner.run(runInput)
        : await input.liveRtcRunner.run(runInput);
    if (!result.ok) {
        input.writeStderr(`${JSON.stringify(result.issues)}\n`);
        return 1;
    }
    input.writeStdout(`${
        JSON.stringify({
            observationId: result.value.observation.observationId,
            archivePath: result.value.output.archivePath,
            indexEntryPath: result.value.output.indexEntryPath
        })
    }\n`);
    return 0;
}

async function verifyObservationCommand(
    input: RtcPerformanceObservationCommandInput,
    command: Extract<RtcPerformanceObservationParsedCommand, { kind: 'verify-observation'; }>
) {
    try {
        const bytes = await input.readFile(command.archivePath);
        const indexEntryBytes = await input.readFile(command.indexEntryPath);
        const indexEntry = decodeIndexEntryLine(indexEntryBytes);
        if (!indexEntry.ok) {
            input.writeStderr(`${JSON.stringify(indexEntry.issues)}\n`);
            return 1;
        }
        const verified = await input.verifyArchive({ bytes, indexEntry: indexEntry.value });
        if (!verified.ok) {
            input.writeStderr(`${JSON.stringify(verified.issues)}\n`);
            return 1;
        }
        input.writeStdout(`${JSON.stringify(verified.value)}\n`);
        return 0;
    }
    catch (error) {
        input.writeStderr(`${
            JSON.stringify([
                {
                    path: '$.verificationInput',
                    code: 'observation-input-read-failed',
                    message: error instanceof Error ? error.message : String(error)
                }
            ])
        }\n`);
        return 1;
    }
}

function decodeIndexEntryLine(bytes: Uint8Array): RtcBaselineResult<RtcBaselineJson> {
    const text = decoder.decode(bytes);
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.length === 1) {
        return {
            ok: false,
            issues: [
                {
                    path: '$.indexEntry',
                    code: 'invalid-index-entry-line',
                    message: 'Index entry input must contain exactly one newline-terminated JSON line.'
                }
            ]
        };
    }
    try {
        return { ok: true, value: JSON.parse(text.slice(0, -1)) as RtcBaselineJson };
    }
    catch {
        return {
            ok: false,
            issues: [
                {
                    path: '$.indexEntry',
                    code: 'invalid-index-entry-json',
                    message: 'Index entry line must contain valid JSON.'
                }
            ]
        };
    }
}
