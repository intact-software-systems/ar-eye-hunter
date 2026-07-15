import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';

export function executeAgentLaunchBlocker(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    runId: string;
    prefix: string;
    count: number;
}>): string | undefined {
    if (!input.runId.trim()) return 'Enter a control run ID before launching agents.';
    if (!input.prefix.trim()) return 'Enter an agent ID prefix before launching agents.';
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 6) {
        return 'Agent count must be an integer from 1 to 6.';
    }
    if (input.connection.query.authorization === 'required') {
        return 'Control authorization is required before launching browser agents.';
    }
    if (input.connection.query.lastError?.credentialTrustRequired) {
        return 'Trust the selected control origin before launching browser agents.';
    }
    if (!['live', 'partial'].includes(input.connection.query.status)) {
        return 'A current control connection is required before launching browser agents.';
    }
    const group = input.connection.bootstrap.bootstrapGroup;
    if (!group.applicationId || !group.workspaceId || !group.groupId) {
        return 'Application, workspace, and group are required before launching agents.';
    }
    if (!input.connection.browserAgentLaunch) {
        return input.connection.browserAgentLaunchIssue ??
            'Control authorization is unavailable for browser-agent launch.';
    }
    return undefined;
}
