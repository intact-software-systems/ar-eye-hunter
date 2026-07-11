export type CommandCenterActionFeedback = Readonly<{
    state: 'idle' | 'running' | 'success' | 'error';
    label?: string;
    target?: string;
    status?: string | number;
    statusText?: string;
    durationMs?: number;
    message?: string;
    atEpochMs?: number;
}>;

export function idleActionFeedback(
    message: string,
): CommandCenterActionFeedback {
    return {
        state: 'idle',
        message,
    };
}

export function runningActionFeedback(
    label: string,
    target?: string,
    message = 'Action is running.',
): CommandCenterActionFeedback {
    return {
        state: 'running',
        label,
        target,
        message,
        atEpochMs: Date.now(),
    };
}

export function completedActionFeedback(
    input: Readonly<{
        label: string;
        startedAtEpochMs: number;
        target?: string;
        ok: boolean;
        status?: string | number;
        statusText?: string;
        durationMs?: number;
        message?: string;
    }>,
): CommandCenterActionFeedback {
    return {
        state: input.ok ? 'success' : 'error',
        label: input.label,
        target: input.target,
        status: input.status,
        statusText: input.statusText,
        durationMs:
            input.durationMs ??
            Math.max(0, Date.now() - input.startedAtEpochMs),
        message: input.message,
        atEpochMs: Date.now(),
    };
}
