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

/** An authored flow step; operators omit the optional fields from the flow JSON they edit. */
export interface FlowBuilderStep {
    readonly stepId: string;
    readonly label: string;
    readonly kind: FlowBuilderStepKind;
    /** Absent keeps the step enabled; only false disables it. */
    readonly enabled?: boolean;
    /** Absent for a step that issues no commands. */
    readonly commands?: readonly RallarBlackBoxTestCommand[];
    /** Absent for a step that assigns no variables. */
    readonly set?: Readonly<Record<string, unknown>>;
    /** Absent for a step that records no expectation. */
    readonly expect?: unknown;
    /** Absent for a step that extracts no variables. */
    readonly extract?: unknown;
    /** Absent for a step without operator notes. */
    readonly notes?: string;
}

export interface FlowBuilderDefinition {
    readonly flowId: string;
    readonly name: string;
    /** Absent for a flow without a description. */
    readonly description?: string;
    /** Absent stops the flow at its first failed command. */
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
