export function groupStateEventWorkspaceKey(workspaceId: string): string {
    if (workspaceId.length === 0) {
        throw new TypeError('Group event workspaceId must be a nonempty string');
    }
    return encodeURIComponent(workspaceId);
}
