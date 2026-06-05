export type RecipeRunMode = 'local-browser' | 'connected-agents';

export type RecipeLaunchState =
    | 'idle'
    | 'preparing'
    | 'running'
    | 'passed'
    | 'failed';

export type RunnerReadinessCheckId =
    | 'api'
    | 'auth'
    | 'group'
    | 'control'
    | 'run'
    | 'agents'
    | 'recipe-prerequisites';

export type RunnerReadinessCheckStatus =
    | 'ready'
    | 'warning'
    | 'blocked'
    | 'checking';

export type RunnerReadinessCheck = Readonly<{
    id: RunnerReadinessCheckId;
    label: string;
    status: RunnerReadinessCheckStatus;
    message: string;
    action?: string;
}>;

export type RunnerReadinessStatus = Readonly<{
    checks: readonly RunnerReadinessCheck[];
    localBlockers: readonly string[];
    distributedBlockers: readonly string[];
    canRunLocal: boolean;
    canRunDistributed: boolean;
    primaryMessage: string;
}>;

export type RunnerServiceProbeStatus = 'checking' | 'online' | 'offline';

export type RunnerReadinessInput = Readonly<{
    apiStatus: RunnerServiceProbeStatus;
    apiRequired?: boolean;
    authenticated: boolean;
    authRequired?: boolean;
    groupId: string;
    controlStatus: RunnerServiceProbeStatus;
    controlRunId: string;
    connectedAgentCount: number;
    targetableAgentCount: number;
    recipePrerequisiteIssues?: readonly string[];
}>;

export function runnerReadinessStatus(
    input: RunnerReadinessInput,
): RunnerReadinessStatus {
    const recipeIssues = input.recipePrerequisiteIssues ?? [];
    const apiRequired = input.apiRequired ?? true;
    const authRequired = input.authRequired ?? true;
    const checks: RunnerReadinessCheck[] = [
        serviceCheck({
            id: 'api',
            label: 'API',
            status: input.apiStatus,
            required: apiRequired,
            offlineMessage: 'API is offline',
            onlineMessage: 'API reachable',
            checkingMessage: 'Checking API',
            action: 'Start API-v1 or update the API base URL.',
        }),
        {
            id: 'auth',
            label: 'Auth',
            status: input.authenticated
                ? 'ready'
                : authRequired
                  ? 'blocked'
                  : 'warning',
            message: input.authenticated
                ? 'Logged in'
                : authRequired
                  ? 'Login required'
                  : 'Login not needed for this local recipe',
            action: input.authenticated
                ? undefined
                : authRequired
                  ? 'Open Auth and sign in before live browser recipes.'
                  : undefined,
        },
        {
            id: 'group',
            label: 'Group',
            status: input.groupId.trim().length > 0 ? 'ready' : 'blocked',
            message:
                input.groupId.trim().length > 0
                    ? input.groupId
                    : 'Current group missing',
            action:
                input.groupId.trim().length > 0
                    ? undefined
                    : 'Set a group in Global Context.',
        },
        serviceCheck({
            id: 'control',
            label: 'Control',
            status: input.controlStatus,
            offlineMessage: 'Control server offline',
            onlineMessage: 'Control server reachable',
            checkingMessage: 'Checking control server',
            action: 'Start rallar-black-box-control-server.',
        }),
        {
            id: 'run',
            label: 'Control run',
            status: input.controlRunId.trim().length > 0 ? 'ready' : 'blocked',
            message:
                input.controlRunId.trim().length > 0
                    ? input.controlRunId
                    : 'Control run missing',
            action:
                input.controlRunId.trim().length > 0
                    ? undefined
                    : 'Start or select a control run.',
        },
        {
            id: 'agents',
            label: 'Agents',
            status:
                input.targetableAgentCount > 0
                    ? 'ready'
                    : input.connectedAgentCount > 0
                      ? 'warning'
                      : 'blocked',
            message:
                input.targetableAgentCount > 0
                    ? `${input.targetableAgentCount} targetable`
                    : input.connectedAgentCount > 0
                      ? 'No agents match this group'
                      : 'No agents connected',
            action:
                input.targetableAgentCount > 0
                    ? undefined
                    : 'Open another browser as a control agent in the same group.',
        },
        {
            id: 'recipe-prerequisites',
            label: 'Recipe',
            status: recipeIssues.length > 0 ? 'blocked' : 'ready',
            message:
                recipeIssues.length > 0
                    ? recipeIssues[0]
                    : 'Recipe prerequisites clear',
            action:
                recipeIssues.length > 0
                    ? 'Choose a compatible recipe or fix the prerequisite.'
                    : undefined,
        },
    ];

    const localBlockedIds: readonly RunnerReadinessCheckId[] = [
        'api',
        'auth',
        'group',
        'recipe-prerequisites',
    ];
    const distributedBlockedIds: readonly RunnerReadinessCheckId[] = [
        ...localBlockedIds,
        'control',
        'run',
        'agents',
    ];
    const localBlockers = blockerMessages(checks, localBlockedIds);
    const distributedBlockers = blockerMessages(checks, distributedBlockedIds);
    const firstLocalBlocker = localBlockers[0];
    const firstDistributedBlocker = distributedBlockers[0];

    return {
        checks,
        localBlockers,
        distributedBlockers,
        canRunLocal: localBlockers.length === 0,
        canRunDistributed: distributedBlockers.length === 0,
        primaryMessage: firstLocalBlocker
            ? firstLocalBlocker
            : firstDistributedBlocker
              ? `Ready to run in this browser. Distributed: ${firstDistributedBlocker}`
              : 'Ready to run recipes.',
    };
}

export function runnerDisabledReason(
    readiness: RunnerReadinessStatus,
    mode: RecipeRunMode,
): string | undefined {
    const blockers =
        mode === 'local-browser'
            ? readiness.localBlockers
            : readiness.distributedBlockers;
    return blockers[0];
}

export function runnerFriendlyErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('Load failed')
    ) {
        return 'Service is offline or blocked by CORS. Check the API/control URLs and restart the missing server.';
    }
    if (message.includes('ECONNREFUSED')) {
        return 'Service connection was refused. Start the missing local server and retry.';
    }
    if (message.includes('401')) {
        return 'Authentication failed. Log in again and retry the recipe.';
    }
    if (message.includes('403')) {
        return 'The current user is not allowed to run this action.';
    }
    if (message.includes('No agents connected')) {
        return 'No agents connected. Open another browser as a control agent in this run.';
    }
    return message;
}

function serviceCheck(input: Readonly<{
    id: Extract<RunnerReadinessCheckId, 'api' | 'control'>;
    label: string;
    status: RunnerServiceProbeStatus;
    required?: boolean;
    offlineMessage: string;
    onlineMessage: string;
    checkingMessage: string;
    action: string;
}>): RunnerReadinessCheck {
    if (input.status === 'online') {
        return {
            id: input.id,
            label: input.label,
            status: 'ready',
            message: input.onlineMessage,
        };
    }
    if (input.status === 'checking') {
        return {
            id: input.id,
            label: input.label,
            status: input.required === false ? 'warning' : 'checking',
            message: input.checkingMessage,
        };
    }
    return {
        id: input.id,
        label: input.label,
        status: input.required === false ? 'warning' : 'blocked',
        message: input.offlineMessage,
        action: input.required === false ? undefined : input.action,
    };
}

function blockerMessages(
    checks: readonly RunnerReadinessCheck[],
    ids: readonly RunnerReadinessCheckId[],
): readonly string[] {
    const blockedIds = new Set(ids);
    return checks
        .filter(
            (check) =>
                blockedIds.has(check.id) &&
                (check.status === 'blocked' || check.status === 'checking'),
        )
        .map((check) => check.message);
}
