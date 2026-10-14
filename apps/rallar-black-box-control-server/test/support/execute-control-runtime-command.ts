import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { assert } from '@std/assert';

/** Execute actual selected ranges at the test agent boundary; these fixtures use matching Full replacement defaults. */
export function executeControlRuntimeCommand(
    runtime: RallarBlackBoxTestRuntime,
    envelope: ControlCommandEnvelope
): Promise<RallarBlackBoxTestResult> {
    assert(envelope.agentId !== undefined, 'runtime dispatch requires the registered agent address');
    return runtime.execute(
        {
            ...envelope.command,
            commandId: envelope.commandId,
            deadlineEpochMs: envelope.deadlineEpochMs ?? envelope.command.deadlineEpochMs
        },
        { runId: envelope.runId, agentId: envelope.agentId },
        {
            eventHistorySelection: envelope.recipeExecution?.first === false
                ? {
                    policy: runtime.state().eventHistory.policy,
                    runOverride: envelope.command.kind === 'recipe.run' && envelope.command.eventHistory !== undefined
                }
                : undefined,
            recipeExecution: envelope.recipeExecution
        }
    );
}
