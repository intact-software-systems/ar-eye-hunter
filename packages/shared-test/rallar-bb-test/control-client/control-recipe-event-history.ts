import { Either } from '@shared/resilience/Either.ts';
import type { ControlCommandEnvelope } from '../control-protocol.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import type { RecipeEventHistorySelection } from '../recipe/validate-recipe-event-history.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { validateEventHistoryPolicy, type RallarBlackBoxEventHistoryPolicy } from '../runtime/event-history.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

export namespace ControlRecipeEventHistory {
    export interface Execution {
        readonly commandId: string;
        readonly selection: RecipeEventHistorySelection;
    }
    export type Resume = Readonly<Record<string, Execution>>;
    export interface Admission {
        readonly selection: RecipeEventHistorySelection | undefined;
        readonly error: string | undefined;
    }
}

/** Only active reload executions retain finite admitted policy facts; payloads and configured defaults stay in the runtime. */
export class ControlRecipeEventHistory {
    private readonly executions = new Map<string, ControlRecipeEventHistory.Execution>();

    restore(records: ControlRecipeEventHistory.Resume): void {
        const accepted = decodeControlRecipeEventHistory(records).right;
        if (accepted === undefined) {
            throw new TypeError('Invalid owned recipe history resume state.');
        }
        this.executions.clear();
        for (const [root, execution] of Object.entries(accepted)) {
            this.executions.set(root, snapshotExecution(execution));
        }
    }

    admit(envelope: ControlCommandEnvelope): ControlRecipeEventHistory.Admission {
        const execution = envelope.recipeExecution;
        if (execution === undefined || execution.first) {
            return { selection: undefined, error: undefined };
        }
        const accepted = this.executions.get(execution.rootCommandId);
        if (accepted !== undefined) {
            this.executions.set(
                execution.rootCommandId,
                snapshotExecution({ ...accepted, commandId: envelope.commandId })
            );
        }
        return accepted === undefined
            ? { selection: undefined, error: 'The owned reload execution has no admitted event history selection.' }
            : { selection: accepted.selection, error: undefined };
    }

    settle(envelope: ControlCommandEnvelope, result: RallarBlackBoxTestResult): void {
        const command = envelope.command;
        const outcome = decodeRecord(result.value);
        if (
            result.ok && (command.kind === 'reset' || (command.kind === 'close' && outcome.closed === true) ||
                (command.kind === 'recipe.cancel' && outcome.cancelRequested === true))
        ) {
            this.clear('targetCommandId' in command ? command.targetCommandId : undefined);
        }
        const execution = envelope.recipeExecution;
        if (execution === undefined) {
            return;
        }
        if (!result.ok || execution.last) {
            this.executions.delete(execution.rootCommandId);
            return;
        }
        if (envelope.command.kind !== 'recipe.run') {
            return;
        }
        const policy = decodeRecord(decodeRecord(result.value).invocation).eventHistory;
        if (validateEventHistoryPolicy(policy).length > 0) {
            return;
        }
        const previous = this.executions.get(execution.rootCommandId);
        this.executions.set(
            execution.rootCommandId,
            snapshotExecution({
                commandId: envelope.commandId,
                selection: {
                    policy: policy as RallarBlackBoxEventHistoryPolicy,
                    runOverride: previous?.selection.runOverride ?? envelope.command.eventHistory !== undefined
                }
            })
        );
    }

    clear(targetCommandId?: string): void {
        if (targetCommandId === undefined) {
            this.executions.clear();
            return;
        }
        for (const [root, execution] of this.executions) {
            if (root === targetCommandId || execution.commandId === targetCommandId) {
                this.executions.delete(root);
            }
        }
    }

    snapshot(): ControlRecipeEventHistory.Resume {
        return Object.freeze(Object.fromEntries(this.executions));
    }
}

export function decodeControlRecipeEventHistory(value: unknown): Either<string, ControlRecipeEventHistory.Resume> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('Agent resume requires owned recipe executions.');
    }
    const records: [string, ControlRecipeEventHistory.Execution][] = [];
    for (const [root, execution] of Object.entries(value)) {
        if (
            !root || !isJsonRecordValue(execution) || typeof execution.commandId !== 'string' || !execution.commandId ||
            !isJsonRecordValue(execution.selection) || typeof execution.selection.runOverride !== 'boolean' ||
            validateEventHistoryPolicy(execution.selection.policy).length > 0
        ) {
            return Either.ofLeft('Agent resume contains an invalid recipe history selection.');
        }
        records.push([
            root,
            snapshotExecution({
                commandId: execution.commandId,
                selection: {
                    policy: execution.selection.policy as RallarBlackBoxEventHistoryPolicy,
                    runOverride: execution.selection.runOverride
                }
            })
        ]);
    }
    return Either.ofRight(Object.freeze(Object.fromEntries(records)));
}

function snapshotExecution(execution: ControlRecipeEventHistory.Execution): ControlRecipeEventHistory.Execution {
    return Object.freeze({
        commandId: execution.commandId,
        selection: Object.freeze({ ...execution.selection, policy: Object.freeze({ ...execution.selection.policy }) })
    });
}

/** Translate checkpoint refusal into the actual control result before any page replacement effect. */
export function toUnavailableRecipeHistoryResult(
    envelope: ControlCommandEnvelope,
    message: string,
    atEpochMs: number
): RallarBlackBoxTestResult {
    return {
        commandId: envelope.commandId,
        kind: envelope.command.kind,
        status: 'failed',
        ok: false,
        startedAtEpochMs: atEpochMs,
        endedAtEpochMs: atEpochMs,
        durationMs: 0,
        error: { code: 'RALLAR_BLACK_BOX_RELOAD_HISTORY_UNAVAILABLE', message }
    };
}
