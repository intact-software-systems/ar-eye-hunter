import { selectRallarBlackBoxActiveCommand } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestResult, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { commandId } from '../../shared/command-presentation.ts';
import type { CommandQueueRow } from '../runner-contracts.ts';

export function deriveQueue(
    state: RallarBlackBoxTestState
): readonly CommandQueueRow[] {
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const resultCache = state.resultCache;
    return (state.loadedRecipe?.commands ?? []).map((command, index) => {
        const id = commandId(command, index);
        const result = resultCache[id];
        const isActive = activeCommand?.commandId === id;
        return {
            id,
            kind: command.kind,
            label: command.label ?? command.kind,
            timeoutMs: command.timeoutMs,
            status: isActive
                ? 'running'
                : result
                ? result.ok
                    ? 'completed'
                    : 'failed'
                : 'pending'
        };
    });
}

export function findSelectedResult(
    history: readonly RallarBlackBoxTestResult[],
    selectedCommandId: string | undefined
): RallarBlackBoxTestResult | undefined {
    if (!selectedCommandId) {
        return history.at(-1);
    }

    return (
        history.find((result) => result.commandId === selectedCommandId) ??
            history.at(-1)
    );
}
