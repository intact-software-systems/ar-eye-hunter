import type {
    RallarAiAuthorize,
    RallarAiDiagnosticsSink,
    RallarAiGenerationPolicy,
    RallarAiJsonProvider,
    RallarAiJsonResult,
    RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';

export interface RallarServerAiRequestContext {
    readonly actorId?: string;
    readonly roomId?: string;
}

export type RallarServerAiRequestRedactor = (
    request: RallarServerAiJsonRequest,
    context: RallarServerAiRequestContext
) => RallarServerAiJsonRequest;

export interface RallarServerAiLimits {
    readonly maxConcurrentGenerations: number;
    readonly maxRequestBytes: number;
    readonly maxPromptBytes: number;
    readonly maxSchemaBytes: number;
    readonly maxContextBytes: number;
}

export interface CreateRallarServerAiInput {
    readonly provider: RallarAiJsonProvider;
    readonly policy: RallarAiGenerationPolicy;
    readonly limits: RallarServerAiLimits;
    readonly authorize?: RallarAiAuthorize;
    readonly diagnostics?: RallarAiDiagnosticsSink;
    readonly redactRequest?: RallarServerAiRequestRedactor;
}

export interface RallarServerAi {
    generateJson(
        request: RallarServerAiJsonRequest,
        context?: RallarServerAiRequestContext
    ): Promise<RallarAiJsonResult<RallarAiJsonValue>>;
}
