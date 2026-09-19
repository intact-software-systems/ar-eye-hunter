import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

export interface FleetDiagnostic {
    readonly severity: string;
    readonly message: string;
    readonly diagnosticTypeId: string;
    readonly transport: string | undefined;
}

const NO_FIELDS: Readonly<Record<string, never>> = {};

export function decodeFleetDiagnostic(payload: unknown): FleetDiagnostic | undefined {
    const record = isJsonRecordValue(payload) ? payload : NO_FIELDS;
    const inner = isJsonRecordValue(record.payload) ? record.payload : NO_FIELDS;
    const detailFields = isJsonRecordValue(record.data) ? record.data : NO_FIELDS;
    const severity = decodeText(record.severity) ?? decodeText(inner.severity) ?? decodeText(detailFields.severity);
    const topic = decodeText(record.diagnosticTypeId) ?? decodeText(inner.diagnosticTypeId) ??
        decodeText(detailFields.diagnosticTypeId) ?? decodeText(record.topic) ?? decodeText(inner.topic);
    if (!severity && !topic) {
        return undefined;
    }
    return {
        severity: severity ?? 'info',
        message: decodeText(record.message) ?? decodeText(inner.message) ?? decodeText(detailFields.message) ??
            decodeText(record.reason) ?? decodeText(inner.reason) ?? topic ?? 'diagnostic',
        diagnosticTypeId: topic ?? 'runtime.diagnostic',
        transport: decodeText(record.transport) ?? decodeText(inner.transport) ?? decodeText(detailFields.transport)
    };
}

export function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isFleetLinkedEvent(
    distributedRun: ControlDistributedRunSnapshot,
    event: ControlEventEnvelope
): boolean {
    const linkedCommandIds = new Set(distributedRun.commandLinks.map((link) => link.commandId));
    return (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
        toSearchableJson(event.payload).includes(distributedRun.distributedRunId);
}

export function toResultDurationMs(result: ControlResultEnvelope): number | undefined {
    const commandResult = result.result;
    if (typeof commandResult?.durationMs === 'number') {
        return commandResult.durationMs;
    }
    if (typeof commandResult?.startedAtEpochMs === 'number' && typeof commandResult.endedAtEpochMs === 'number') {
        return Math.max(0, commandResult.endedAtEpochMs - commandResult.startedAtEpochMs);
    }
    return undefined;
}

function toSearchableJson(payload: ControlEventEnvelope['payload']): string {
    try {
        return JSON.stringify(payload);
    }
    catch (_error) {
        return '';
    }
}
