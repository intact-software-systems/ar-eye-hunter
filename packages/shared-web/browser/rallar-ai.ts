import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    providerCanRunOnTarget,
    RallarAiError,
    type RallarAiDiagnosticEventKind,
    type RallarAiDiagnosticsSink,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import type { RallarDataDurability, RallarDataScope } from './rallar-data.ts';
import type { RallarFacade, RallarMessageSendResult, RallarRealtimeSendResult } from './rallar.ts';

export type RallarBrowserAiTransport =
    | 'realtime'
    | 'messages.rtc'
    | 'messages.ws';

export type RallarBrowserAiRallar = Pick<RallarFacade, 'data' | 'messages' | 'realtime'>;

export type CreateRallarBrowserAiOptions = Readonly<{
    rallar: RallarBrowserAiRallar;
    provider: RallarAiJsonProvider;
    policy?: RallarAiGenerationPolicy;
    diagnostics?: RallarAiDiagnosticsSink;
    readCurrentStateRevision?: (
        request: RallarAiJsonRequest
    ) => string | undefined;
}>;

export type RallarBrowserAiBroadcastInput<TValue = unknown> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    transport?: RallarBrowserAiTransport;
    laneId?: string;
    roomId?: string;
    roomRef?: GroupRef;
    topicId?: string;
    typeId?: string;
}>;

export type RallarBrowserAiBroadcastResult = Readonly<{
    transport: RallarBrowserAiTransport;
    realtime?: readonly RallarRealtimeSendResult[];
    message?: RallarMessageSendResult;
}>;

export type RallarBrowserAiPersistInput<TValue = unknown> = Readonly<{
    result: RallarAiJsonResult<TValue>;
    storeName?: string;
    key?: string;
    scope?: RallarDataScope;
    durability?: RallarDataDurability;
}>;

export type RallarBrowserAiFacade = Readonly<{
    generateJson<TValue = unknown, TContext = unknown>(
        request: RallarAiJsonRequest<TContext>
    ): Promise<RallarAiJsonResult<TValue>>;
    broadcastJson<TValue = unknown>(
        input: RallarBrowserAiBroadcastInput<TValue>
    ): Promise<RallarBrowserAiBroadcastResult>;
    persistJson<TValue = unknown>(
        input: RallarBrowserAiPersistInput<TValue>
    ): Promise<void>;
}>;

const DEFAULT_BROWSER_AI_POLICY: RallarAiGenerationPolicy = {
    mode: 'browser-only',
    staleResultMode: 'reject'
};

const DEFAULT_AI_RESULT_TOPIC_ID = 'room.ai';
const DEFAULT_AI_RESULT_TYPE_ID = 'generated';
const DEFAULT_AI_RESULT_LANE_ID = 'rallar-ai';
const DEFAULT_AI_RESULT_STORE_NAME = 'rallar-ai-results';

export function createRallarBrowserAi(
    options: CreateRallarBrowserAiOptions
): RallarBrowserAiFacade {
    const policy = options.policy ?? DEFAULT_BROWSER_AI_POLICY;

    return {
        generateJson: async <TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> => {
            assertBrowserPolicy(policy, options.provider);
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('generation-requested', {
                    requestId: request.requestId,
                    providerId: options.provider.providerId,
                    modelId: options.provider.modelId,
                    schemaId: request.schemaId,
                    schemaVersion: request.schemaVersion,
                    source: options.provider.source
                })
            );

            const startedAtEpochMs = Date.now();
            await emitRallarAiDiagnostic(
                options.diagnostics,
                createRallarAiDiagnosticEvent('provider-started', {
                    requestId: request.requestId,
                    providerId: options.provider.providerId,
                    modelId: options.provider.modelId,
                    schemaId: request.schemaId,
                    schemaVersion: request.schemaVersion,
                    source: options.provider.source
                })
            );

            let result: RallarAiJsonResult<TValue>;
            try {
                result = await generateWithTimeout<TValue, TContext>(
                    options.provider,
                    request,
                    policy.timeoutMs ?? request.timeoutMs
                );
            }
            catch (error) {
                await emitGenerationFailureDiagnostic(
                    options.diagnostics,
                    error,
                    {
                        requestId: request.requestId,
                        providerId: options.provider.providerId,
                        modelId: options.provider.modelId,
                        schemaId: request.schemaId,
                        schemaVersion: request.schemaVersion,
                        source: options.provider.source,
                        elapsedMs: Date.now() - startedAtEpochMs
                    }
                );
                throw error;
            }

            assertFreshResult(options, request);
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
                    elapsedMs: Date.now() - startedAtEpochMs
                })
            );

            return result;
        },
        broadcastJson: async <TValue = unknown>(
            input: RallarBrowserAiBroadcastInput<TValue>
        ): Promise<RallarBrowserAiBroadcastResult> => {
            const transport = input.transport ?? 'realtime';
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
                    validationOk: input.result.validation.ok
                })
            );

            try {
                const broadcastResult = await broadcastWithTransport(
                    options.rallar,
                    input,
                    transport
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
                        validationOk: input.result.validation.ok
                    })
                );
                return broadcastResult;
            }
            catch (error) {
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
                        message: error instanceof Error ? error.message : String(error)
                    })
                );
                throw error;
            }
        },
        persistJson: async <TValue = unknown>(
            input: RallarBrowserAiPersistInput<TValue>
        ): Promise<void> => {
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
                    validationOk: input.result.validation.ok
                })
            );

            try {
                const store = await options.rallar.data.open<RallarAiJsonResult<TValue>>(
                    input.storeName ?? DEFAULT_AI_RESULT_STORE_NAME,
                    {
                        scope: input.scope ?? 'session',
                        durability: input.durability ?? 'write-behind',
                        schemaVersion: 1
                    }
                );
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
                        validationOk: input.result.validation.ok
                    })
                );
            }
            catch (error) {
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
                        errorCode: 'provider-failed',
                        message: error instanceof Error ? error.message : String(error)
                    })
                );
                throw error;
            }
        }
    };
}

function assertBrowserPolicy(
    policy: RallarAiGenerationPolicy,
    provider: RallarAiJsonProvider
): void {
    if (policy.mode === 'disabled') {
        throw new RallarAiError('disabled', 'RallarAI browser generation is disabled.');
    }
    if (policy.mode === 'server-only') {
        throw new RallarAiError(
            'provider-target-mismatch',
            'RallarAI browser facade cannot run server-only generation.'
        );
    }
    if (!providerCanRunOnTarget(provider.capabilities, 'browser')) {
        throw new RallarAiError(
            'provider-target-mismatch',
            `RallarAI browser facade cannot run provider ${provider.providerId} because it targets ${provider.capabilities.target}.`
        );
    }
}

function assertFreshResult(
    options: CreateRallarBrowserAiOptions,
    request: RallarAiJsonRequest
): void {
    if ((options.policy?.staleResultMode ?? 'reject') !== 'reject') {
        return;
    }
    if (!request.baseStateRevision || !options.readCurrentStateRevision) {
        return;
    }
    const current = options.readCurrentStateRevision(request);
    if (current !== undefined && current !== request.baseStateRevision) {
        throw new RallarAiError(
            'stale-result',
            'RallarAI browser generation result is stale.',
            {
                baseStateRevision: request.baseStateRevision,
                currentStateRevision: current
            }
        );
    }
}

async function generateWithTimeout<TValue, TContext>(
    provider: RallarAiJsonProvider,
    request: RallarAiJsonRequest<TContext>,
    timeoutMs?: number
): Promise<RallarAiJsonResult<TValue>> {
    if (timeoutMs === undefined) {
        return await provider.generateJson<TValue, TContext>(request);
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', abortFromRequest, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(
            new RallarAiError(
                'provider-timeout',
                `RallarAI browser generation timed out after ${timeoutMs}ms.`
            )
        );
    }, timeoutMs);

    try {
        return await provider.generateJson<TValue, TContext>({
            ...request,
            signal: controller.signal,
            timeoutMs
        });
    }
    catch (error) {
        if (controller.signal.reason instanceof RallarAiError) {
            throw controller.signal.reason;
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abortFromRequest);
    }
}

async function emitGenerationFailureDiagnostic(
    sink: RallarAiDiagnosticsSink | undefined,
    error: unknown,
    input: Omit<Parameters<typeof createRallarAiDiagnosticEvent>[1], 'errorCode' | 'message'>
): Promise<void> {
    const aiError = error instanceof RallarAiError ? error : undefined;
    await emitRallarAiDiagnostic(
        sink,
        createRallarAiDiagnosticEvent(toGenerationFailureKind(aiError), {
            ...input,
            validationOk: false,
            errorCode: aiError?.code ?? 'provider-failed',
            message: error instanceof Error ? error.message : String(error)
        })
    );
}

function toGenerationFailureKind(
    error: RallarAiError | undefined
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

async function broadcastWithTransport<TValue>(
    rallar: RallarBrowserAiRallar,
    input: RallarBrowserAiBroadcastInput<TValue>,
    transport: RallarBrowserAiTransport
): Promise<RallarBrowserAiBroadcastResult> {
    if (transport === 'realtime') {
        return {
            transport,
            realtime: await rallar.realtime.sendJson({
                data: input.result,
                laneId: input.laneId ?? DEFAULT_AI_RESULT_LANE_ID,
                roomId: input.roomId,
                roomRef: input.roomRef
            })
        };
    }

    const messageInput = {
        topicId: input.topicId ?? DEFAULT_AI_RESULT_TOPIC_ID,
        typeId: input.typeId ?? DEFAULT_AI_RESULT_TYPE_ID,
        payload: input.result,
        scope: 'room' as const,
        roomId: input.roomId,
        roomRef: input.roomRef
    };

    return {
        transport,
        message: transport === 'messages.ws'
            ? await rallar.messages.ws.send(messageInput)
            : await rallar.messages.rtc.send(messageInput)
    };
}
