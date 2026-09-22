import type { FlowBuilderDefinition } from './flow-builder-contracts.ts';

export function toFlowBuilderText(flow: FlowBuilderDefinition): string {
    return JSON.stringify(flow, null, 2);
}
