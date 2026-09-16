import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

export type FlowBuilderStepKind =
    | 'set'
    | 'auth.login'
    | 'rest.request'
    | 'ws.open'
    | 'ws.send'
    | 'rtc.connect'
    | 'rtc.send'
    | 'wait'
    | 'cleanup';

export interface FlowBuilderStep {
    readonly stepId: string;
    readonly label: string;
    readonly kind: FlowBuilderStepKind;
    readonly enabled?: boolean;
    readonly commands?: readonly RallarBlackBoxTestCommand[];
    readonly set?: Readonly<Record<string, unknown>>;
    readonly expect?: unknown;
    readonly extract?: unknown;
    readonly notes?: string;
}

export interface FlowBuilderDefinition {
    readonly flowId: string;
    readonly name: string;
    readonly description?: string;
    readonly continueOnFailure?: boolean;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly steps: readonly FlowBuilderStep[];
}

export interface FlowBuilderTemplate {
    readonly templateId: string;
    readonly label: string;
    readonly description: string;
    readonly flow: FlowBuilderDefinition;
}

export type FlowBuilderParseResult =
    | Readonly<{ ok: true; flow: FlowBuilderDefinition; }>
    | Readonly<{ ok: false; error: string; }>;
