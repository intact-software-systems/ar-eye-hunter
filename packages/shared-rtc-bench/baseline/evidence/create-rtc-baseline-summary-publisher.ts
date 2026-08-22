import { rtcBaselineIssue, type RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import type { RtcBaselineConfinedPath } from './rtc-baseline-confined-path.ts';
import type { RtcBaselineFilePort } from './rtc-baseline-file-port.ts';

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
    left.length === right.length && left.every((byte, index) => byte === right[index]);

function failure(code: string, message: string): RtcBaselineResult<never> {
    return { ok: false, issues: [rtcBaselineIssue('$.summary', code, message)] };
}

type RtcBaselineSummaryPublisher = (
    baselineId: string,
    summaryBytes: Uint8Array,
    checksumBytes: Uint8Array
) => Promise<RtcBaselineResult<void>>;

export function createRtcBaselineSummaryPublisher(input: {
    readonly confinedPath: RtcBaselineConfinedPath;
    readonly filePort: RtcBaselineFilePort;
}): RtcBaselineSummaryPublisher {
    const { confinedPath, filePort } = input;

    return async function publishSummary (
        baselineId: string,
        summaryBytes: Uint8Array,
        checksumBytes: Uint8Array
    ): Promise<RtcBaselineResult<void>> {
        const summary = await confinedPath.inspect(baselineId, 'summary.json');
        if (!summary.ok) {
            return summary;
        }
        const checksum = await confinedPath.inspect(baselineId, 'SHA256SUMS');
        if (!checksum.ok) {
            return checksum;
        }
        try {
            const summaryEntry = await filePort.inspectPath(summary.value);
            const checksumEntry = await filePort.inspectPath(checksum.value);
            if (summaryEntry?.kind === 'file' && checksumEntry?.kind === 'file') {
                const existingSummary = await filePort.readFile(summary.value);
                const existingChecksum = await filePort.readFile(checksum.value);
                if (
                    sameBytes(existingSummary, summaryBytes) &&
                    sameBytes(existingChecksum, checksumBytes)
                ) {
                    return { ok: true, value: undefined };
                }
                return failure(
                    'finalization-conflict',
                    'Finalized summary and checksum already exist with different bytes.'
                );
            }
            if (summaryEntry?.kind === 'file' && checksumEntry === null) {
                await filePort.removeFile(summary.value);
            }
            if (summaryEntry === null && checksumEntry?.kind === 'file') {
                await filePort.removeFile(checksum.value);
            }
            await filePort.writeFileCreateNew(summary.value, summaryBytes);
            await filePort.writeFileCreateNew(checksum.value, checksumBytes);
            return { ok: true, value: undefined };
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            try {
                if ((await filePort.inspectPath(summary.value))?.kind === 'file') {
                    await filePort.removeFile(summary.value);
                }
            }
            catch {
                // Retry removes an orphaned summary before its next create-new write.
            }
            return failure('write-failed', cause.message);
        }
    };
}
