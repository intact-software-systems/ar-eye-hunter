import type { FlowBuilderDefinition } from '../../../flow-builder/flow-builder-contracts.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export function toFlowBuilderVariablesText(
    variables: FlowBuilderDefinition['variables'],
    globalValues: CommandCenterGlobalValues
): string {
    const merged = {
        ...variables,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        groupId: globalValues.roomId,
        actor: globalValues.clientId,
        sessionId: globalValues.sessionId,
        username: globalValues.clientId
    };
    return JSON.stringify(merged, null, 2);
}
