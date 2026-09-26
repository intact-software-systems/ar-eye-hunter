import { Either } from '../../../../shared/resilience/Either.ts';
import type { RallarBlackBoxTestRecord } from '../../rallar-black-box-test-contracts.ts';
import { isAlmConformanceRole, type AlmConformanceRole } from './alm-conformance-roles.ts';

export type ALMObservationPageDiagnosticKind = 'pageerror' | 'console-error' | 'console-warning';

/** One page-level error or console line the lane captured directly from an agent's Playwright page. */
export interface ALMObservationPageDiagnosticRecord {
    readonly agentId: string;
    /**
     * The lane sets this at capture time (`tests/playwright/rallar-black-box/start-page-diagnostics-capture.ts`),
     * never guessed from an agent id the way `ALMObservationAgentRole` is.
     */
    readonly role: AlmConformanceRole;
    readonly atMs: number;
    readonly kind: ALMObservationPageDiagnosticKind;
    readonly message: string;
    readonly stack?: string;
}

export interface ALMObservationPageDiagnosticsFile {
    readonly records: readonly ALMObservationPageDiagnosticRecord[];
    readonly droppedCount: number;
}

const PAGE_DIAGNOSTIC_KINDS: readonly ALMObservationPageDiagnosticKind[] = [
    'pageerror',
    'console-error',
    'console-warning'
];

/**
 * Rejects only a value that carries no usable page-diagnostics file at all. A record missing a
 * required field is skipped rather than reported, matching `decodeALMObservationSnapshot`'s rule for
 * the events it does not read: the lane's own capture caps at 200 records per page, so a malformed
 * one is not expected, but a future lane version should still decode.
 */
export function decodeALMObservationPageDiagnosticsFile(
    value: unknown
): Either<readonly string[], ALMObservationPageDiagnosticsFile> {
    if (!isRecord(value)) {
        return Either.ofLeft(['page diagnostics file is not an object']);
    }
    const droppedCount = decodeFiniteNumber(value.droppedCount);
    const rawRecords = decodeRecordArray(value.records);
    if (droppedCount === undefined || rawRecords === undefined) {
        return Either.ofLeft([
            ...(droppedCount === undefined ? ['page diagnostics file.droppedCount is not a finite number'] : []),
            ...(rawRecords === undefined ? ['page diagnostics file.records is not an array'] : [])
        ]);
    }
    return Either.ofRight({
        records: rawRecords.map(toPageDiagnosticRecord).filter(isPresent),
        droppedCount
    });
}

function toPageDiagnosticRecord(
    entry: RallarBlackBoxTestRecord
): ALMObservationPageDiagnosticRecord | undefined {
    const agentId = decodeText(entry.agentId);
    const role = decodeText(entry.role);
    const atMs = decodeFiniteNumber(entry.atMs);
    const kind = decodeText(entry.kind);
    const message = decodeMessage(entry.message);
    const stack = decodeText(entry.stack);
    if (
        agentId === undefined || role === undefined || !isAlmConformanceRole(role) || atMs === undefined ||
        !isPageDiagnosticKind(kind) || message === undefined
    ) {
        return undefined;
    }
    return { agentId, role, atMs, kind, message, ...(stack === undefined ? {} : { stack }) };
}

function isPageDiagnosticKind(value: string | undefined): value is ALMObservationPageDiagnosticKind {
    return value !== undefined && (PAGE_DIAGNOSTIC_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent<TValue>(value: TValue | undefined): value is TValue {
    return value !== undefined;
}

function decodeRecordArray(value: unknown): readonly RallarBlackBoxTestRecord[] | undefined {
    return Array.isArray(value)
        ? value.map((entry) => isRecord(entry) ? entry : undefined).filter(isPresent)
        : undefined;
}

function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Unlike `decodeText`, an empty console message is a real (if unlikely) record, not a missing field. */
function decodeMessage(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function decodeFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
