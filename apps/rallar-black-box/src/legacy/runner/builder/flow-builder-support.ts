import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import type { FlowBuilderStepKind } from '../../../flow-builder.ts';
import { recordValue } from '../../shared/record-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';

export function flowBuilderVariablesFromGlobalValues(
    variables: Readonly<Record<string, unknown>>,
    globalValues?: CommandCenterGlobalValues
): Readonly<Record<string, unknown>> {
    if (!globalValues) {
        return variables;
    }

    return {
        ...variables,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        groupId: globalValues.roomId,
        actor: globalValues.clientId,
        sessionId: globalValues.sessionId,
        username: globalValues.clientId
    };
}

export function parseVariablesText(text: string):
    | Readonly<{
        ok: true;
        variables: Readonly<Record<string, unknown>>;
    }>
    | Readonly<{ ok: false; error: string; }> {
    try {
        const parsed = JSON.parse(text) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ok: true, variables: parsed as Record<string, unknown> }
            : { ok: false, error: 'Variables JSON must be an object.' };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export const FLOW_STEP_BUTTONS: readonly FlowBuilderStepKind[] = [
    'auth.login',
    'rest.request',
    'ws.open',
    'ws.send',
    'rtc.connect',
    'rtc.send',
    'wait',
    'cleanup'
];

export function flowStepCommandIds(
    recipeCommands: readonly RallarBlackBoxTestCommand[],
    stepId: string
): readonly string[] {
    return recipeCommands
        .filter(
            (command) => recordValue(command.metadata?.flow).stepId === stepId
        )
        .map(
            (command, index) => command.commandId ?? `${command.kind}-${index + 1}`
        );
}
