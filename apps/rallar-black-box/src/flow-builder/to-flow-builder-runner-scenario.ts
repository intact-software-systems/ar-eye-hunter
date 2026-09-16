import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { FlowBuilderStep } from '../flow-builder.ts';
import { computeFlowBuilderVariables } from './flow-builder-variables.ts';
import { toFlowBuilderRecipe, type FlowBuilderRecipeInput } from './to-flow-builder-recipe.ts';

export interface FlowBuilderRunnerScenario {
    readonly variables: Readonly<Record<string, FlowBuilderRunnerVariable>>;
    readonly connections: typeof FLOW_BUILDER_RUNNER_CONNECTIONS;
    readonly steps: readonly FlowBuilderRunnerStep[];
}

export interface FlowBuilderRunnerVariable {
    readonly default: unknown;
    readonly secret?: true;
}

export interface FlowBuilderRunnerStep {
    readonly name: string;
    readonly expect: FlowBuilderStep['expect'];
    readonly type: string;
    readonly connection?: string;
    readonly request: object;
}

type FlowBuilderRunnerStepBase = Pick<FlowBuilderRunnerStep, 'name' | 'expect'>;

const FLOW_BUILDER_RUNNER_CONNECTIONS = {
    api: {
        type: 'http',
        baseUrl: '{apiBaseUrl}',
        headers: {
            'Content-Type': 'application/json'
        },
        timeoutMs: '{timeoutMs}'
    },
    flowWs: {
        type: 'ws',
        timeoutMs: '{timeoutMs}'
    },
    flowRtc: {
        type: 'rtc',
        provider: 'rallar-browser',
        actor: '{actor}',
        roomId: '{groupId}',
        roomRef: {
            applicationId: '{applicationId}',
            workspaceId: '{workspaceId}',
            groupId: '{groupId}'
        },
        rallar: {
            apiBaseUrl: '{apiBaseUrl}',
            transport: 'realtime'
        }
    }
};

export function toFlowBuilderRunnerScenario(input: FlowBuilderRecipeInput): FlowBuilderRunnerScenario {
    const recipe = toFlowBuilderRecipe(input);
    return {
        variables: toRunnerVariables(input),
        connections: FLOW_BUILDER_RUNNER_CONNECTIONS,
        steps: input.flow.steps.flatMap((step) =>
            step.enabled === false
                ? []
                : recipe.commands
                    .filter((command) => decodeRecord(command.metadata?.flow).stepId === step.stepId)
                    .map((command) => toRunnerStepForCommand(step, command))
        )
    };
}

function isSecretLike(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('ticket') ||
        lower.includes('secret');
}

function toRunnerVariables(input: FlowBuilderRecipeInput): Readonly<Record<string, FlowBuilderRunnerVariable>> {
    return Object.fromEntries(
        Object.entries(computeFlowBuilderVariables(input.flow, input.overrides)).map(([key, value]) => [
            key,
            isSecretLike(key)
                ? { default: value, secret: true }
                : { default: value }
        ])
    );
}

function toRunnerStepForCommand(
    step: FlowBuilderStep,
    command: RallarBlackBoxTestCommand
): FlowBuilderRunnerStep {
    const base = { name: command.commandId ?? step.stepId, expect: step.expect };
    switch (command.kind) {
        case 'rtc.connect':
        case 'rtc.send':
        case 'rtc.stream':
            return toRunnerRtcStep(command, base);
        case 'ws.open':
        case 'ws.send':
        case 'ws.close':
            return toRunnerWebSocketStep(command, base);
        case 'http.request':
            return { ...base, type: 'http', connection: 'api', request: command.request };
        case 'health':
        case 'wait':
        case 'assert':
            return toRunnerCheckStep(step, command, base);
        default:
            return { ...base, type: command.kind, request: command };
    }
}

function toRunnerCheckStep(
    step: FlowBuilderStep,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'health' | 'wait' | 'assert'; }>,
    base: FlowBuilderRunnerStepBase
): FlowBuilderRunnerStep {
    switch (command.kind) {
        case 'health':
            return {
                ...base,
                type: step.kind === 'wait' ? 'wait' : 'health',
                request: {
                    timeoutMs: command.timeoutMs,
                    delayMs: decodeRecord(command.metadata).localDelayMs
                }
            };
        case 'wait':
            return {
                ...base,
                type: 'wait',
                request: {
                    match: command.match,
                    timeoutMs: command.timeoutMs,
                    deadlineEpochMs: command.deadlineEpochMs
                }
            };
        case 'assert':
            return {
                ...base,
                type: 'assert',
                request: {
                    source: command.source,
                    operator: command.operator,
                    expected: command.expected
                }
            };
    }
}

function toRunnerRtcConnectRequest(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>
): FlowBuilderRunnerStep['request'] {
    return {
        actor: command.actor,
        roomId: command.roomId,
        applicationId: command.applicationId,
        workspaceId: command.workspaceId,
        scope: command.scope,
        roomRef: command.roomRef,
        minSnapshotVersion: command.minSnapshotVersion,
        transport: command.transport,
        rallar: command.rallar,
        timeoutMs: command.timeoutMs
    };
}

function toRunnerRtcSendRequest(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>
): FlowBuilderRunnerStep['request'] {
    return {
        send: command.send,
        expect: command.expect,
        applicationId: command.applicationId,
        workspaceId: command.workspaceId,
        scope: command.scope,
        roomRef: command.roomRef,
        minSnapshotVersion: command.minSnapshotVersion,
        transport: command.transport,
        timeoutMs: command.timeoutMs
    };
}

function toRunnerRtcStreamRequest(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.stream'; }>
): FlowBuilderRunnerStep['request'] {
    return {
        actor: command.actor,
        roomId: command.roomId,
        applicationId: command.applicationId,
        workspaceId: command.workspaceId,
        scope: command.scope,
        roomRef: command.roomRef,
        minSnapshotVersion: command.minSnapshotVersion,
        transport: command.transport,
        send: command.send,
        count: command.count,
        durationMs: command.durationMs,
        intervalMs: command.intervalMs,
        rateHz: command.rateHz,
        maxInFlight: command.maxInFlight,
        drainTimeoutMs: command.drainTimeoutMs,
        continueOnSendFailure: command.continueOnSendFailure,
        progressEveryMs: command.progressEveryMs,
        sampleEvery: command.sampleEvery,
        thresholds: command.thresholds,
        timeoutMs: command.timeoutMs
    };
}

function toRunnerWebSocketStep(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'ws.open' | 'ws.send' | 'ws.close'; }>,
    base: FlowBuilderRunnerStepBase
): FlowBuilderRunnerStep {
    switch (command.kind) {
        case 'ws.open':
            return {
                ...base,
                type: 'ws.open',
                connection: command.connection ?? 'flowWs',
                request: {
                    url: command.url,
                    protocols: command.protocols,
                    headers: command.headers,
                    timeoutMs: command.timeoutMs
                }
            };
        case 'ws.send':
            return {
                ...base,
                type: 'ws.send',
                connection: command.connection ?? 'flowWs',
                request: {
                    send: command.data,
                    timeoutMs: command.timeoutMs
                }
            };
        case 'ws.close':
            return {
                ...base,
                type: 'ws.close',
                connection: command.connection ?? 'flowWs',
                request: {
                    code: command.code,
                    reason: command.reason
                }
            };
    }
}

function toRunnerRtcStep(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'rtc.stream'; }>,
    base: FlowBuilderRunnerStepBase
): FlowBuilderRunnerStep {
    const request = command.kind === 'rtc.connect'
        ? toRunnerRtcConnectRequest(command)
        : command.kind === 'rtc.send'
        ? toRunnerRtcSendRequest(command)
        : toRunnerRtcStreamRequest(command);
    return { ...base, type: command.kind, connection: command.connection ?? 'flowRtc', request };
}

function decodeRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}
