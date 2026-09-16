import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type {
    FlowBuilderDefinition,
    FlowBuilderParseResult,
    FlowBuilderStep,
    FlowBuilderStepKind
} from '../flow-builder.ts';

export function parseFlowBuilderDefinition(text: string): FlowBuilderParseResult {
    try {
        const record = toRecord(JSON.parse(text));
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

export function toFlowBuilderText(flow: FlowBuilderDefinition): string {
    return JSON.stringify(flow, null, 2);
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

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
