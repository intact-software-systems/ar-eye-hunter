import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntimeStatus,
} from '@shared-test/rallar-bb-test/types.ts';

export function commandId(command: RallarBlackBoxTestCommand, index: number): string {
    return command.commandId ?? `${command.kind}-${index + 1}`;
}

export function statusTone(status: RallarBlackBoxTestRuntimeStatus | string): string {
    if (
        status === 'completed' ||
        status === 'configured' ||
        status === 'loaded' ||
        status === 'passed' ||
        status === 'registered'
    ) {
        return 'good';
    }

    if (
        status === 'running' ||
        status === 'connecting' ||
        status === 'reconnecting'
    ) {
        return 'active';
    }

    if (status === 'failed') {
        return 'bad';
    }

    if (status === 'cancelled') {
        return 'warn';
    }

    return 'muted';
}

export function resultSummary(result: RallarBlackBoxTestResult): string {
    if (result.error?.message) {
        return result.error.message;
    }

    if (result.value && typeof result.value === 'object') {
        const value = result.value as Record<string, unknown>;
        if (typeof value.status === 'number') {
            return `HTTP ${value.status}`;
        }
        if (typeof value.connection === 'string') {
            return value.connection;
        }
        if (typeof value.recipeId === 'string') {
            return value.recipeId;
        }
    }

    return result.ok ? 'ok' : result.status;
}
