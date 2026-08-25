import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';

export function defaultStateScope(): StateScope {
    return {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID
    };
}

export function toStateScopeHttpPath(scope: StateScope): string {
    const applicationId = encodeURIComponent(scope.applicationId);
    const workspaceId = encodeURIComponent(scope.workspaceId);
    return `/api/state/apps/${applicationId}/workspaces/${workspaceId}`;
}

export function toStateGroupHttpPath(scope: StateScope, groupId: string): string {
    return `${toStateScopeHttpPath(scope)}/groups/${encodeURIComponent(groupId)}`;
}
