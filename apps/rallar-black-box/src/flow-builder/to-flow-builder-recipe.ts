import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { FlowBuilderDefinition, FlowBuilderStep } from './flow-builder-contracts.ts';
import { computeFlowBuilderVariables, toSubstitutedFlowBuilderValue } from './flow-builder-variables.ts';

export interface FlowBuilderRecipeInput {
    readonly flow: FlowBuilderDefinition;
    readonly overrides: Readonly<Record<string, unknown>>;
    createRequestId(): string;
}

interface FlowCommandMetadataInput {
    readonly flow: FlowBuilderDefinition;
    readonly step: FlowBuilderStep;
    readonly command: RallarBlackBoxTestCommand;
    readonly index: number;
}

export function toFlowBuilderRecipe(input: FlowBuilderRecipeInput): RallarBlackBoxTestRecipe {
    const { flow, createRequestId } = input;
    const variables = computeFlowBuilderVariables(flow, input.overrides);
    const commands = flow.steps.flatMap((step): readonly RallarBlackBoxTestCommand[] => {
        if (step.enabled === false) {
            return [];
        }

        return (step.commands ?? []).map((command, index) =>
            toCommandWithMutationRequestId(
                toSubstitutedFlowBuilderValue(
                    toCommandWithFlowMetadata({ flow: flow, step: step, command: command, index: index }),
                    variables
                ) as RallarBlackBoxTestCommand,
                createRequestId
            )
        );
    });

    return {
        schemaVersion: 1,
        recipeId: flow.flowId,
        name: flow.name,
        description: flow.description,
        continueOnFailure: flow.continueOnFailure ?? false,
        metadata: {
            surface: 'flow-builder',
            variableNames: Object.keys(variables).sort()
        },
        commands
    };
}

function toCommandWithFlowMetadata(input: FlowCommandMetadataInput): RallarBlackBoxTestCommand {
    const { flow, step, command, index } = input;
    return {
        ...command,
        commandId: command.commandId ?? `${flow.flowId}-${step.stepId}-${index + 1}`,
        label: command.label ?? step.label,
        metadata: {
            ...command.metadata,
            flow: {
                flowId: flow.flowId,
                stepId: step.stepId,
                stepKind: step.kind,
                expect: step.expect,
                extract: step.extract
            }
        }
    };
}

function toCommandWithMutationRequestId(
    command: RallarBlackBoxTestCommand,
    createRequestId: FlowBuilderRecipeInput['createRequestId']
): RallarBlackBoxTestCommand {
    if (command.kind !== 'http.request' || !command.request.path) {
        return command;
    }
    return {
        ...command,
        request: {
            ...command.request,
            path: command.request.path.replace(
                '{{apiMutationRequestId}}',
                createRequestId()
            )
        }
    };
}
