import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type {
    FlowBuilderDefinition,
    FlowBuilderParseResult,
    FlowBuilderStep,
    FlowBuilderStepKind
} from '../flow-builder.ts';
import { toNewStepCommand } from './flow-builder-steps.ts';

export function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function toVariableValue(variables: Readonly<Record<string, unknown>>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = variables;
    for (const part of parts) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function toSubstitutedString(value: string, variables: Readonly<Record<string, unknown>>): unknown {
    const exact = value.match(/^(?:\{\{([^{}]+)\}\}|\$\{([^{}]+)\}|\{([A-Za-z0-9_.-]+)\})$/);
    if (exact) {
        const variable = toVariableValue(variables, exact[1] ?? exact[2] ?? exact[3]);
        return variable === undefined ? value : variable;
    }

    return value
        .replace(/\{\{([^{}]+)\}\}/g, (match, variableName: string) => {
            const variable = toVariableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        })
        .replace(/\$\{([^{}]+)\}/g, (match, variableName: string) => {
            const variable = toVariableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        })
        .replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, variableName: string) => {
            const variable = toVariableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        });
}

export function applyFlowBuilderVariables(
    value: unknown,
    variables: Readonly<Record<string, unknown>>
): unknown {
    if (typeof value === 'string') {
        return toSubstitutedString(value, variables);
    }

    if (Array.isArray(value)) {
        return value.map((entry) => applyFlowBuilderVariables(entry, variables));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                applyFlowBuilderVariables(entry, variables)
            ])
        );
    }

    return value;
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

interface FlowCommandMetadataInput {
    readonly flow: FlowBuilderDefinition;
    readonly step: FlowBuilderStep;
    readonly command: RallarBlackBoxTestCommand;
    readonly index: number;
}

function createFlowMutationCommand(
    command: RallarBlackBoxTestCommand
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
                crypto.randomUUID()
            )
        }
    };
}

export function flowBuilderVariables(
    flow: FlowBuilderDefinition,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    const variables: Record<string, unknown> = {
        ...flow.variables,
        ...overrides
    };

    for (const step of flow.steps) {
        if (step.enabled === false || step.kind !== 'set') {
            continue;
        }

        Object.assign(variables, applyFlowBuilderVariables(step.set ?? {}, variables));
    }

    return variables;
}

export function buildFlowBuilderRecipe(
    flow: FlowBuilderDefinition,
    overrides: Readonly<Record<string, unknown>> = {}
): RallarBlackBoxTestRecipe {
    const variables = flowBuilderVariables(flow, overrides);
    const commands = flow.steps.flatMap((step): readonly RallarBlackBoxTestCommand[] => {
        if (step.enabled === false) {
            return [];
        }

        return (step.commands ?? []).map((command, index) =>
            createFlowMutationCommand(applyFlowBuilderVariables(
                toCommandWithFlowMetadata({ flow: flow, step: step, command: command, index: index }),
                variables
            ) as RallarBlackBoxTestCommand)
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

export function parseFlowBuilderDefinition(text: string): FlowBuilderParseResult {
    try {
        const parsed = JSON.parse(text) as unknown;
        const record = toRecord(parsed);
        const flowId = typeof record.flowId === 'string' && record.flowId.trim().length > 0
            ? record.flowId
            : undefined;
        const name = typeof record.name === 'string' && record.name.trim().length > 0
            ? record.name
            : undefined;
        const steps = Array.isArray(record.steps) ? record.steps : undefined;
        if (!flowId || !name || !steps) {
            return {
                ok: false,
                error: 'Flow JSON requires flowId, name, and steps.'
            };
        }

        return {
            ok: true,
            flow: {
                flowId,
                name,
                description: typeof record.description === 'string' ? record.description : undefined,
                continueOnFailure: record.continueOnFailure === true,
                variables: toRecord(record.variables),
                steps: steps.map(toParsedFlowStep)
            }
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function flowBuilderText(flow: FlowBuilderDefinition): string {
    return JSON.stringify(flow, null, 2);
}

export function addFlowBuilderStep(
    flow: FlowBuilderDefinition,
    kind: FlowBuilderStepKind
): FlowBuilderDefinition {
    return {
        ...flow,
        steps: [
            ...flow.steps,
            toNewStepCommand(kind, flow.steps.length)
        ]
    };
}

function toParsedFlowStep(step: unknown, index: number): FlowBuilderStep {
    const stepRecord = toRecord(step);
    return {
        stepId: typeof stepRecord.stepId === 'string'
            ? stepRecord.stepId
            : `step-${index + 1}`,
        label: typeof stepRecord.label === 'string'
            ? stepRecord.label
            : `Step ${index + 1}`,
        kind: typeof stepRecord.kind === 'string'
            ? stepRecord.kind as FlowBuilderStepKind
            : 'rest.request',
        enabled: stepRecord.enabled === false ? false : undefined,
        commands: Array.isArray(stepRecord.commands)
            ? stepRecord.commands as RallarBlackBoxTestCommand[]
            : undefined,
        set: toRecord(stepRecord.set),
        expect: stepRecord.expect,
        extract: stepRecord.extract,
        notes: typeof stepRecord.notes === 'string' ? stepRecord.notes : undefined
    };
}
