import type { FlowBuilderDefinition, FlowBuilderTemplate } from '../flow-builder.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES, manualRtcDeliveryMatrixCommands } from '../manual-workbench.ts';
import { toFlowBuilderText } from './flow-builder-definition-text.ts';
import { toCreateGroupCommand } from './flow-builder-steps.ts';

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

const DEFAULT_FLOW: FlowBuilderDefinition = {
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
            commands: [toCreateGroupCommand('flow-create-group')],
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

const RTC_MATRIX_VARIABLES = {
    ...DEFAULT_FLOW_VARIABLES,
    flowId: 'flow-rtc-matrix',
    payload: {
        topic: 'flow.rtc.matrix',
        text: 'hello from RTC matrix flow'
    }
};

const RTC_MATRIX_MANUAL_VALUES = {
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

const RTC_MATRIX_FLOW: FlowBuilderDefinition = {
    flowId: 'flow-rtc-matrix',
    name: 'RTC delivery matrix',
    description: 'Direct, multicast, and broadcast over realtime and messages.rtc.',
    continueOnFailure: false,
    variables: RTC_MATRIX_VARIABLES,
    steps: [
        {
            stepId: 'realtime-matrix',
            label: 'Realtime matrix',
            kind: 'rtc.send',
            commands: manualRtcDeliveryMatrixCommands({
                values: RTC_MATRIX_MANUAL_VALUES,
                payload: '{{payload}}',
                sequence: 1,
                transport: 'realtime',
                requestId: '{{apiMutationRequestId}}'
            })
        },
        {
            stepId: 'messages-matrix',
            label: 'Messages RTC matrix',
            kind: 'rtc.send',
            commands: manualRtcDeliveryMatrixCommands({
                values: RTC_MATRIX_MANUAL_VALUES,
                payload: '{{payload}}',
                sequence: 20,
                transport: 'messages.rtc',
                requestId: '{{apiMutationRequestId}}'
            })
        }
    ]
};

export const FLOW_BUILDER_TEMPLATES: readonly FlowBuilderTemplate[] = [
    {
        templateId: 'auth-rest-ws-rtc',
        label: 'Auth REST WS RTC',
        description: 'Login-shaped REST, group setup, WebSocket, RTC, wait, and cleanup.',
        flow: DEFAULT_FLOW
    },
    {
        templateId: 'rtc-matrix',
        label: 'RTC Matrix',
        description: 'Direct, multicast, and broadcast over realtime and messages.rtc.',
        flow: RTC_MATRIX_FLOW
    }
];

export function toTemplateFlowBuilderText(templateId: string): string {
    const template = FLOW_BUILDER_TEMPLATES.find((entry) => entry.templateId === templateId) ??
        FLOW_BUILDER_TEMPLATES[0];
    return toFlowBuilderText(template.flow);
}
