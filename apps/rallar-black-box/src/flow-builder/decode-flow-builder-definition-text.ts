import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { FlowBuilderDefinition, FlowBuilderStep, FlowBuilderStepKind } from './flow-builder-contracts.ts';

export function decodeFlowBuilderDefinitionText(text: string): Either<string, FlowBuilderDefinition> {
    try {
        return decodeFlowBuilderDefinition(JSON.parse(text));
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}

function decodeFlowBuilderDefinition(value: unknown): Either<string, FlowBuilderDefinition> {
    const record = decodeRecord(value);
    const flowId = decodeNonBlankText(record.flowId);
    const name = decodeNonBlankText(record.name);
    if (!flowId || !name || !Array.isArray(record.steps)) {
        return Either.ofLeft('Flow JSON requires flowId, name, and steps.');
    }
    return Either.ofRight({
        flowId,
        name,
        description: typeof record.description === 'string' ? record.description : undefined,
        continueOnFailure: record.continueOnFailure === true,
        variables: decodeRecord(record.variables),
        steps: record.steps.map(decodeFlowBuilderStep)
    });
}

function decodeFlowBuilderStep(value: unknown, index: number): FlowBuilderStep {
    const step = decodeRecord(value);
    return {
        stepId: typeof step.stepId === 'string' ? step.stepId : `step-${index + 1}`,
        label: typeof step.label === 'string' ? step.label : `Step ${index + 1}`,
        kind: typeof step.kind === 'string' ? step.kind as FlowBuilderStepKind : 'rest.request',
        enabled: step.enabled === false ? false : undefined,
        commands: Array.isArray(step.commands) ? step.commands as RallarBlackBoxTestCommand[] : undefined,
        set: decodeRecord(step.set),
        expect: step.expect,
        extract: step.extract,
        notes: typeof step.notes === 'string' ? step.notes : undefined
    };
}

function decodeNonBlankText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
