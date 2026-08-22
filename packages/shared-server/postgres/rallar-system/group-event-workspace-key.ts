const ABSENT_GROUP_EVENT_WORKSPACE_KEY = '_';

export function groupEventWorkspaceKey(
    workspaceId: string | undefined
): string {
    if (workspaceId === undefined) {
        return ABSENT_GROUP_EVENT_WORKSPACE_KEY;
    }
    return workspaceId === '_' ? '%5F' : encodeURIComponent(workspaceId);
}
