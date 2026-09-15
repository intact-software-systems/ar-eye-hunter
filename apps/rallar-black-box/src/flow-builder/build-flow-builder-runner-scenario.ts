import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { FlowBuilderDefinition, FlowBuilderStep } from '../flow-builder.ts';
import { buildFlowBuilderRecipe, flowBuilderVariables, toRecord } from './flow-builder-recipe.ts';

function isSecretLike(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('ticket') ||
        lower.includes('secret');
}

function toRunnerVariables(variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [
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
): Record<string, unknown> {
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
            return {
                ...base,
                type: 'http',
                connection: 'api',
                request: command.request
            };
        case 'health':
            return {
                ...base,
                type: step.kind === 'wait' ? 'wait' : 'health',
                request: {
                    timeoutMs: command.timeoutMs,
                    delayMs: toRecord(command.metadata).localDelayMs
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
        default:
            return {
                ...base,
                type: command.kind,
                request: command
            };
    }
}

export function buildFlowBuilderRunnerScenario(
    flow: FlowBuilderDefinition,
    overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
    const variables = flowBuilderVariables(flow, overrides);
    const recipe = buildFlowBuilderRecipe(flow, overrides);
    return {
        variables: toRunnerVariables(variables),
        connections: {
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
        },
        steps: flow.steps.flatMap((step) =>
            step.enabled === false
                ? []
                : recipe.commands
                    .filter((command) =>
                        toRecord(command.metadata).flow &&
                        toRecord(toRecord(command.metadata).flow).stepId === step.stepId
                    )
                    .map((command) => toRunnerStepForCommand(step, command))
        )
    };
}

function toRunnerRtcConnectRequest(
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }>
): Readonly<Record<string, unknown>> {
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
): Readonly<Record<string, unknown>> {
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
): Readonly<Record<string, unknown>> {
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
    base: Readonly<Record<string, unknown>>
): Record<string, unknown> {
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
    base: Readonly<Record<string, unknown>>
): Record<string, unknown> {
    const request = command.kind === 'rtc.connect'
        ? toRunnerRtcConnectRequest(command)
        : command.kind === 'rtc.send'
        ? toRunnerRtcSendRequest(command)
        : toRunnerRtcStreamRequest(command);
    return { ...base, type: command.kind, connection: command.connection ?? 'flowRtc', request };
}
