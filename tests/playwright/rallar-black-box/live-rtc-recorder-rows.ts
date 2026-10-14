import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { jsonRecord, normalizeJson, type LiveRtcJsonRecord } from './live-rtc-evidence-json.ts';

export const LIVE_RTC_LIFECYCLE_LIMITS = Object.freeze({
    inputBytes: 8_388_608,
    transportBytes: 67_108_864,
    transportTimeoutMs: 30_000,
    scannedRows: 20_000,
    rowBytes: 16_384,
    retainedRows: 600,
    eventOutputBytes: 262_144,
    identityCharacters: 256
});

export interface LiveRtcRecorderScanInput {
    readonly jsonl: string | null;
    readonly retainedPrefixDropped: boolean;
    readonly transportTruncated: boolean;
}

export interface LiveRtcRecorderScanWindow {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly firstStreamRow: number;
    readonly rowLimitReached: boolean;
}

export interface LiveRtcRecorderLine {
    readonly line: string;
    readonly streamRow: number;
}

export function* toLiveRtcRecorderLines(input: LiveRtcRecorderScanInput): Generator<LiveRtcRecorderLine> {
    const jsonl = input.jsonl ?? '';
    const window = computeLiveRtcRecorderScanWindow(input);
    let streamRow = window.firstStreamRow;
    for (let cursor = window.startedAt; cursor < window.endedAt;) {
        const delimiter = jsonl.indexOf('\n', cursor);
        const endedAt = delimiter < 0 ? window.endedAt : Math.min(delimiter, window.endedAt);
        const line = jsonl.slice(cursor, endedAt);
        cursor = endedAt + 1;
        const row = streamRow++;
        if (line.trim().length > 0) {
            yield { line, streamRow: row };
        }
    }
}

export function computeLiveRtcRecorderScanWindow(input: LiveRtcRecorderScanInput): LiveRtcRecorderScanWindow {
    const jsonl = input.jsonl ?? '';
    const firstDelimiter = jsonl.indexOf('\n');
    const startedAt = input.retainedPrefixDropped ? firstDelimiter < 0 ? jsonl.length : firstDelimiter + 1 : 0;
    const endedAt = input.transportTruncated ? jsonl.lastIndexOf('\n') + 1 : jsonl.length;
    let selectedAt = startedAt;
    let rows = 0;
    for (let cursor = endedAt; cursor > startedAt;) {
        const lineStart = Math.max(startedAt, jsonl.lastIndexOf('\n', cursor - 1) + 1);
        const line = jsonl.slice(lineStart, cursor);
        if (line.trim().length > 0) {
            rows += 1;
            if (rows > LIVE_RTC_LIFECYCLE_LIMITS.scannedRows) {
                selectedAt = cursor + 1;
                break;
            }
        }
        cursor = lineStart - 1;
    }
    let firstStreamRow = 1;
    for (let index = 0; index < selectedAt; index += 1) {
        if (jsonl.charCodeAt(index) === 10) {
            firstStreamRow += 1;
        }
    }
    return {
        startedAt: selectedAt,
        endedAt,
        firstStreamRow,
        rowLimitReached: rows > LIVE_RTC_LIFECYCLE_LIMITS.scannedRows
    };
}

export function toLiveRtcRecorderRow(line: string): LiveRtcJsonRecord | null {
    try {
        const decoded = JSON.parse(
            line,
            (_key: string, value: RtcBaselineJson) =>
                typeof value === 'number' && !Number.isFinite(value) ? null : value
        );
        return jsonRecord(normalizeJson(decoded));
    }
    catch {
        return null;
    }
}
