import type { AdminSupportNarrativeResponse } from '@shared/api/admin-support/admin-support-types.ts';

export interface AdminSupportNarrativeBase {
    readonly generatedAtEpochMs: number;
    readonly serverId?: string;
}

export function adminSupportNarrativeBase(
    base: AdminSupportNarrativeBase,
    target: AdminSupportNarrativeResponse['target']
) {
    return {
        generatedAtEpochMs: base.generatedAtEpochMs,
        serverId: base.serverId,
        target
    };
}
