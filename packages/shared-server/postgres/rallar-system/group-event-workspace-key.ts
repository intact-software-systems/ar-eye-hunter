export function groupEventWorkspaceKey(
    workspaceId: string
): string {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
        throw new TypeError('Group event workspaceId must be a nonempty string');
    }
    return encodeURIComponent(workspaceId);
}
