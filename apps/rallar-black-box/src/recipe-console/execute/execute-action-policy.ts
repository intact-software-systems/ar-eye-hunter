import {
    isDistributedRunTerminalState,
    type RallarBlackBoxDistributedRunState,
} from '@shared-test/rallar-bb-test/distributed-run.ts';

export type ExecuteAction =
    | 'resolve'
    | 'create'
    | 'stage'
    | 'start'
    | 'cancel'
    | 'refresh'
    | 'export';

export type ExecuteConnectionTruth =
    | 'connecting'
    | 'live'
    | 'partial'
    | 'stale'
    | 'offline'
    | 'error'
    | 'credential-trust'
    | 'auth-required';

export type ExecuteActionBlockCode =
    | 'busy'
    | 'connection'
    | 'recipe-unavailable'
    | 'schema-invalid'
    | 'preflight-blocked'
    | 'targets-unsafe'
    | 'manifest-invalid'
    | 'resolution-required'
    | 'run-unavailable'
    | 'run-state'
    | 'terminal-run';

export type ExecuteActionDecision =
    | Readonly<{ enabled: true; code?: never; reason?: never }>
    | Readonly<{
        enabled: false;
        code: ExecuteActionBlockCode;
        reason: string;
    }>;

export type ExecuteActionPolicy = Readonly<
    Record<ExecuteAction, ExecuteActionDecision>
>;

export type ExecuteActionPolicyInput = Readonly<{
    connection: ExecuteConnectionTruth;
    runState?: RallarBlackBoxDistributedRunState;
    hasKnownRun: boolean;
    unknownDistributedRunId: boolean;
    recipeAvailable: boolean;
    schemaValid: boolean;
    preflightValid: boolean;
    selectedTargetsSafe: boolean;
    manifestValid: boolean;
    resolutionCurrent: boolean;
    busyAction?: ExecuteAction;
}>;

export function deriveExecuteActionPolicy(
    input: ExecuteActionPolicyInput,
): ExecuteActionPolicy {
    if (input.busyAction) {
        return allBlocked(
            'busy',
            `${title(input.busyAction)} is already in progress.`,
        );
    }

    const policy: Record<ExecuteAction, ExecuteActionDecision> = {
        resolve: blocked('connection', 'Live or partial control truth is required.'),
        create: blocked('connection', 'Complete live control truth is required.'),
        stage: blocked('connection', 'Complete live control truth is required.'),
        start: blocked('connection', 'Complete live control truth is required.'),
        cancel: blocked('connection', 'Complete live control truth is required.'),
        refresh: enabled(),
        export: blocked('run-unavailable', 'Select a known distributed run to export.'),
    };

    if (
        input.connection === 'connecting' ||
        input.connection === 'offline' ||
        input.connection === 'error' ||
        input.connection === 'credential-trust' ||
        input.connection === 'auth-required'
    ) {
        return policy;
    }
    if (input.hasKnownRun) {
        policy.export = enabled();
    }
    if (input.connection === 'stale') return policy;

    const safe = guidedSafety(input);
    policy.resolve = safe ?? enabled();
    if (input.connection === 'partial') return policy;

    policy.create = createDecision(input, safe);
    policy.stage = stageDecision(input, safe);
    policy.start = startDecision(input, safe);
    policy.cancel = cancelDecision(input);
    return policy;
}

function createDecision(
    input: ExecuteActionPolicyInput,
    safe: ExecuteActionDecision | undefined,
): ExecuteActionDecision {
    if (input.unknownDistributedRunId) {
        return blocked(
            'run-unavailable',
            'The explicit distributed run ID is unavailable; clear or restore it before Create.',
        );
    }
    if (input.hasKnownRun || input.runState !== undefined) {
        return blocked('run-state', 'Create requires a new run without existing run truth.');
    }
    if (safe) return safe;
    if (!input.resolutionCurrent) {
        return blocked('resolution-required', 'Resolve the current manifest and safe targets first.');
    }
    return enabled();
}

function stageDecision(
    input: ExecuteActionPolicyInput,
    safe: ExecuteActionDecision | undefined,
): ExecuteActionDecision {
    if (!input.hasKnownRun || input.runState !== 'draft') {
        return blocked('run-state', 'Stage requires an authoritative draft run.');
    }
    if (safe) return safe;
    if (!input.resolutionCurrent) {
        return blocked('resolution-required', 'Resolve the current manifest and safe targets first.');
    }
    return enabled();
}

function startDecision(
    input: ExecuteActionPolicyInput,
    safe: ExecuteActionDecision | undefined,
): ExecuteActionDecision {
    if (!input.hasKnownRun || input.runState !== 'ready') {
        return blocked('run-state', 'Start requires authoritative ready state.');
    }
    if (safe) return safe;
    return enabled();
}

function cancelDecision(input: ExecuteActionPolicyInput): ExecuteActionDecision {
    if (!input.hasKnownRun || !input.runState) {
        return blocked('run-unavailable', 'Select a known non-terminal run to cancel.');
    }
    if (isDistributedRunTerminalState(input.runState)) {
        return blocked('terminal-run', `Run state ${input.runState} is already terminal.`);
    }
    return enabled();
}

function guidedSafety(
    input: ExecuteActionPolicyInput,
): ExecuteActionDecision | undefined {
    if (!input.recipeAvailable) {
        return blocked('recipe-unavailable', 'Select an available repository recipe.');
    }
    if (!input.schemaValid) {
        return blocked('schema-invalid', 'The selected recipe schema is invalid.');
    }
    if (!input.preflightValid) {
        return blocked('preflight-blocked', 'Resolve recipe preflight errors first.');
    }
    if (!input.selectedTargetsSafe) {
        return blocked('targets-unsafe', 'Select at least one current-safe target.');
    }
    if (!input.manifestValid) {
        return blocked('manifest-invalid', 'The generated distributed manifest is invalid.');
    }
    return undefined;
}

function allBlocked(
    code: ExecuteActionBlockCode,
    reason: string,
): ExecuteActionPolicy {
    return Object.fromEntries([
        'resolve',
        'create',
        'stage',
        'start',
        'cancel',
        'refresh',
        'export',
    ].map((action) => [action, blocked(code, reason)])) as ExecuteActionPolicy;
}

function enabled(): ExecuteActionDecision {
    return { enabled: true };
}

function blocked(
    code: ExecuteActionBlockCode,
    reason: string,
): ExecuteActionDecision {
    return { enabled: false, code, reason };
}

function title(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
