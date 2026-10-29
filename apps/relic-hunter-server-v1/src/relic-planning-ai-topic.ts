import {
    computeRelicPlanningAiSuggestion,
    decodeRelicPlanningAiContext,
    decodeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoomGroupRef,
    type RelicPlanningAiSuggestion
} from '@relic-hunters/mod.ts';
import { createRallarServerAi } from '@shared-server/rallar-ai/create-rallar-server-ai.ts';
import {
    installRallarServerAiWebSocketTopic,
    type RallarServerAiWebSocketMessageContext,
    type RallarServerAiWebSocketPort
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import type { RallarServerAi } from '@shared-server/rallar-ai/rallar-server-ai-contracts.ts';
import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import {
    createRallarAiMockProvider,
    RallarAiError,
    type RallarAiAuthorizationContext,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';

export interface InstallRelicPlanningAiTopicInput {
    readonly websocket: RallarServerAiWebSocketPort;
    readonly serverSenderId: string;
    readonly canRequestPlanning: (sessionId: string, gameId: string) => Promise<boolean>;
}

export function installRelicPlanningAiTopic(input: InstallRelicPlanningAiTopicInput): () => boolean {
    return installRallarServerAiWebSocketTopic({
        websocket: toRelicRoomAiWebSocketPort(input),
        serverAi: createRelicPlanningServerAi(),
        config: {
            requestTopicId: RELIC_TOPICS.aiPlanning,
            requestTypeId: RELIC_TYPES.aiPlanningRequest,
            requestScope: 'room',
            requestFanout: 'none',
            replyTypeId: RELIC_TYPES.aiPlanningReply,
            replyFanout: 'outbox',
            maxPayloadBytes: 32 * 1024,
            serverSenderId: input.serverSenderId
        },
        authorize: isRelicPlanningAiRequestAuthorized
    });
}

export function createRelicPlanningServerAi(): RallarServerAi {
    return createRallarServerAi({
        provider: createRallarAiMockProvider({
            providerId: 'relic-planning-deterministic',
            modelId: 'deterministic-planning-companion-v1',
            value: computeRelicPlanningServerSuggestion
        }),
        policy: { mode: 'server-only', timeoutMs: 5_000 },
        limits: {
            maxConcurrentGenerations: 2,
            maxRequestBytes: 96 * 1024,
            maxPromptBytes: 12 * 1024,
            maxSchemaBytes: 32 * 1024,
            maxContextBytes: 16 * 1024
        }
    });
}

/** The topic admits a request only in a Relic room: its GroupRef must be the Relic scope's ref for its room id. */
function toRelicRoomAiWebSocketPort(input: InstallRelicPlanningAiTopicInput): RallarServerAiWebSocketPort {
    const port = input.websocket;
    return {
        defineTopic: (definition) =>
            port.defineTopic({
                ...definition,
                authorize: async (message, context) =>
                    isRelicRoomContext(context) && context.roomId !== undefined &&
                    await input.canRequestPlanning(context.senderId, context.roomId) &&
                    await definition.authorize(message, context)
            }),
        on: (selector, handler) =>
            port.on(selector, async (message, context) => {
                if (
                    isRelicRoomContext(context) && context.roomId &&
                    await input.canRequestPlanning(context.senderId, context.roomId)
                ) {
                    await handler(message, context);
                }
            }),
        publish: async (publication) => {
            const roomRef = readALTargetGroupRef(publication.message);
            const targets = publication.message.targets;
            if (
                !roomRef || targets?.mode !== 'unicast' ||
                !await input.canRequestPlanning(targets.toPeerId, roomRef.groupId)
            ) {
                throw new RallarAiError(
                    'unauthorized',
                    'Only a current expedition participant can receive planning advice.'
                );
            }
            return await port.publish(publication);
        }
    };
}

function isRelicRoomContext(context: RallarServerAiWebSocketMessageContext): boolean {
    return context.roomId !== undefined && context.roomRef !== undefined &&
        isSameGroupRef(context.roomRef, toRelicRoomGroupRef(context.roomId));
}

function isRelicPlanningAiRequestAuthorized(context: RallarAiAuthorizationContext): boolean {
    return context.action === 'generate' &&
        context.schemaId === RELIC_PLANNING_AI_SCHEMA_ID &&
        context.schemaVersion === RELIC_PLANNING_AI_SCHEMA_VERSION &&
        context.roomId !== undefined;
}

function computeRelicPlanningServerSuggestion(request: RallarAiJsonRequest): RelicPlanningAiSuggestion {
    const context = decodeRelicPlanningAiContext(request.context);
    if (context.right === undefined) {
        throw new RallarAiError('invalid-json', `Relic planning context is malformed: ${context.left}`);
    }
    const suggestion = decodeRelicPlanningAiSuggestion(computeRelicPlanningAiSuggestion(context.right), context.right);
    if (suggestion.right === undefined) {
        throw new RallarAiError('schema-validation-failed', `Relic planning suggestion is refused: ${suggestion.left}`);
    }
    return suggestion.right;
}
