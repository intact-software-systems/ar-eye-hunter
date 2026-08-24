import type { RallarAiGenerationPolicy } from '@shared/rallar-ai/mod.ts';
import type { RallarServerAiLimits } from './rallar-ai-server.ts';

export const DEFAULT_SERVER_AI_POLICY: RallarAiGenerationPolicy = {
    mode: 'server-only',
    staleResultMode: 'allow'
};

export const DEFAULT_SERVER_AI_LIMITS: Required<RallarServerAiLimits> = {
    maxConcurrentGenerations: 4,
    maxRequestBytes: 256 * 1024,
    maxPromptBytes: 64 * 1024,
    maxSchemaBytes: 128 * 1024,
    maxContextBytes: 64 * 1024
};

export const DEFAULT_AI_REST_PATH = '/rallar-ai/generate-json';
export const DEFAULT_AI_RESULT_STORE_NAME = 'rallar-ai-results';
export const DEFAULT_AI_REQUEST_TOPIC_ID = 'room.ai.generate';
export const DEFAULT_AI_REQUEST_TYPE_ID = 'rallar.ai.generate-json.request.v1';
export const DEFAULT_AI_RESULT_TOPIC_ID = 'room.ai.generated';
export const DEFAULT_AI_RESULT_TYPE_ID = 'rallar.ai.generate-json.result.v1';
export const DEFAULT_SERVER_SENDER_ID = 'rallar-ai-server';
