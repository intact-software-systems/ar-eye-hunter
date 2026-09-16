import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { FlowBuilderDefinition, FlowBuilderStep, FlowBuilderStepKind } from '../flow-builder.ts';

export function toCreateGroupCommand(commandId: string): RallarBlackBoxTestCommand {
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

export function appendFlowBuilderStep(
    flow: FlowBuilderDefinition,
    kind: FlowBuilderStepKind
): FlowBuilderDefinition {
    return {
        ...flow,
        steps: [
            ...flow.steps,
            toNewFlowBuilderStep(kind, flow.steps.length)
        ]
    };
}

function toNewFlowBuilderStep(kind: FlowBuilderStepKind, index: number): FlowBuilderStep {
    const suffix = String(index + 1).padStart(2, '0');
    switch (kind) {
        case 'auth.login':
            return toAuthLoginFlowStep(suffix);
        case 'rest.request':
            return toRestRequestFlowStep(suffix);
        case 'ws.open':
            return toWsOpenFlowStep(suffix);
        case 'ws.send':
            return toWsSendFlowStep(suffix);
        case 'rtc.connect':
            return toRtcConnectFlowStep(suffix);
        case 'rtc.send':
            return toRtcSendFlowStep(suffix);
        case 'wait':
            return toWaitFlowStep(suffix);
        case 'cleanup':
            return toCleanupFlowStep(suffix);
        case 'set':
            return toSetFlowStep(suffix);
    }
}

function toSetFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `set-${suffix}`,
        label: 'Set variables',
        kind: 'set',
        set: {
            nextValue: 'example'
        }
    };
}

function toCleanupFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `cleanup-${suffix}`,
        label: 'Cleanup',
        kind: 'cleanup',
        commands: [{
            kind: 'close',
            commandId: `flow-close-${suffix}`
        }]
    };
}

function toWaitFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `wait-${suffix}`,
        label: 'Wait',
        kind: 'wait',
        commands: [{
            kind: 'health',
            commandId: `flow-wait-${suffix}`,
            metadata: {
                localDelayMs: 250
            }
        }],
        expect: { event: 'message' }
    };
}

function toRtcSendFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `rtc-send-${suffix}`,
        label: 'Send RTC',
        kind: 'rtc.send',
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
}

function toRtcConnectFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `rtc-connect-${suffix}`,
        label: 'Connect RTC',
        kind: 'rtc.connect',
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
}

function toWsSendFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `ws-send-${suffix}`,
        label: 'Send WebSocket',
        kind: 'ws.send',
        commands: [{
            kind: 'ws.send',
            commandId: `flow-ws-send-${suffix}`,
            connection: '{{wsConnection}}',
            data: '{{payload}}',
            timeoutMs: 5000
        }]
    };
}

function toWsOpenFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `ws-open-${suffix}`,
        label: 'Open WebSocket',
        kind: 'ws.open',
        commands: [{
            kind: 'ws.open',
            commandId: `flow-ws-open-${suffix}`,
            connection: '{{wsConnection}}',
            url: '{{wsUrl}}',
            timeoutMs: 5000
        }]
    };
}

function toRestRequestFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `rest-${suffix}`,
        label: 'REST request',
        kind: 'rest.request',
        commands: [toCreateGroupCommand(`flow-rest-${suffix}`)],
        expect: { statusCode: [200, 201, 409] }
    };
}

function toAuthLoginFlowStep(suffix: string): FlowBuilderStep {
    return {
        stepId: `login-${suffix}`,
        label: 'Login request',
        kind: 'auth.login',
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
}
