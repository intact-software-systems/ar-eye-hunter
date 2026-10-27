import {
    computeRelicPlanningAiSuggestion,
    decodeRelicPlanningAiContext,
    decodeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPlanningAiSuggestion
} from '@relic-hunters/mod.ts';
import { createRallarServerAi } from '@shared-server/rallar-ai/create-rallar-server-ai.ts';
import {
    installRallarServerAiWebSocketTopic,
    type RallarServerAiWebSocketPort
} from '@shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts';
import type { RallarServerAi } from '@shared-server/rallar-ai/rallar-server-ai-contracts.ts';
import {
    createRallarAiMockProvider,
    RallarAiError,
    type RallarAiAuthorizationContext,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';

export interface InstallRelicPlanningAiTopicInput {
    readonly websocket: RallarServerAiWebSocketPort;
    readonly serverSenderId: string;
}

/**
 * The planning companion on the server (D444): a hunter's planning request is answered with proposal data only,
 * to the asking session alone. Submit Plan stays the only authoritative path.
 */
export function installRelicPlanningAiTopic(input: InstallRelicPlanningAiTopicInput): () => boolean {
    return installRallarServerAiWebSocketTopic({
        websocket: input.websocket,
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

/** The deterministic planner: production answers with it, and an Ollama-backed planner is not built. */
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

function isRelicPlanningAiRequestAuthorized(context: RallarAiAuthorizationContext): boolean {
    return context.action === 'generate' &&
        context.schemaId === RELIC_PLANNING_AI_SCHEMA_ID &&
        context.schemaVersion === RELIC_PLANNING_AI_SCHEMA_VERSION &&
        context.roomId !== undefined;
}

/** Its own suggestion is decoded like a model's before it leaves the server: proposal data, never authority. */
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
