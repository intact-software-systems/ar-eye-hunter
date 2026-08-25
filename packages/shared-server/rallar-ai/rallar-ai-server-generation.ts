import {
    assertRallarAiAuthorized,
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    providerCanRunOnTarget,
    RallarAiError,
    type RallarAiDiagnosticEventKind,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type {
    CreateRallarServerAiOptions,
    RallarServerAiFacade,
    RallarServerAiLimits,
    RallarServerAiRequestContext
} from './rallar-ai-server.ts';
import type { RallarServerAiBoundaryValue } from './rallar-server-ai-boundary-value.ts';

interface CreateRallarServerAiGenerationInput {
    readonly provider: RallarAiJsonProvider;
    readonly policy: RallarAiGenerationPolicy;
    readonly authorize: CreateRallarServerAiOptions['authorize'];
    readonly diagnostics: CreateRallarServerAiOptions['diagnostics'];
    readonly redactRequest: CreateRallarServerAiOptions['redactRequest'];
    readonly limits: Required<RallarServerAiLimits>;
}

interface ValidateAndReportGenerationResultInput<TValue extends RallarAiJsonValue> {
    readonly generation: CreateRallarServerAiGenerationInput;
    readonly request: RallarAiJsonRequest;
    readonly result: RallarAiJsonResult<TValue>;
    readonly startedAtEpochMs: number;
}

interface EmitFailureDiagnosticInput {
    readonly generation: CreateRallarServerAiGenerationInput;
    readonly request: RallarAiJsonRequest;
    readonly error: Error;
    readonly startedAtEpochMs: number;
}

export function createRallarServerAiGeneration(
    input: CreateRallarServerAiGenerationInput
): RallarServerAiFacade['generateJson'] {
    let activeGenerations = 0;

    return async <TValue extends RallarAiJsonValue = RallarAiJsonValue>(
        request: RallarAiJsonRequest,
        context: RallarServerAiRequestContext = {}
    ): Promise<RallarAiJsonResult<TValue>> => {
        assertServerPolicy(input.policy, input.provider);
        assertRequestShape(request);
        assertRequestWithinLimits(request, input.limits);
        await assertRallarAiAuthorized(input.authorize, {
            actorId: context.actorId,
            roomId: context.roomId,
            action: 'generate',
            source: 'server',
            schemaId: request.schemaId,
            schemaVersion: request.schemaVersion
        });

        if (activeGenerations >= input.limits.maxConcurrentGenerations) {
            throw new RallarAiError(
                'quota-exceeded',
                'RallarAI server generation concurrency quota was exceeded.'
            );
        }

        activeGenerations += 1;
        const providerRequest = input.redactRequest
            ? input.redactRequest(request, context)
            : request;
        const startedAtEpochMs = Date.now();

        try {
            await emitGenerationStarted(input, request);
            const result = await generateWithTimeout<TValue>(
                input.provider,
                providerRequest,
                input.policy.timeoutMs ?? request.timeoutMs
            );
            await validateAndReportGenerationResult({
                generation: input,
                request,
                result,
                startedAtEpochMs
            });
            return result;
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            await emitFailureDiagnostic({
                generation: input,
                request,
                error: cause,
                startedAtEpochMs
            });
            throw error;
        }
        finally {
            activeGenerations -= 1;
        }
    };
}

async function emitGenerationStarted(
    input: CreateRallarServerAiGenerationInput,
    request: RallarAiJsonRequest
): Promise<void> {
    for (const kind of ['generation-requested', 'provider-started'] as const) {
        await emitRallarAiDiagnostic(
            input.diagnostics,
            createRallarAiDiagnosticEvent(kind, {
                requestId: request.requestId,
                providerId: input.provider.providerId,
                modelId: input.provider.modelId,
                schemaId: request.schemaId,
                schemaVersion: request.schemaVersion,
                source: input.provider.source
            })
        );
    }
}

async function validateAndReportGenerationResult<TValue extends RallarAiJsonValue>(
    input: ValidateAndReportGenerationResultInput<TValue>
): Promise<void> {
    const { generation, request, result, startedAtEpochMs } = input;
    if (!result.validation.ok) {
        await emitRallarAiDiagnostic(
            generation.diagnostics,
            createRallarAiDiagnosticEvent('schema-validation-failed', {
                generationId: result.generationId,
                requestId: result.requestId,
                providerId: result.providerId,
                modelId: result.modelId,
                schemaId: result.schemaId,
                schemaVersion: result.schemaVersion,
                schemaHash: result.schemaHash,
                source: result.source,
                validationOk: false
            })
        );
        throw new RallarAiError(
            'schema-validation-failed',
            'RallarAI server provider returned JSON that failed schema validation.',
            result.validation
        );
    }

    await emitRallarAiDiagnostic(
        generation.diagnostics,
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
}

function assertServerPolicy(
    policy: RallarAiGenerationPolicy,
    provider: RallarAiJsonProvider
): void {
    if (policy.mode === 'disabled') {
        throw new RallarAiError('disabled', 'RallarAI server generation is disabled.');
    }
    if (policy.mode === 'browser-only') {
        throw new RallarAiError(
            'provider-target-mismatch',
            'RallarAI server facade cannot run browser-only generation.'
        );
    }
    if (!providerCanRunOnTarget(provider.capabilities, 'server')) {
        throw new RallarAiError(
            'provider-target-mismatch',
            `RallarAI provider cannot run on the server target: ${provider.providerId}.`
        );
    }
    if (!provider.capabilities.supportsJsonSchema) {
        throw new RallarAiError(
            'provider-unavailable',
            `RallarAI provider does not advertise JSON schema support: ${provider.providerId}.`
        );
    }
}

function assertRequestShape(request: RallarAiJsonRequest): void {
    if (!isRallarAiJsonRequest(request)) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI generation request is not valid.'
        );
    }
}

function assertRequestWithinLimits(
    request: RallarAiJsonRequest,
    limits: Required<RallarServerAiLimits>
): void {
    const requestBytes = byteLength({ ...request, signal: undefined });
    if (requestBytes > limits.maxRequestBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI request exceeded ${limits.maxRequestBytes} bytes.`
        );
    }
    if (byteLength(request.prompt) > limits.maxPromptBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI prompt exceeded ${limits.maxPromptBytes} bytes.`
        );
    }
    if (byteLength(request.schema) > limits.maxSchemaBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI schema exceeded ${limits.maxSchemaBytes} bytes.`
        );
    }
    if (request.context !== undefined && byteLength(request.context) > limits.maxContextBytes) {
        throw new RallarAiError(
            'request-too-large',
            `RallarAI context exceeded ${limits.maxContextBytes} bytes.`
        );
    }
}

async function generateWithTimeout<TValue extends RallarAiJsonValue>(
    provider: RallarAiJsonProvider,
    request: RallarAiJsonRequest,
    timeoutMs?: number
): Promise<RallarAiJsonResult<TValue>> {
    if (timeoutMs === undefined) {
        return await provider.generateJson<TValue>(request);
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', abortFromRequest, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(
            new RallarAiError(
                'provider-timeout',
                `RallarAI server generation timed out after ${timeoutMs}ms.`
            )
        );
    }, timeoutMs);

    try {
        return await provider.generateJson<TValue>({
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

async function emitFailureDiagnostic(
    input: EmitFailureDiagnosticInput
): Promise<void> {
    const { generation, request, error, startedAtEpochMs } = input;
    const aiError = error instanceof RallarAiError ? error : undefined;
    await emitRallarAiDiagnostic(
        generation.diagnostics,
        createRallarAiDiagnosticEvent(toGenerationFailureKind(aiError), {
            requestId: request.requestId,
            providerId: generation.provider.providerId,
            modelId: generation.provider.modelId,
            schemaId: request.schemaId,
            schemaVersion: request.schemaVersion,
            source: generation.provider.source,
            elapsedMs: Date.now() - startedAtEpochMs,
            validationOk: false,
            errorCode: aiError?.code ?? 'provider-failed',
            message: error.message
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

export function isRallarAiJsonRequest(
    value: RallarServerAiBoundaryValue
): value is RallarAiJsonRequest<RallarServerAiBoundaryValue> {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.schemaId === 'string' && value.schemaId.length > 0 &&
        typeof value.schemaVersion === 'string' && value.schemaVersion.length > 0 &&
        typeof value.prompt === 'string' && 'schema' in value &&
        optionalString(value.requestId) && optionalString(value.baseStateRevision) &&
        optionalString(value.dedupeKey) && optionalNumber(value.maxOutputTokens) &&
        optionalNumber(value.temperature) && optionalNumber(value.timeoutMs);
}

function optionalString(value: RallarServerAiBoundaryValue): boolean {
    return value === undefined || typeof value === 'string';
}

function optionalNumber(value: RallarServerAiBoundaryValue): boolean {
    return value === undefined || typeof value === 'number';
}

function byteLength(value: RallarAiJsonRequest['schema']): number {
    return new TextEncoder().encode(
        typeof value === 'string' ? value : JSON.stringify(value)
    ).length;
}

function isRecord(
    value: RallarServerAiBoundaryValue
): value is Record<string, RallarServerAiBoundaryValue> {
    return value !== null && typeof value === 'object';
}
