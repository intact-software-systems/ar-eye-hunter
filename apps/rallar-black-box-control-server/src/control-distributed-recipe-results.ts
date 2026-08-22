import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunCommandLink } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRecipeResult } from '@shared-test/rallar-bb-test/distributed-run.ts';

export interface ToDistributedRecipeResultInput {
    readonly link: ControlDistributedRunCommandLink;
    readonly dispatched: boolean;
    readonly result: ControlResultEnvelope | undefined;
}

export function toDistributedRecipeResult(
    input: ToDistributedRecipeResultInput
): RallarBlackBoxDistributedRecipeResult {
    const link = input.link;
    const result = input.result;
    const recipeKey = [
        link.agentId,
        link.recipeId ?? link.role ?? link.commandId
    ].join(':');

    if (!result) {
        return {
            recipeKey,
            recipeId: link.recipeId,
            agentId: link.agentId,
            role: link.role,
            state: input.dispatched ? 'running' : 'pending'
        };
    }

    return {
        recipeKey,
        recipeId: link.recipeId,
        agentId: link.agentId,
        role: link.role,
        state: result.ok ? 'passed' : 'failed',
        ok: result.ok,
        commandResultCount: computeNestedRecipeResultCount(result),
        failureCount: result.ok ? 0 : 1,
        startedAtEpochMs: result.result?.startedAtEpochMs,
        endedAtEpochMs: result.result?.endedAtEpochMs,
        error: result.ok ? undefined : toDistributedRunResultError(result)
    };
}

export function toDistributedRunResultError(result: ControlResultEnvelope): Readonly<{
    code: string;
    message: string;
    details?: unknown;
}> {
    return result.error ?? result.result?.error ?? {
        code: 'RALLAR_BB_DISTRIBUTED_COMMAND_FAILED',
        message: `Distributed command ${result.commandId} failed.`
    };
}

export function computeNestedRecipeResultCount(result: ControlResultEnvelope): number {
    const value = result.result?.value;
    if (
        value && typeof value === 'object' && Array.isArray((value as { results?: unknown; }).results)
    ) {
        return (value as { results: readonly unknown[]; }).results.length;
    }
    if (
        value && typeof value === 'object' &&
        typeof (value as { resultCount?: unknown; }).resultCount === 'number'
    ) {
        return (value as { resultCount: number; }).resultCount;
    }
    return result.result ? 1 : 0;
}

export function resolveFirstStartedAtEpochMs(
    results: readonly ControlResultEnvelope[]
): number | undefined {
    return results
        .map((result) => result.result?.startedAtEpochMs)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right)[0];
}

export function resolveLastEndedAtEpochMs(
    results: readonly ControlResultEnvelope[]
): number | undefined {
    return results
        .map((result) => result.result?.endedAtEpochMs)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => right - left)[0];
}
