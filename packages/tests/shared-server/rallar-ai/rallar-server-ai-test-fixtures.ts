import { createRallarServerAi } from '@shared-server/rallar-ai/create-rallar-server-ai.ts';
import { decodeRallarServerAiJsonRequest, type RallarServerAiJsonRequest } from '@shared-server/rallar-ai/decode-rallar-server-ai-json-request.ts';
import type {
    RallarServerAiWebSocketHandler,
    RallarServerAiWebSocketMessageContext,
    RallarServerAiWebSocketPort,
    RallarServerAiWebSocketSelector,
    RallarServerAiWebSocketTopicDefinition
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import type { RallarServerAi, RallarServerAiLimits } from '@shared-server/rallar-ai/rallar-server-ai-contracts.ts';
import type { RallarServerAiResultPublicationPort } from '@shared-server/rallar-ai/rallar-server-ai-result-publication.ts';
import type { JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarServerWsFanout, RallarServerWsPublishResult } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarAiJsonResult,
    createRallarAiMockProvider,
    type RallarAiAuthorize,
    type RallarAiDiagnosticsSink,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';

const RALLAR_SERVER_AI_TEST_LIMITS: RallarServerAiLimits = {
    maxConcurrentGenerations: 4,
    maxRequestBytes: 256 * 1024,
    maxPromptBytes: 64 * 1024,
    maxSchemaBytes: 128 * 1024,
    maxContextBytes: 64 * 1024
};

export interface CreateRallarServerAiTestServiceInput {
    readonly provider: RallarAiJsonProvider;
    readonly policy?: RallarAiGenerationPolicy;
    readonly limits?: Partial<RallarServerAiLimits>;
    readonly authorize?: RallarAiAuthorize;
    readonly diagnostics?: RallarAiDiagnosticsSink;
}

export function createRallarServerAiTestService(
    input: CreateRallarServerAiTestServiceInput
): RallarServerAi {
    return createRallarServerAi({
        provider: input.provider,
        policy: input.policy ?? { mode: 'server-only', staleResultMode: 'allow' },
        limits: { ...RALLAR_SERVER_AI_TEST_LIMITS, ...input.limits },
        authorize: input.authorize,
        diagnostics: input.diagnostics
    });
}

export const RALLAR_SERVER_AI_TEST_ROOM_REF: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

export function createRallarServerAiTestRequest(
    requestId = 'request-1'
): RallarServerAiJsonRequest {
    return decodeRallarServerAiJsonRequest(
        createRallarServerAiTestRequestJson(requestId)
    );
}

export function createRallarServerAiTestRequestJson(
    requestId = 'request-1'
): JsonWireObject {
    return {
        requestId,
        schemaId: 'game-event',
        schemaVersion: '1',
        schema: {
            type: 'object',
            required: ['kind'],
            properties: {
                kind: { type: 'string' }
            },
            additionalProperties: false
        },
        prompt: 'Create a game event.',
        context: { roomId: 'room-1' }
    };
}

export function createRallarServerAiTestResult(
    value: RallarAiJsonValue = { kind: 'spawn' }
): RallarAiJsonResult<RallarAiJsonValue> {
    const provider = createRallarAiMockProvider({ value, createdAtEpochMs: 10 });
    return createRallarAiJsonResult({
        request: createRallarServerAiTestRequest(),
        provider,
        value,
        generationId: 'generation-1',
        createdAtEpochMs: 10
    });
}

export interface RallarServerAiTestWebSocket {
    readonly port: RallarServerAiWebSocketPort & RallarServerAiResultPublicationPort;
    readonly topics: RallarServerAiWebSocketTopicDefinition[];
    readonly selectors: RallarServerAiWebSocketSelector[];
    readonly publications: Array<
        Readonly<{
            message: ALMessage;
            fanout?: RallarServerWsFanout;
        }>
    >;
    invoke(
        request: RallarServerAiJsonRequest,
        context?: RallarServerAiWebSocketMessageContext
    ): Promise<void>;
}

export function createRallarServerAiTestWebSocket(): RallarServerAiTestWebSocket {
    const topics: RallarServerAiWebSocketTopicDefinition[] = [];
    const selectors: RallarServerAiWebSocketSelector[] = [];
    const publications: Array<
        Readonly<{
            message: ALMessage;
            fanout?: RallarServerWsFanout;
        }>
    > = [];
    let handler: RallarServerAiWebSocketHandler | undefined;
    const port: RallarServerAiWebSocketPort & RallarServerAiResultPublicationPort = {
        defineTopic: (definition) => {
            topics.push(definition);
        },
        on: (selector, registeredHandler) => {
            selectors.push(selector);
            handler = registeredHandler;
            return () => true;
        },
        publish: async (message, fanout) => {
            publications.push({ message, fanout });
            return successfulPublication(message, fanout);
        }
    };

    return {
        port,
        topics,
        selectors,
        publications,
        invoke: async (request, context = defaultContext()) => {
            if (handler === undefined) {
                throw new Error('RallarAI WebSocket handler is not installed.');
            }
            await handler({ payload: request }, context);
        }
    };
}

function defaultContext(): RallarServerAiWebSocketMessageContext {
    return {
        senderId: 'peer-1',
        roomId: 'room-1',
        roomRef: RALLAR_SERVER_AI_TEST_ROOM_REF
    };
}

function successfulPublication(
    message: ALMessage,
    fanout: RallarServerWsFanout | undefined
): RallarServerWsPublishResult {
    return {
        fanout: fanout ?? 'live-only',
        status: 'sent-live',
        message,
        sentCount: 1,
        entries: []
    };
}
