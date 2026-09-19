import type { RallarServerRestResponse } from '../../../rallar-server-workbench/rallar-server-workbench-contracts.ts';

export interface CommandCenterRestActionLog {
    readonly actionId: string;
    readonly label: string;
    readonly atEpochMs: number;
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly durationMs: number;
    /** Absent for an action that completed without a classified failure. */
    readonly errorKind?: string;
    /** Absent for an action without a JSON result. */
    readonly bodyJson?: unknown;
}

export function toRestActionLogEntry(
    label: string,
    response: RallarServerRestResponse,
    atEpochMs: number
): CommandCenterRestActionLog {
    return {
        actionId: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${atEpochMs}`,
        label,
        atEpochMs,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        errorKind: response.error?.kind,
        bodyJson: response.bodyJson
    };
}
