import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

export interface ResolveRecipeCancelFailureInput {
    /** The agent's result for the cancel command; undefined while it has not answered. */
    readonly answer: ControlResultEnvelope | undefined;
    readonly cancelCommandId: string;
    readonly agentId: string;
}

/**
 * The agent answers a `recipe.cancel` with `cancelRequested: true` when it aborted the target, and with
 * `cancelRequested: false` and the reason `target-not-exclusively-active` when the target is not the one top-level
 * command the agent runs: nothing was cancelled, so waiting for the target's result waits for a recipe that still runs.
 * Undefined means no failure: no answer yet, or the ordinary one. The control protocol owns no decoder for a refused
 * cancel, so this is the only reader of the answer's value.
 */
export function resolveRecipeCancelFailure(input: ResolveRecipeCancelFailureInput): string | undefined {
    const { answer } = input;
    const named = `recipe.cancel ${input.cancelCommandId} to agent ${input.agentId} was answered`;
    if (answer === undefined) {
        return undefined;
    }
    if (!answer.ok) {
        return `${named} the error ${answer.error?.code ?? 'RALLAR_BLACK_BOX_COMMAND_FAILED'}: ${
            answer.error?.message ?? 'no message'
        }.`;
    }
    const value = answer.result?.value;
    if (isJsonRecordValue(value) && value.cancelRequested === true) {
        return undefined;
    }
    if (
        isJsonRecordValue(value) && value.cancelRequested === false && value.reason === 'target-not-exclusively-active'
    ) {
        return `${named} target-not-exclusively-active: its target is not the one top-level command the agent runs, ` +
            'so nothing was cancelled.';
    }
    return `${named} an unknown answer: ${JSON.stringify(value) ?? 'no value'}.`;
}
