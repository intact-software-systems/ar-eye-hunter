import type { AdminOperationBaseResponse, AdminOperationWarning } from '@shared/api/admin-operations-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export interface CreateAdminOperationBaseResponseInput {
    readonly nowEpochMs: () => number;
    readonly serverId?: string;
    readonly scope?: StateScope;
    readonly warnings?: readonly AdminOperationWarning[];
}

export function createAdminOperationBaseResponse(
    input: CreateAdminOperationBaseResponseInput
): AdminOperationBaseResponse {
    return {
        generatedAtEpochMs: input.nowEpochMs(),
        serverId: input.serverId,
        scope: input.scope,
        warnings: input.warnings ?? []
    };
}
