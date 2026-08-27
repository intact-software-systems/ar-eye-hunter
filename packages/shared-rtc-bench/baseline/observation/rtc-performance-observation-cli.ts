import type { RtcBaselineJson, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type {
    RtcB05ObservationOutput,
    RtcB05ObservationRunInput
} from './rtc-b05-observation-runner.ts';
import type { VerifyRtcPerformanceObservationArchiveInput } from './rtc-performance-observation-archive.ts';
import { parseRtcPerformanceObservationCommand } from './rtc-performance-observation-cli-grammar.ts';

export interface RtcPerformanceObservationCliDependencies {
    readonly runner: {
        run(input: RtcB05ObservationRunInput): Promise<
            RtcBaselineResult<{
                observation: { observationId: string; };
                output: RtcB05ObservationOutput;
            }>
        >;
    };
    readonly readFile: (path: string) => Promise<Uint8Array>;
    readonly verifyArchive: (
        input: VerifyRtcPerformanceObservationArchiveInput
    ) => Promise<RtcBaselineResult<{ observationId: string; }>>;
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
    if (parsed.value.kind === 'observe-browser') {
        const { kind: _kind, ...runInput } = parsed.value;
        const result = await input.runner.run(runInput);
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
    try {
        const bytes = await input.readFile(parsed.value.archivePath);
        const indexEntryBytes = await input.readFile(parsed.value.indexEntryPath);
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
