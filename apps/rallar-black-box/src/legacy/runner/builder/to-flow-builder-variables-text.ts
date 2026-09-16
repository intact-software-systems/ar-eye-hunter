import type { FlowBuilderDefinition } from '../../../flow-builder/flow-builder-contracts.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export function toFlowBuilderVariablesText(
    variables: FlowBuilderDefinition['variables'],
    globalValues: CommandCenterGlobalValues | undefined
): string {
    const merged = globalValues
        ? {
            ...variables,
            apiBaseUrl: globalValues.apiBaseUrl,
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            groupId: globalValues.roomId,
            actor: globalValues.clientId,
            sessionId: globalValues.sessionId,
            username: globalValues.clientId
        }
        : variables;
    return JSON.stringify(merged, null, 2);
}
