import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarAiAuthorize,
    RallarAiDiagnosticsSink,
    RallarAiGenerationPolicy,
    RallarAiJsonProvider,
    RallarAiJsonRequest,
    RallarAiJsonResult,
    RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { AppDataValueCodec } from '../app-data/app-data-value-codec.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsPayload,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { DEFAULT_SERVER_AI_LIMITS, DEFAULT_SERVER_AI_POLICY } from './rallar-ai-server-config.ts';
import { createRallarServerAiGeneration } from './rallar-ai-server-generation.ts';
import { createRallarServerAiIngress } from './rallar-ai-server-ingress.ts';
import { createRallarServerAiBroadcast, createRallarServerAiPersistence } from './rallar-ai-server-publication.ts';
import type { RallarServerAiBoundaryValue, RallarServerAiValue } from './rallar-server-ai-boundary-value.ts';

interface RallarServerAiDataStore<V> {
    set(key: string, value: V): Promise<void>;
}

interface RallarServerAiWebSocketFacade {
    defineTopic<T extends RallarServerWsPayload>(definition: RallarServerWsTopicDefinition<T>): void;
    on<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean;
    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
}

interface RallarServerAiDataFacade {
    open<V>(
        input: string,
        options: Readonly<{
            codec: AppDataValueCodec<V>;
            namespace?: string;
            ttlMs?: number;
        }>
    ): Promise<RallarServerAiDataStore<V>>;
}

export interface RallarServerAiRallar {
    readonly ws: RallarServerAiWebSocketFacade;
    readonly appData?: RallarServerAiDataFacade;
}

export interface RallarServerAiRequestContext {
    readonly actorId?: string;
    readonly roomId?: string;
}

export type RallarServerAiRequestRedactor = <TContext>(
    request: RallarAiJsonRequest<TContext>,
    context: RallarServerAiRequestContext
) => RallarAiJsonRequest<TContext>;

export interface RallarServerAiLimits {
    readonly maxConcurrentGenerations?: number;
    readonly maxRequestBytes?: number;
    readonly maxPromptBytes?: number;
    readonly maxSchemaBytes?: number;
    readonly maxContextBytes?: number;
}

export interface CreateRallarServerAiOptions {
    readonly rallar: RallarServerAiRallar;
    readonly provider: RallarAiJsonProvider;
    readonly policy?: RallarAiGenerationPolicy;
    readonly authorize?: RallarAiAuthorize;
    readonly diagnostics?: RallarAiDiagnosticsSink;
    readonly limits?: RallarServerAiLimits;
    readonly redactRequest?: RallarServerAiRequestRedactor;
    readonly serverSenderId?: string;
}

interface RallarServerAiBroadcastBase<TValue> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly actorId?: string;
    readonly topicId?: string;
    readonly typeId?: string;
    readonly resourceId?: string;
    readonly fanout?: RallarServerWsFanout;
}

export type RallarServerAiBroadcastInput<TValue = RallarServerAiValue> =
    & RallarServerAiBroadcastBase<TValue>
    & (
        | Readonly<{ scope?: 'room'; roomRef: GroupRef; }>
        | Readonly<{ scope: 'world' | 'all'; roomRef?: never; }>
    );

export interface RallarServerAiPersistInput<TValue extends RallarAiJsonValue = RallarAiJsonValue> {
    readonly result: RallarAiJsonResult<TValue>;
    readonly actorId?: string;
    readonly roomId?: string;
    readonly storeName?: string;
    readonly key?: string;
    readonly namespace?: string;
    readonly ttlMs?: number;
}

export interface RallarServerAiRestGenerateInput {
    readonly body: RallarServerAiBoundaryValue;
    readonly actorId?: string;
    readonly roomId?: string;
}

export interface RallarServerAiRestGenerateResponse<TValue = RallarServerAiValue> {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body:
        | Readonly<{ ok: true; result: RallarAiJsonResult<TValue>; }>
        | Readonly<{
            ok: false;
            error: Readonly<{ code: string; message: string; }>;
        }>;
}

export interface RallarServerAiRestPostApp {
    post(
        path: string,
        handler: (
            request: RallarServerAiBoundaryValue,
            response?: RallarServerAiBoundaryValue
        ) => Promise<RallarServerAiBoundaryValue> | RallarServerAiBoundaryValue
    ): RallarServerAiBoundaryValue;
}

export interface RallarServerAiRestRouteOptions {
    readonly path?: string;
    readonly readActorId?: (request: RallarServerAiBoundaryValue) => string | undefined;
    readonly readRoomId?: (request: RallarServerAiBoundaryValue) => string | undefined;
    readonly readBody?: (
        request: RallarServerAiBoundaryValue
    ) => RallarServerAiBoundaryValue | Promise<RallarServerAiBoundaryValue>;
}

export interface RallarServerAiGenerationTopicOptions {
    readonly requestTopicId?: string;
    readonly requestTypeId?: string;
    readonly resultTopicId?: string;
    readonly resultTypeId?: string;
    readonly resultFanout?: RallarServerWsFanout;
    readonly requestFanout?: RallarServerWsFanout;
    readonly scope?: 'room' | 'world' | 'all';
    readonly maxPayloadBytes?: number;
}

export interface RallarServerAiFacade {
    generateJson<TValue = RallarServerAiValue, TContext = RallarServerAiValue>(
        request: RallarAiJsonRequest<TContext>,
        context?: RallarServerAiRequestContext
    ): Promise<RallarAiJsonResult<TValue>>;
    broadcastJson<TValue = RallarServerAiValue>(
        input: RallarServerAiBroadcastInput<TValue>
    ): Promise<RallarServerWsPublishResult>;
    persistJson<TValue extends RallarAiJsonValue = RallarAiJsonValue>(
        input: RallarServerAiPersistInput<TValue>
    ): Promise<void>;
    handleRestGenerateJson<TValue = RallarServerAiValue>(
        input: RallarServerAiRestGenerateInput
    ): Promise<RallarServerAiRestGenerateResponse<TValue>>;
    createRestRouteInstaller(
        options?: RallarServerAiRestRouteOptions
    ): (app: RallarServerAiRestPostApp) => void;
    installGenerationTopic(
        options?: RallarServerAiGenerationTopicOptions
    ): () => boolean;
}

export function createRallarServerAi(
    options: CreateRallarServerAiOptions
): RallarServerAiFacade {
    const limits = { ...DEFAULT_SERVER_AI_LIMITS, ...options.limits };
    const generateJson = createRallarServerAiGeneration({
        provider: options.provider,
        policy: options.policy ?? DEFAULT_SERVER_AI_POLICY,
        authorize: options.authorize,
        diagnostics: options.diagnostics,
        redactRequest: options.redactRequest,
        limits
    });
    const ingress = createRallarServerAiIngress({
        options,
        generateJson,
        maxRequestBytes: limits.maxRequestBytes
    });

    return {
        generateJson,
        broadcastJson: createRallarServerAiBroadcast(options),
        persistJson: createRallarServerAiPersistence(options),
        ...ingress
    };
}
