import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { RallarServerWorkbenchVariables } from './rallar-server-workbench-contracts.ts';

export interface RallarServerWorkbenchVariablesInput {
    /** What the operator context already knows; an absent or empty hint takes the workbench default. */
    readonly hints: Partial<RallarServerWorkbenchVariables>;
    createOpaqueId(): string;
}

export function toRallarServerWorkbenchVariables(
    { hints, createOpaqueId }: RallarServerWorkbenchVariablesInput
): RallarServerWorkbenchVariables {
    const principalId = hints.principalId || 'alice';
    const sessionId = hints.sessionId || 'visible-session-alice';
    return {
        applicationId: hints.applicationId || DEFAULT_STATE_APPLICATION_ID,
        workspaceId: hints.workspaceId || DEFAULT_STATE_WORKSPACE_ID,
        principalId,
        sessionId,
        generationId: hints.generationId || createOpaqueId(),
        requestId: hints.requestId || createOpaqueId(),
        clientInstanceId: hints.clientInstanceId || `${sessionId}-browser`,
        groupId: hints.groupId || 'rallar-black-box-room',
        username: hints.username || principalId
    };
}
