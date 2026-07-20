import type { GroupRef } from '@shared/api/group-types.ts';
import {
    type ALMessage,
    newALBroadcastMessage,
    newALRoute,
} from '@shared/al-contracts/al-contract.ts';
import {
    assertRallarAiAuthorized,
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    providerCanRunOnTarget,
    type RallarAiDiagnosticEventKind,
    RallarAiError,
    type RallarAiAuthorize,
    type RallarAiDiagnosticsSink,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition,
} from '../rallar-facade/ws-topic-router.ts';
import type {
    RallarServerAppDataStoreOptions,
} from '../app-data/RallarServerAppData.ts';

type RallarServerAiDataStore<V> = Readonly<{
    set(key: string, value: V): Promise<void>;
}>;

export type RallarServerAiRallar = Readonly<{
    ws: Readonly<{
        defineTopic<T>(definition: RallarServerWsTopicDefinition<T>): unknown;
        on<T>(
            selector: RallarServerWsSelector,
            handler: RallarServerWsHandler<T>,
        ): () => boolean;
        publish(
            message: ALMessage,
            fanout?: RallarServerWsFanout,
        ): Promise<RallarServerWsPublishResult>;
    }>;
    data?: Readonly<{
        open<V>(
            input: string,
            options?: RallarServerAppDataStoreOptions<V>,
        ): Promise<RallarServerAiDataStore<V>>;
    }>;
}>;

export type RallarServerAiRequestContext = Readonly<{
    actorId?: string;
    roomId?: string;
}>;

export type RallarServerAiRequestRedactor = <TContext>(
    request: RallarAiJsonRequest<TContext>,
    context: RallarServerAiRequestContext,
) => RallarAiJsonRequest<TContext>;

export type RallarServerAiLimits = Readonly<{
    maxConcurrentGenerations?: number;
    maxRequestBytes?: number;
    maxPromptBytes?: number;
    maxSchemaBytes?: number;
    maxContextBytes?: number;
}>;

export type CreateRallarServerAiOptions = Readonly<{
    rallar: RallarServerAiRallar;
    provider: RallarAiJsonProvider;
    policy?: RallarAiGenerationPolicy;
    authorize?: RallarAiAuthorize;
    diagnostics?: RallarAiDiagnosticsSink;
    limits?: RallarServerAiLimits;
    redactRequest?: RallarServerAiRequestRedactor;
    serverSenderId?: string;
}>;

type RallarServerAiBroadcastBase<TValue> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    actorId?: string;
    topicId?: string;
    typeId?: string;
    resourceId?: string;
    fanout?: RallarServerWsFanout;
}>;

export type RallarServerAiBroadcastInput<TValue = unknown> =
    & RallarServerAiBroadcastBase<TValue>
    & (
        | Readonly<{
            scope?: 'room';
            roomRef: GroupRef;
        }>
        | Readonly<{
            scope: 'world' | 'all';
            roomRef?: never;
        }>
    );

export type RallarServerAiPersistInput<TValue = unknown> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    actorId?: string;
    roomId?: string;
    storeName?: string;
    key?: string;
    namespace?: string;
    ttlMs?: number;
}>;

export type RallarServerAiRestGenerateInput = Readonly<{
    body: unknown;
    actorId?: string;
    roomId?: string;
}>;

type RallarServerAiRestValidatedGenerateInput = Readonly<{
    body: RallarAiJsonRequest;
    actorId?: string;
    roomId?: string;
}>;

export type RallarServerAiRestGenerateResponse<TValue = unknown> = Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: Readonly<{
        ok: true;
        result: RallarAiJsonResult<TValue>;
    }> | Readonly<{
        ok: false;
        error: Readonly<{
            code: string;
            message: string;
        }>;
    }>;
}>;

export type RallarServerAiRestPostApp = Readonly<{
    post(
        path: string,
        handler: (
            request: unknown,
            response?: unknown,
        ) => Promise<unknown> | unknown,
    ): unknown;
}>;

export type RallarServerAiRestRouteOptions = Readonly<{
    path?: string;
    readActorId?: (request: unknown) => string | undefined;
    readRoomId?: (request: unknown) => string | undefined;
    readBody?: (request: unknown) => unknown | Promise<unknown>;
}>;

export type RallarServerAiGenerationTopicOptions = Readonly<{
    requestTopicId?: string;
    requestTypeId?: string;
    resultTopicId?: string;
    resultTypeId?: string;
    resultFanout?: RallarServerWsFanout;
    requestFanout?: RallarServerWsFanout;
    scope?: 'room' | 'world' | 'all';
    maxPayloadBytes?: number;
}>;

export type RallarServerAiFacade = Readonly<{
    generateJson<TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>,
        context?: RallarServerAiRequestContext,
    ): Promise<RallarAiJsonResult<TValue>>;
    broadcastJson<TValue = unknown>(
        input: RallarServerAiBroadcastInput<TValue>,
    ): Promise<RallarServerWsPublishResult>;
    persistJson<TValue = unknown>(
        input: RallarServerAiPersistInput<TValue>,
    ): Promise<void>;
    handleRestGenerateJson<TValue = unknown>(
        input: RallarServerAiRestGenerateInput,
    ): Promise<RallarServerAiRestGenerateResponse<TValue>>;
    createRestRouteInstaller(
        options?: RallarServerAiRestRouteOptions,
    ): (app: RallarServerAiRestPostApp) => void;
    installGenerationTopic(
        options?: RallarServerAiGenerationTopicOptions,
    ): () => boolean;
}>;

const DEFAULT_SERVER_AI_POLICY: RallarAiGenerationPolicy = {
    mode: 'server-only',
    staleResultMode: 'allow',
};

const DEFAULT_LIMITS: Required<RallarServerAiLimits> = {
    maxConcurrentGenerations: 4,
    maxRequestBytes: 256 * 1024,
    maxPromptBytes: 64 * 1024,
    maxSchemaBytes: 128 * 1024,
    maxContextBytes: 64 * 1024,
};

const DEFAULT_AI_REST_PATH = '/rallar-ai/generate-json';
const DEFAULT_AI_RESULT_STORE_NAME = 'rallar-ai-results';
const DEFAULT_AI_REQUEST_TOPIC_ID = 'room.ai.generate';
const DEFAULT_AI_REQUEST_TYPE_ID = 'rallar.ai.generate-json.request.v1';
const DEFAULT_AI_RESULT_TOPIC_ID = 'room.ai.generated';
const DEFAULT_AI_RESULT_TYPE_ID = 'rallar.ai.generate-json.result.v1';
const DEFAULT_SERVER_SENDER_ID = 'rallar-ai-server';

export function createRallarServerAi(
    options: CreateRallarServerAiOptions,
): RallarServerAiFacade {
    const policy = options.policy ?? DEFAULT_SERVER_AI_POLICY;
    const limits = {
        ...DEFAULT_LIMITS,
        ...options.limits,
    };
    let activeGenerations = 0;

    const generateJson = async <TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>,
        context: RallarServerAiRequestContext = {},
    ): Promise<RallarAiJsonResult<TValue>> => {
        assertServerPolicy(policy, options.provider);
        assertRequestShape(request);
        assertRequestWithinLimits(request, limits);
        await assertRallarAiAuthorized(options.authorize, {
            actorId: context.actorId,
            roomId: context.roomId,
            action: 'generate',
            source: 'server',
            schemaId: request.schemaId,
            schemaVersion: request.schemaVersion,
        });

        if (activeGenerations >= limits.maxConcurrentGenerations) {
            throw new RallarAiError(
                'quota-exceeded',
                'RallarAI server generation concurrency quota was exceeded.',
            );
        }

        activeGenerations += 1;
        const providerRequest = options.redactRequest
            ? options.redactRequest(request, context)
            : request;
        const startedAtEpochMs = Date.now();

        try {
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('generation-requested', {
                    requestId: request.requestId,
                    providerId: options.provider.providerId,
                    modelId: options.provider.modelId,
                    schemaId: request.schemaId,
                    schemaVersion: request.schemaVersion,
                    source: options.provider.source,
                }),
            );
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('provider-started', {
                    requestId: request.requestId,
                    providerId: options.provider.providerId,
                    modelId: options.provider.modelId,
                    schemaId: request.schemaId,
                    schemaVersion: request.schemaVersion,
                    source: options.provider.source,
                }),
            );

            const result = await generateWithTimeout<TValue, TContext>(
                options.provider,
                providerRequest,
                policy.timeoutMs ?? request.timeoutMs,
            );

            if (!result.validation.ok) {
                await emitRallarAiDiagnostic(
                    options.diagnostics,
                    createRallarAiDiagnosticEvent('schema-validation-failed', {
                        generationId: result.generationId,
                        requestId: result.requestId,
                        providerId: result.providerId,
                        modelId: result.modelId,
                        schemaId: result.schemaId,
                        schemaVersion: result.schemaVersion,
                        schemaHash: result.schemaHash,
                        source: result.source,
                        validationOk: false,
                    }),
                );
                throw new RallarAiError(
                    'schema-validation-failed',
                    'RallarAI server provider returned JSON that failed schema validation.',
                    result.validation,
                );
            }

            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('provider-completed', {
                    generationId: result.generationId,
                    requestId: result.requestId,
                    providerId: result.providerId,
                    modelId: result.modelId,
                    schemaId: result.schemaId,
                    schemaVersion: result.schemaVersion,
                    schemaHash: result.schemaHash,
                    source: result.source,
                    validationOk: result.validation.ok,
                    elapsedMs: Date.now() - startedAtEpochMs,
                }),
            );
            return result;
        } catch (error) {
            await emitFailureDiagnostic(options.diagnostics, error, {
                requestId: request.requestId,
                providerId: options.provider.providerId,
                modelId: options.provider.modelId,
                schemaId: request.schemaId,
                schemaVersion: request.schemaVersion,
                source: options.provider.source,
                elapsedMs: Date.now() - startedAtEpochMs,
            });
            throw error;
        } finally {
            activeGenerations -= 1;
        }
    };

    return {
        generateJson,
        broadcastJson: async <TValue = unknown>(
            input: RallarServerAiBroadcastInput<TValue>,
        ): Promise<RallarServerWsPublishResult> => {
            const target = normalizeBroadcastTarget(input);
            await assertRallarAiAuthorized(options.authorize, {
                actorId: input.actorId,
                roomId: target.scope === 'room'
                    ? target.groupRef.groupId
                    : undefined,
                action: 'broadcast',
                source: 'server',
                schemaId: input.result.schemaId,
                schemaVersion: input.result.schemaVersion,
            });
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('envelope-broadcast-started', {
                    generationId: input.result.generationId,
                    requestId: input.result.requestId,
                    providerId: input.result.providerId,
                    modelId: input.result.modelId,
                    schemaId: input.result.schemaId,
                    schemaVersion: input.result.schemaVersion,
                    schemaHash: input.result.schemaHash,
                    source: input.result.source,
                    validationOk: input.result.validation.ok,
                }),
            );

            try {
                const message = toResultBroadcastMessage(
                    input,
                    options.serverSenderId ?? DEFAULT_SERVER_SENDER_ID,
                    target,
                );
                const publishResult = await options.rallar.ws.publish(
                    message,
                    input.fanout,
                );
                await emitRallarAiDiagnostic(
                    options.diagnostics,
                    createRallarAiDiagnosticEvent('envelope-broadcast-completed', {
                        generationId: input.result.generationId,
                        requestId: input.result.requestId,
                        providerId: input.result.providerId,
                        modelId: input.result.modelId,
                        schemaId: input.result.schemaId,
                        schemaVersion: input.result.schemaVersion,
                        schemaHash: input.result.schemaHash,
                        source: input.result.source,
                        validationOk: input.result.validation.ok,
                    }),
                );
                return publishResult;
            } catch (error) {
                await emitRallarAiDiagnostic(
                    options.diagnostics,
                    createRallarAiDiagnosticEvent('envelope-broadcast-failed', {
                        generationId: input.result.generationId,
                        requestId: input.result.requestId,
                        providerId: input.result.providerId,
                        schemaId: input.result.schemaId,
                        schemaVersion: input.result.schemaVersion,
                        schemaHash: input.result.schemaHash,
                        source: input.result.source,
                        validationOk: input.result.validation.ok,
                        errorCode: error instanceof RallarAiError
                            ? error.code
                            : 'provider-failed',
                        message: error instanceof Error ? error.message : String(error),
                    }),
                );
                throw error;
            }
        },
        persistJson: async <TValue = unknown>(
            input: RallarServerAiPersistInput<TValue>,
        ): Promise<void> => {
            if (!options.rallar.data) {
                throw new RallarAiError(
                    'invalid-configuration',
                    'RallarAI server persistence requires a Rallar data facade.',
                );
            }
            await assertRallarAiAuthorized(options.authorize, {
                actorId: input.actorId,
                roomId: input.roomId,
                action: 'persist',
                source: 'server',
                schemaId: input.result.schemaId,
                schemaVersion: input.result.schemaVersion,
            });
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('envelope-persistence-started', {
                    generationId: input.result.generationId,
                    requestId: input.result.requestId,
                    providerId: input.result.providerId,
                    modelId: input.result.modelId,
                    schemaId: input.result.schemaId,
                    schemaVersion: input.result.schemaVersion,
                    schemaHash: input.result.schemaHash,
                    source: input.result.source,
                    validationOk: input.result.validation.ok,
                }),
            );

            try {
                const store = await options.rallar.data.open<
                    RallarAiJsonResult<TValue>
                >(input.storeName ?? DEFAULT_AI_RESULT_STORE_NAME, {
                    namespace: input.namespace ?? 'server',
                    schemaVersion: 1,
                    ttlMs: input.ttlMs,
                });
                await store.set(input.key ?? input.result.generationId, input.result);
                await emitRallarAiDiagnostic(
                    options.diagnostics,
                    createRallarAiDiagnosticEvent('envelope-persistence-completed', {
                        generationId: input.result.generationId,
                        requestId: input.result.requestId,
                        providerId: input.result.providerId,
                        modelId: input.result.modelId,
                        schemaId: input.result.schemaId,
                        schemaVersion: input.result.schemaVersion,
                        schemaHash: input.result.schemaHash,
                        source: input.result.source,
                        validationOk: input.result.validation.ok,
                    }),
                );
            } catch (error) {
                await emitRallarAiDiagnostic(
                    options.diagnostics,
                    createRallarAiDiagnosticEvent('envelope-persistence-failed', {
                        generationId: input.result.generationId,
                        requestId: input.result.requestId,
                        providerId: input.result.providerId,
                        schemaId: input.result.schemaId,
                        schemaVersion: input.result.schemaVersion,
                        schemaHash: input.result.schemaHash,
                        source: input.result.source,
                        validationOk: input.result.validation.ok,
                        errorCode: error instanceof RallarAiError
                            ? error.code
                            : 'provider-failed',
                        message: error instanceof Error ? error.message : String(error),
                    }),
                );
                throw error;
            }
        },
        handleRestGenerateJson: async <TValue = unknown>(
            input: RallarServerAiRestGenerateInput,
        ): Promise<RallarServerAiRestGenerateResponse<TValue>> => {
            if (!isRallarAiJsonRequest(input.body)) {
                return toRestError(
                    new RallarAiError(
                        'invalid-json',
                        'RallarAI REST generation body must be a JSON request.',
                    ),
                );
            }

            try {
                const result = await generateJson<TValue>(input.body, {
                    actorId: input.actorId,
                    roomId: input.roomId,
                });
                return {
                    status: 200,
                    headers: jsonHeaders(),
                    body: {
                        ok: true,
                        result,
                    },
                };
            } catch (error) {
                return toRestError(error);
            }
        },
        createRestRouteInstaller: (
            routeOptions: RallarServerAiRestRouteOptions = {},
        ) => {
            return (app: RallarServerAiRestPostApp): void => {
                app.post(
                    routeOptions.path ?? DEFAULT_AI_REST_PATH,
                    async (request: unknown, response?: unknown) => {
                        const restResponse = await handleRestInvocation(
                            request,
                            response,
                            routeOptions,
                            async (input) =>
                                await generateJson(input.body, {
                                    actorId: input.actorId,
                                    roomId: input.roomId,
                                }),
                        );
                        return writeRestResponse(response, restResponse);
                    },
                );
            };
        },
        installGenerationTopic: (
            topicOptions: RallarServerAiGenerationTopicOptions = {},
        ): () => boolean => {
            const requestTopicId = topicOptions.requestTopicId ??
                DEFAULT_AI_REQUEST_TOPIC_ID;
            const requestTypeId = topicOptions.requestTypeId ??
                DEFAULT_AI_REQUEST_TYPE_ID;
            options.rallar.ws.defineTopic<RallarAiJsonRequest>({
                topicId: requestTopicId,
                typeId: requestTypeId,
                fanout: topicOptions.requestFanout ?? 'none',
                maxPayloadBytes: topicOptions.maxPayloadBytes ??
                    limits.maxRequestBytes,
                validate: (value) => isRallarAiJsonRequest(value),
                authorize: async (message, context) => {
                    try {
                        await assertRallarAiAuthorized(options.authorize, {
                            actorId: context.senderId,
                            roomId: context.roomId,
                            action: 'generate',
                            source: 'server',
                            schemaId: message.payload.schemaId,
                            schemaVersion: message.payload.schemaVersion,
                        });
                        return true;
                    } catch {
                        return false;
                    }
                },
            });

            return options.rallar.ws.on<RallarAiJsonRequest>(
                {
                    topicId: requestTopicId,
                    typeId: requestTypeId,
                },
                async (message, context) => {
                    const result = await generateJson(message.payload, {
                        actorId: context.senderId,
                        roomId: context.roomId,
                    });
                    const scope = topicOptions.scope ?? 'room';
                    const target: RallarServerAiBroadcastTarget = scope === 'room'
                        ? {
                            scope,
                            groupRef: requireCompleteGroupRef(context.roomRef),
                        }
                        : { scope };
                    await options.rallar.ws.publish(
                        toResultBroadcastMessage(
                            {
                                result,
                                actorId: context.senderId,
                                ...(target.scope === 'room'
                                    ? {
                                        scope: target.scope,
                                        roomRef: target.groupRef,
                                    }
                                    : { scope: target.scope }),
                                topicId: topicOptions.resultTopicId ??
                                    DEFAULT_AI_RESULT_TOPIC_ID,
                                typeId: topicOptions.resultTypeId ??
                                    DEFAULT_AI_RESULT_TYPE_ID,
                                fanout: topicOptions.resultFanout,
                            },
                            options.serverSenderId ?? DEFAULT_SERVER_SENDER_ID,
                            target,
                        ),
                        topicOptions.resultFanout,
                    );
                },
            );
        },
    };
}

function assertServerPolicy(
    policy: RallarAiGenerationPolicy,
    provider: RallarAiJsonProvider,
): void {
    if (policy.mode === 'disabled') {
        throw new RallarAiError('disabled', 'RallarAI server generation is disabled.');
    }
    if (policy.mode === 'browser-only') {
        throw new RallarAiError(
            'provider-target-mismatch',
            'RallarAI server facade cannot run browser-only generation.',
        );
    }
    if (!providerCanRunOnTarget(provider.capabilities, 'server')) {
        throw new RallarAiError(
            'provider-target-mismatch',
            `RallarAI provider cannot run on the server target: ${provider.providerId}.`,
        );
    }
    if (!provider.capabilities.supportsJsonSchema) {
        throw new RallarAiError(
            'provider-unavailable',
            `RallarAI provider does not advertise JSON schema support: ${provider.providerId}.`,
        );
    }
}

function assertRequestShape(request: RallarAiJsonRequest): void {
    if (!isRallarAiJsonRequest(request)) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI generation request is not valid.',
        );
    }
}

function assertRequestWithinLimits(
    request: RallarAiJsonRequest,
    limits: Required<RallarServerAiLimits>,
): void {
    const requestBytes = byteLength({
        ...request,
        signal: undefined,
    });
    if (requestBytes > limits.maxRequestBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI request exceeded ${limits.maxRequestBytes} bytes.`,
        );
    }
    if (byteLength(request.prompt) > limits.maxPromptBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI prompt exceeded ${limits.maxPromptBytes} bytes.`,
        );
    }
    if (byteLength(request.schema) > limits.maxSchemaBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI schema exceeded ${limits.maxSchemaBytes} bytes.`,
        );
    }
    if (
        request.context !== undefined &&
        byteLength(request.context) > limits.maxContextBytes
    ) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI context exceeded ${limits.maxContextBytes} bytes.`,
        );
    }
}

async function generateWithTimeout<TValue, TContext>(
    provider: RallarAiJsonProvider,
    request: RallarAiJsonRequest<TContext>,
    timeoutMs?: number,
): Promise<RallarAiJsonResult<TValue>> {
    if (timeoutMs === undefined) {
        return await provider.generateJson<TValue, TContext>(request);
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', abortFromRequest, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(new RallarAiError(
            'provider-timeout',
            `RallarAI server generation timed out after ${timeoutMs}ms.`,
        ));
    }, timeoutMs);

    try {
        return await provider.generateJson<TValue, TContext>({
            ...request,
            signal: controller.signal,
            timeoutMs,
        });
    } catch (error) {
        if (controller.signal.reason instanceof RallarAiError) {
            throw controller.signal.reason;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abortFromRequest);
    }
}

function toResultBroadcastMessage<TValue>(
    input: RallarServerAiBroadcastInput<TValue>,
    senderId: string,
    target: RallarServerAiBroadcastTarget = normalizeBroadcastTarget(input),
): ALMessage {
    const contextId = target.scope === 'room'
        ? target.groupRef.groupId
        : target.scope;
    return newALBroadcastMessage(
        senderId,
        newALRoute(
            input.topicId ?? DEFAULT_AI_RESULT_TOPIC_ID,
            contextId,
            input.resourceId ?? input.result.generationId,
        ),
        target.scope,
        input.typeId ?? DEFAULT_AI_RESULT_TYPE_ID,
        input.result,
        {
            groupRef: target.scope === 'room' ? target.groupRef : undefined,
            reliability: 'at-least-once',
            ack: 'receiver',
        },
    );
}

type RallarServerAiBroadcastTarget =
    | Readonly<{
        scope: 'room';
        groupRef: GroupRef;
    }>
    | Readonly<{
        scope: 'world' | 'all';
    }>;

function normalizeBroadcastTarget<TValue>(
    input: RallarServerAiBroadcastInput<TValue>,
): RallarServerAiBroadcastTarget {
    const scope = input.scope ?? 'room';
    if (scope !== 'room') {
        return { scope };
    }

    return {
        scope,
        groupRef: requireCompleteGroupRef(input.roomRef),
    };
}

function requireCompleteGroupRef(value: unknown): GroupRef {
    if (
        !isRecord(value) ||
        typeof value.applicationId !== 'string' ||
        value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' ||
        value.workspaceId.length === 0 ||
        typeof value.groupId !== 'string' ||
        value.groupId.length === 0
    ) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI room broadcast requires a complete GroupRef.',
        );
    }

    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId,
    };
}

async function emitFailureDiagnostic(
    sink: RallarAiDiagnosticsSink | undefined,
    error: unknown,
    input: Omit<
        Parameters<typeof createRallarAiDiagnosticEvent>[1],
        'errorCode' | 'message'
    >,
): Promise<void> {
    const aiError = error instanceof RallarAiError ? error : undefined;
    await emitRallarAiDiagnostic(
        sink,
        createRallarAiDiagnosticEvent(toGenerationFailureKind(aiError), {
            ...input,
            validationOk: false,
            errorCode: aiError?.code ?? 'provider-failed',
            message: error instanceof Error ? error.message : String(error),
        }),
    );
}

function toGenerationFailureKind(
    error: RallarAiError | undefined,
): RallarAiDiagnosticEventKind {
    if (error?.code === 'provider-timeout') {
        return 'provider-timed-out';
    }
    if (error?.code === 'provider-cancelled') {
        return 'provider-cancelled';
    }
    if (error?.code === 'schema-validation-failed') {
        return 'schema-validation-failed';
    }
    return 'provider-failed';
}

function isRallarAiJsonRequest(value: unknown): value is RallarAiJsonRequest {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.schemaId === 'string' &&
        value.schemaId.length > 0 &&
        typeof value.schemaVersion === 'string' &&
        value.schemaVersion.length > 0 &&
        typeof value.prompt === 'string' &&
        'schema' in value &&
        optionalString(value.requestId) &&
        optionalString(value.baseStateRevision) &&
        optionalString(value.dedupeKey) &&
        optionalNumber(value.maxOutputTokens) &&
        optionalNumber(value.temperature) &&
        optionalNumber(value.timeoutMs);
}

function optionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): boolean {
    return value === undefined || typeof value === 'number';
}

function byteLength(value: unknown): number {
    return new TextEncoder().encode(
        typeof value === 'string' ? value : JSON.stringify(value),
    ).length;
}

function jsonHeaders(): Readonly<Record<string, string>> {
    return {
        'content-type': 'application/json',
    };
}

function toRestError<TValue = unknown>(
    error: unknown,
): RallarServerAiRestGenerateResponse<TValue> {
    const aiError = error instanceof RallarAiError
        ? error
        : new RallarAiError(
            'provider-failed',
            error instanceof Error ? error.message : String(error),
        );
    return {
        status: toHttpStatus(aiError.code),
        headers: jsonHeaders(),
        body: {
            ok: false,
            error: {
                code: aiError.code,
                message: aiError.message,
            },
        },
    };
}

function toHttpStatus(code: string): number {
    switch (code) {
        case 'invalid-json':
        case 'invalid-configuration':
        case 'provider-target-mismatch':
            return 400;
        case 'unauthorized':
            return 403;
        case 'disabled':
        case 'provider-unavailable':
            return 503;
        case 'request-too-large':
            return 413;
        case 'quota-exceeded':
            return 429;
        case 'schema-validation-failed':
            return 422;
        case 'provider-timeout':
            return 504;
        default:
            return 502;
    }
}

async function handleRestInvocation<TValue>(
    request: unknown,
    response: unknown,
    routeOptions: RallarServerAiRestRouteOptions,
    generate: (
        input: RallarServerAiRestValidatedGenerateInput,
    ) => Promise<RallarAiJsonResult<TValue>>,
): Promise<RallarServerAiRestGenerateResponse<TValue>> {
    const body = routeOptions.readBody
        ? await routeOptions.readBody(request)
        : await defaultReadBody(request);
    if (!isRallarAiJsonRequest(body)) {
        return toRestError(
            new RallarAiError(
                'invalid-json',
                'RallarAI REST generation body must be a JSON request.',
            ),
        ) as RallarServerAiRestGenerateResponse<TValue>;
    }

    try {
        return {
            status: 200,
            headers: jsonHeaders(),
            body: {
                ok: true,
                result: await generate({
                    body,
                    actorId: routeOptions.readActorId?.(request) ??
                        readActorIdFromRequest(request, response),
                    roomId: routeOptions.readRoomId?.(request) ??
                        readRoomIdFromRequest(request),
                }),
            },
        };
    } catch (error) {
        return toRestError(error) as RallarServerAiRestGenerateResponse<TValue>;
    }
}

async function defaultReadBody(request: unknown): Promise<unknown> {
    if (isRecord(request) && 'body' in request) {
        return request.body;
    }
    if (isRecord(request) && typeof request.json === 'function') {
        return await request.json();
    }
    return request;
}

function writeRestResponse(
    response: unknown,
    restResponse: RallarServerAiRestGenerateResponse,
): unknown {
    if (isRecord(response) && typeof response.status === 'function') {
        const statusResult = response.status(restResponse.status);
        if (isRecord(statusResult) && typeof statusResult.json === 'function') {
            return statusResult.json(restResponse.body);
        }
    }
    if (isRecord(response) && typeof response.json === 'function') {
        if (typeof response.statusCode === 'number') {
            response.statusCode = restResponse.status;
        }
        return response.json(restResponse.body);
    }
    if (typeof Response !== 'undefined') {
        return new Response(JSON.stringify(restResponse.body), {
            status: restResponse.status,
            headers: restResponse.headers,
        });
    }
    return restResponse;
}

function readActorIdFromRequest(
    request: unknown,
    response: unknown,
): string | undefined {
    return readStringPath(request, ['actorId']) ??
        readStringPath(request, ['user', 'id']) ??
        readStringPath(request, ['auth', 'actorId']) ??
        readStringPath(response, ['locals', 'actorId']) ??
        readStringPath(response, ['locals', 'user', 'id']);
}

function readRoomIdFromRequest(request: unknown): string | undefined {
    return readStringPath(request, ['roomId']) ??
        readStringPath(request, ['params', 'roomId']) ??
        readStringPath(request, ['query', 'roomId']);
}

function readStringPath(
    value: unknown,
    path: readonly string[],
): string | undefined {
    let current = value;
    for (const segment of path) {
        if (!isRecord(current)) {
            return undefined;
        }
        current = current[segment];
    }
    return typeof current === 'string' ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}
