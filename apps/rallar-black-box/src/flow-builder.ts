import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES, manualRtcDeliveryMatrixCommands } from './manual-workbench.ts';

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

export type FlowBuilderStep = Readonly<{
    stepId: string;
    label: string;
    kind: FlowBuilderStepKind;
    enabled?: boolean;
    commands?: readonly RallarBlackBoxTestCommand[];
    set?: Readonly<Record<string, unknown>>;
    expect?: unknown;
    extract?: unknown;
    notes?: string;
}>;

export type FlowBuilderDefinition = Readonly<{
    flowId: string;
    name: string;
    description?: string;
    continueOnFailure?: boolean;
    variables: Readonly<Record<string, unknown>>;
    steps: readonly FlowBuilderStep[];
}>;

export type FlowBuilderTemplate = Readonly<{
    templateId: string;
    label: string;
    description: string;
    flow: FlowBuilderDefinition;
}>;

export type FlowBuilderParseResult =
    | Readonly<{ ok: true; flow: FlowBuilderDefinition; }>
    | Readonly<{ ok: false; error: string; }>;

const DEFAULT_FLOW_VARIABLES = {
    providerMode: 'simulated',
    environment: 'local',
    apiBaseUrl: 'http://localhost:8080',
    wsUrl: 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
    applicationId: DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
    workspaceId: DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
    groupId: 'bb-group',
    actor: DEFAULT_MANUAL_WORKBENCH_VALUES.actor,
    sessionId: DEFAULT_MANUAL_WORKBENCH_VALUES.sessionId,
    username: 'alice',
    password: 'secret',
    rtcConnection: 'flowRtc',
    wsConnection: 'flowWs',
    targetClient: DEFAULT_MANUAL_WORKBENCH_VALUES.targetClient,
    multicastClients: DEFAULT_MANUAL_WORKBENCH_VALUES.multicastClients,
    typeId: DEFAULT_MANUAL_WORKBENCH_VALUES.typeId,
    topicId: DEFAULT_MANUAL_WORKBENCH_VALUES.topicId,
    topic: 'flow.message',
    timeoutMs: 5000,
    payload: {
        topic: 'flow.message',
        text: 'hello from flow builder'
    }
} as const;

function createGroupCommand(commandId: string): RallarBlackBoxTestCommand {
    return {
        kind: 'http.request',
        commandId,
        label: 'Create group',
        request: {
            method: 'POST',
            path: '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}/groups' +
                '/requests/{{apiMutationRequestId}}',
            headers: {
                authorization: 'Bearer {auth.accessToken}',
                'x-client-id': '{auth.clientId}'
            },
            body: {
                groupId: '{{groupId}}',
                displayName: '{{groupId}}',
                kind: 'room',
                joinMode: 'open',
                metadata: {
                    source: 'rallar-black-box',
                    surface: 'flow-builder'
                }
            }
        },
        response: {
            body: 'json'
        }
    };
}

function defaultFlow(): FlowBuilderDefinition {
    return {
        flowId: 'flow-auth-rest-ws-rtc',
        name: 'Auth, REST, WS, RTC smoke',
        description: 'Login-shaped REST, group setup, WebSocket open/send, RTC connect/send, wait, and cleanup.',
        continueOnFailure: false,
        variables: DEFAULT_FLOW_VARIABLES,
        steps: [
            {
                stepId: 'configure',
                label: 'Configure runtime',
                kind: 'set',
                commands: [{
                    kind: 'configure',
                    commandId: 'flow-configure',
                    config: {
                        runId: 'flow-builder-run',
                        agentId: 'visible-agent-local',
                        environment: '{{environment}}',
                        apiBaseUrl: '{{apiBaseUrl}}',
                        actor: '{{actor}}',
                        sessionId: '{{sessionId}}',
                        roomId: '{{groupId}}',
                        transport: 'realtime',
                        control: {
                            mode: 'flow-builder',
                            providerMode: '{{providerMode}}',
                            protocolVersion: 1,
                            connected: false
                        },
                        defaults: {
                            timeoutMs: '{{timeoutMs}}',
                            connection: '{{rtcConnection}}',
                            providerMode: '{{providerMode}}',
                            applicationId: '{{applicationId}}',
                            workspaceId: '{{workspaceId}}',
                            roomRef: {
                                groupId: '{{groupId}}'
                            }
                        }
                    }
                }]
            },
            {
                stepId: 'login',
                label: 'Login request',
                kind: 'auth.login',
                commands: [{
                    kind: 'http.request',
                    commandId: 'flow-auth-login',
                    label: 'Flow login request',
                    request: {
                        method: 'POST',
                        path: '/api/auth/login/requests/{{apiMutationRequestId}}',
                        body: {
                            username: '{{username}}',
                            password: '{{password}}'
                        }
                    },
                    response: {
                        body: 'json'
                    }
                }],
                expect: {
                    status: 200
                },
                extract: {
                    clientId: 'body.clientId',
                    accessToken: 'body.accessToken',
                    sessionId: 'body.sessionId'
                }
            },
            {
                stepId: 'create-group',
                label: 'Create group',
                kind: 'rest.request',
                commands: [createGroupCommand('flow-create-group')],
                expect: {
                    statusCode: [201, 409]
                }
            },
            {
                stepId: 'open-ws',
                label: 'Open WebSocket',
                kind: 'ws.open',
                commands: [{
                    kind: 'ws.open',
                    commandId: 'flow-ws-open',
                    label: 'Flow open WebSocket',
                    connection: '{{wsConnection}}',
                    url: '{{wsUrl}}',
                    timeoutMs: 5000
                }]
            },
            {
                stepId: 'send-ws',
                label: 'Send WebSocket payload',
                kind: 'ws.send',
                commands: [{
                    kind: 'ws.send',
                    commandId: 'flow-ws-send',
                    label: 'Flow send WebSocket',
                    connection: '{{wsConnection}}',
                    data: {
                        groupId: '{{groupId}}',
                        topic: '{{topic}}',
                        deliveryMode: 'broadcast',
                        targets: [],
                        payload: '{{payload}}'
                    },
                    timeoutMs: 5000
                }]
            },
            {
                stepId: 'connect-rtc',
                label: 'Connect RTC',
                kind: 'rtc.connect',
                commands: [{
                    kind: 'rtc.connect',
                    commandId: 'flow-rtc-connect',
                    label: 'Flow connect RTC',
                    connection: '{{rtcConnection}}',
                    actor: '{{actor}}',
                    roomId: '{{groupId}}',
                    applicationId: '{{applicationId}}',
                    workspaceId: '{{workspaceId}}',
                    roomRef: {
                        groupId: '{{groupId}}'
                    },
                    transport: 'realtime',
                    timeoutMs: 5000,
                    rallar: {
                        sessionId: '{{sessionId}}'
                    },
                    metadata: {
                        manual: {
                            deliveryMode: 'direct',
                            expectedClients: ['{{targetClient}}']
                        }
                    }
                }]
            },
            {
                stepId: 'send-rtc',
                label: 'Send RTC payload',
                kind: 'rtc.send',
                commands: [{
                    kind: 'rtc.send',
                    commandId: 'flow-rtc-send',
                    label: 'Flow send RTC',
                    connection: '{{rtcConnection}}',
                    transport: 'realtime',
                    applicationId: '{{applicationId}}',
                    workspaceId: '{{workspaceId}}',
                    roomRef: {
                        groupId: '{{groupId}}'
                    },
                    send: {
                        data: '{{payload}}',
                        roomId: '{{groupId}}',
                        peerIds: ['{{targetClient}}']
                    },
                    timeoutMs: 5000,
                    metadata: {
                        manual: {
                            deliveryMode: 'direct',
                            targets: ['{{targetClient}}']
                        }
                    }
                }]
            },
            {
                stepId: 'wait',
                label: 'Wait for evidence',
                kind: 'wait',
                commands: [{
                    kind: 'health',
                    commandId: 'flow-wait',
                    label: 'Flow wait for evidence',
                    timeoutMs: 5000,
                    metadata: {
                        localDelayMs: 250
                    }
                }],
                expect: {
                    event: 'message'
                }
            },
            {
                stepId: 'cleanup',
                label: 'Cleanup',
                kind: 'cleanup',
                commands: [{
                    kind: 'ws.close',
                    commandId: 'flow-ws-close',
                    label: 'Flow close WebSocket',
                    connection: '{{wsConnection}}',
                    code: 1000,
                    reason: 'flow builder cleanup'
                }, {
                    kind: 'close',
                    commandId: 'flow-close',
                    label: 'Flow close runtime'
                }]
            }
        ]
    };
}

function rtcMatrixFlow(): FlowBuilderDefinition {
    const variables = {
        ...DEFAULT_FLOW_VARIABLES,
        flowId: 'flow-rtc-matrix',
        payload: {
            topic: 'flow.rtc.matrix',
            text: 'hello from RTC matrix flow'
        }
    };
    const manualValues = {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        applicationId: '{{applicationId}}',
        workspaceId: '{{workspaceId}}',
        groupId: '{{groupId}}',
        actor: '{{actor}}',
        sessionId: '{{sessionId}}',
        connection: '{{rtcConnection}}',
        targetClient: '{{targetClient}}',
        multicastClients: '{{multicastClients}}',
        topic: '{{topic}}',
        typeId: '{{typeId}}',
        topicId: '{{topicId}}',
        timeoutMs: 5000
    };

    return {
        flowId: 'flow-rtc-matrix',
        name: 'RTC delivery matrix',
        description: 'Direct, multicast, and broadcast over realtime and messages.rtc.',
        continueOnFailure: false,
        variables,
        steps: [
            {
                stepId: 'realtime-matrix',
                label: 'Realtime matrix',
                kind: 'rtc.send',
                commands: manualRtcDeliveryMatrixCommands(
                    manualValues,
                    '{{payload}}',
                    1,
                    'realtime'
                )
            },
            {
                stepId: 'messages-matrix',
                label: 'Messages RTC matrix',
                kind: 'rtc.send',
                commands: manualRtcDeliveryMatrixCommands(
                    manualValues,
                    '{{payload}}',
                    20,
                    'messages.rtc'
                )
            }
        ]
    };
}

export const FLOW_BUILDER_TEMPLATES: readonly FlowBuilderTemplate[] = [
    {
        templateId: 'auth-rest-ws-rtc',
        label: 'Auth REST WS RTC',
        description: 'Login-shaped REST, group setup, WebSocket, RTC, wait, and cleanup.',
        flow: defaultFlow()
    },
    {
        templateId: 'rtc-matrix',
        label: 'RTC Matrix',
        description: 'Direct, multicast, and broadcast over realtime and messages.rtc.',
        flow: rtcMatrixFlow()
    }
];

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function variableValue(variables: Readonly<Record<string, unknown>>, path: string): unknown {
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

function substituteString(value: string, variables: Readonly<Record<string, unknown>>): unknown {
    const exact = value.match(/^(?:\{\{([^{}]+)\}\}|\$\{([^{}]+)\}|\{([A-Za-z0-9_.-]+)\})$/);
    if (exact) {
        const variable = variableValue(variables, exact[1] ?? exact[2] ?? exact[3]);
        return variable === undefined ? value : variable;
    }

    return value
        .replace(/\{\{([^{}]+)\}\}/g, (match, variableName: string) => {
            const variable = variableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        })
        .replace(/\$\{([^{}]+)\}/g, (match, variableName: string) => {
            const variable = variableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        })
        .replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, variableName: string) => {
            const variable = variableValue(variables, variableName);
            return variable === undefined ? match : String(variable);
        });
}

export function applyFlowBuilderVariables(
    value: unknown,
    variables: Readonly<Record<string, unknown>>
): unknown {
    if (typeof value === 'string') {
        return substituteString(value, variables);
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

function commandWithFlowMetadata(
    flow: FlowBuilderDefinition,
    step: FlowBuilderStep,
    command: RallarBlackBoxTestCommand,
    index: number
): RallarBlackBoxTestCommand {
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
    } as RallarBlackBoxTestCommand;
}

function withFlowMutationRequestId(
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
            withFlowMutationRequestId(applyFlowBuilderVariables(
                commandWithFlowMetadata(flow, step, command, index),
                variables
            ) as RallarBlackBoxTestCommand)
        );
    });

    return {
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

function secretLike(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.includes('password') ||
        lower.includes('token') ||
        lower.includes('ticket') ||
        lower.includes('secret');
}

function runnerVariables(variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(variables).map(([key, value]) => [
            key,
            secretLike(key)
                ? { default: value, secret: true }
                : { default: value }
        ])
    );
}

function runnerStepForCommand(
    step: FlowBuilderStep,
    command: RallarBlackBoxTestCommand
): Record<string, unknown> {
    const base = {
        name: command.commandId ?? step.stepId,
        expect: step.expect
    };

    switch (command.kind) {
        case 'http.request':
            return {
                ...base,
                type: 'http',
                connection: 'api',
                request: command.request
            };
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
        case 'rtc.connect':
            return {
                ...base,
                type: 'rtc.connect',
                connection: command.connection ?? 'flowRtc',
                request: {
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
                }
            };
        case 'rtc.send':
            return {
                ...base,
                type: 'rtc.send',
                connection: command.connection ?? 'flowRtc',
                request: {
                    send: command.send,
                    expect: command.expect,
                    applicationId: command.applicationId,
                    workspaceId: command.workspaceId,
                    scope: command.scope,
                    roomRef: command.roomRef,
                    minSnapshotVersion: command.minSnapshotVersion,
                    transport: command.transport,
                    timeoutMs: command.timeoutMs
                }
            };
        case 'rtc.stream':
            return {
                ...base,
                type: 'rtc.stream',
                connection: command.connection ?? 'flowRtc',
                request: {
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
                }
            };
        case 'health':
            return {
                ...base,
                type: step.kind === 'wait' ? 'wait' : 'health',
                request: {
                    timeoutMs: command.timeoutMs,
                    delayMs: asRecord(command.metadata).localDelayMs
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
        case 'close':
        case 'reset':
        case 'stats':
        case 'configure':
        case 'recipe.load':
        case 'recipe.run':
        case 'recipe.cancel':
        case 'loop':
        case 'parallel':
        case 'crdt.open':
        case 'crdt.apply':
        case 'crdt.read':
        case 'crdt.sync':
        case 'crdt.health':
        case 'crdt.wait':
        case 'crdt.undo':
        case 'crdt.redo':
        case 'crdt.close':
        case 'crdt.destroy':
        case 'director.appoint':
        case 'director.resign':
        case 'director.status':
        case 'director.relay.start':
        case 'director.intent':
        case 'director.sync.request':
        case 'director.relay.stop':
        case 'formation.command':
        case 'formation.readiness':
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
        variables: runnerVariables(variables),
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
                        asRecord(command.metadata).flow &&
                        asRecord(asRecord(command.metadata).flow).stepId === step.stepId
                    )
                    .map((command) => runnerStepForCommand(step, command))
        )
    };
}

export function parseFlowBuilderDefinition(text: string): FlowBuilderParseResult {
    try {
        const parsed = JSON.parse(text) as unknown;
        const record = asRecord(parsed);
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
                variables: asRecord(record.variables),
                steps: steps.map((step, index) => {
                    const stepRecord = asRecord(step);
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
                        set: asRecord(stepRecord.set),
                        expect: stepRecord.expect,
                        extract: stepRecord.extract,
                        notes: typeof stepRecord.notes === 'string' ? stepRecord.notes : undefined
                    };
                })
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

export function templateFlowBuilderText(templateId: string): string {
    const template = FLOW_BUILDER_TEMPLATES.find((entry) => entry.templateId === templateId) ??
        FLOW_BUILDER_TEMPLATES[0];
    return flowBuilderText(template.flow);
}

function newStepCommand(kind: FlowBuilderStepKind, index: number): FlowBuilderStep {
    const suffix = String(index + 1).padStart(2, '0');
    switch (kind) {
        case 'auth.login':
            return {
                stepId: `login-${suffix}`,
                label: 'Login request',
                kind,
                commands: [{
                    kind: 'http.request',
                    commandId: `flow-login-${suffix}`,
                    request: {
                        method: 'POST',
                        path: '/api/auth/login/requests/{{apiMutationRequestId}}',
                        body: {
                            username: '{{username}}',
                            password: '{{password}}'
                        }
                    },
                    response: { body: 'json' }
                }],
                expect: { status: 200 },
                extract: {
                    clientId: 'body.clientId',
                    accessToken: 'body.accessToken',
                    sessionId: 'body.sessionId'
                }
            };
        case 'rest.request':
            return {
                stepId: `rest-${suffix}`,
                label: 'REST request',
                kind,
                commands: [createGroupCommand(`flow-rest-${suffix}`)],
                expect: { statusCode: [200, 201, 409] }
            };
        case 'ws.open':
            return {
                stepId: `ws-open-${suffix}`,
                label: 'Open WebSocket',
                kind,
                commands: [{
                    kind: 'ws.open',
                    commandId: `flow-ws-open-${suffix}`,
                    connection: '{{wsConnection}}',
                    url: '{{wsUrl}}',
                    timeoutMs: 5000
                }]
            };
        case 'ws.send':
            return {
                stepId: `ws-send-${suffix}`,
                label: 'Send WebSocket',
                kind,
                commands: [{
                    kind: 'ws.send',
                    commandId: `flow-ws-send-${suffix}`,
                    connection: '{{wsConnection}}',
                    data: '{{payload}}',
                    timeoutMs: 5000
                }]
            };
        case 'rtc.connect':
            return {
                stepId: `rtc-connect-${suffix}`,
                label: 'Connect RTC',
                kind,
                commands: [{
                    kind: 'rtc.connect',
                    commandId: `flow-rtc-connect-${suffix}`,
                    connection: '{{rtcConnection}}',
                    actor: '{{actor}}',
                    roomId: '{{groupId}}',
                    applicationId: '{{applicationId}}',
                    workspaceId: '{{workspaceId}}',
                    roomRef: { groupId: '{{groupId}}' },
                    transport: 'realtime',
                    timeoutMs: 5000,
                    rallar: { sessionId: '{{sessionId}}' }
                }]
            };
        case 'rtc.send':
            return {
                stepId: `rtc-send-${suffix}`,
                label: 'Send RTC',
                kind,
                commands: [{
                    kind: 'rtc.send',
                    commandId: `flow-rtc-send-${suffix}`,
                    connection: '{{rtcConnection}}',
                    transport: 'realtime',
                    applicationId: '{{applicationId}}',
                    workspaceId: '{{workspaceId}}',
                    roomRef: { groupId: '{{groupId}}' },
                    send: {
                        data: '{{payload}}',
                        roomId: '{{groupId}}',
                        peerIds: ['{{targetClient}}']
                    },
                    timeoutMs: 5000,
                    metadata: {
                        manual: {
                            deliveryMode: 'direct',
                            targets: ['{{targetClient}}']
                        }
                    }
                }]
            };
        case 'wait':
            return {
                stepId: `wait-${suffix}`,
                label: 'Wait',
                kind,
                commands: [{
                    kind: 'health',
                    commandId: `flow-wait-${suffix}`,
                    metadata: {
                        localDelayMs: 250
                    }
                }],
                expect: { event: 'message' }
            };
        case 'cleanup':
            return {
                stepId: `cleanup-${suffix}`,
                label: 'Cleanup',
                kind,
                commands: [{
                    kind: 'close',
                    commandId: `flow-close-${suffix}`
                }]
            };
        case 'set':
            return {
                stepId: `set-${suffix}`,
                label: 'Set variables',
                kind,
                set: {
                    nextValue: 'example'
                }
            };
    }
}

export function addFlowBuilderStep(
    flow: FlowBuilderDefinition,
    kind: FlowBuilderStepKind
): FlowBuilderDefinition {
    return {
        ...flow,
        steps: [
            ...flow.steps,
            newStepCommand(kind, flow.steps.length)
        ]
    };
}
