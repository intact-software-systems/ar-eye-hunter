import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunCommandLink } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRecipeResult,
    RallarBlackBoxDistributedRunError
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

export interface ToDistributedRecipeResultInput {
    readonly link: ControlDistributedRunCommandLink;
    readonly dispatched: boolean;
    readonly result: ControlResultEnvelope | undefined;
}

export function toDistributedRecipeResult(
    input: ToDistributedRecipeResultInput
): RallarBlackBoxDistributedRecipeResult {
    const { link, result } = input;
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

export function toDistributedRunResultError(result: ControlResultEnvelope): RallarBlackBoxDistributedRunError {
    return result.error ?? result.result?.error ?? {
        code: 'RALLAR_BB_DISTRIBUTED_COMMAND_FAILED',
        message: `Distributed command ${result.commandId} failed.`
    };
}

function computeNestedRecipeResultCount(result: ControlResultEnvelope): number {
    const value = result.result?.value;
    if (isJsonRecordValue(value) && Array.isArray(value.results)) {
        return value.results.length;
    }
    if (isJsonRecordValue(value) && typeof value.resultCount === 'number') {
        return value.resultCount;
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
