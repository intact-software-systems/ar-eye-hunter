import type { RallarServerRestResponse } from '../../../rallar-server-workbench.ts';

export type CommandCenterRestActionLog = Readonly<{
    actionId: string;
    label: string;
    atEpochMs: number;
    ok: boolean;
    status: number;
    statusText: string;
    durationMs: number;
    errorKind?: string;
    bodyJson?: unknown;
}>;

export function restLogEntry(
    label: string,
    response: RallarServerRestResponse
): CommandCenterRestActionLog {
    return {
        actionId: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
        label,
        atEpochMs: Date.now(),
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        errorKind: response.error?.kind,
        bodyJson: response.bodyJson
    };
}
