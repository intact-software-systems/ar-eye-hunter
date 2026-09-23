import type {
    PageDiagnosticCaptureRecord,
    PageDiagnosticKind,
    PageDiagnosticsCapture
} from './start-page-diagnostics-capture.ts';

export interface PageDiagnosticsFileRecord {
    readonly agentId: string;
    readonly role: 'sender' | 'receiver';
    readonly atMs: number;
    readonly kind: PageDiagnosticKind;
    readonly message: string;
    readonly stack?: string;
}

export interface PageDiagnosticsFile {
    readonly records: readonly PageDiagnosticsFileRecord[];
    readonly droppedCount: number;
}

/**
 * `referenceEpochMs` is the cell's own reference instant, chosen by the caller: the run's first
 * control event when the snapshot decoded, else the earliest page's own creation.
 */
export function toPageDiagnosticsFile(
    captures: readonly PageDiagnosticsCapture[],
    referenceEpochMs: number
): PageDiagnosticsFile {
    const records = captures
        .flatMap((capture) => capture.records())
        .sort((left, right) => left.atEpochMs - right.atEpochMs)
        .map((record) => toPageDiagnosticsFileRecord(record, referenceEpochMs));
    return {
        records,
        droppedCount: captures.reduce((total, capture) => total + capture.droppedCount(), 0)
    };
}

function toPageDiagnosticsFileRecord(
    record: PageDiagnosticCaptureRecord,
    referenceEpochMs: number
): PageDiagnosticsFileRecord {
    return {
        agentId: record.agentId,
        role: record.role,
        atMs: record.atEpochMs - referenceEpochMs,
        kind: record.kind,
        message: record.message,
        ...(record.stack === undefined ? {} : { stack: record.stack })
    };
}
