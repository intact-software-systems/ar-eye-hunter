import {
    assertRallarAiAuthorized,
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    RallarAiError,
    type RallarAiDiagnosticEventKind,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import { decodeJsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import type { RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';
import type {
    CreateRallarServerAiInput,
    RallarServerAi,
    RallarServerAiRequestContext
} from './rallar-server-ai-contracts.ts';
import {
    toRallarServerAiProviderPolicyError,
    toRallarServerAiRequestLimitError
} from './rallar-server-ai-generation-policy.ts';
import { generateRallarServerAiProviderResult } from './rallar-server-ai-provider-timeout.ts';

interface ReportRallarServerAiResultInput {
    readonly generation: CreateRallarServerAiInput;
    readonly request: RallarServerAiJsonRequest;
    readonly result: RallarAiJsonResult<RallarAiJsonValue>;
    readonly startedAtEpochMs: number;
}

interface ReportRallarServerAiFailureInput {
    readonly generation: CreateRallarServerAiInput;
    readonly request: RallarServerAiJsonRequest;
    readonly error: Error;
    readonly startedAtEpochMs: number;
}

export function createRallarServerAiGeneration(
    generation: CreateRallarServerAiInput
): RallarServerAi['generateJson'] {
    let activeGenerationCount = 0;

    return async (
        request: RallarServerAiJsonRequest,
        context: RallarServerAiRequestContext = {}
    ): Promise<RallarAiJsonResult<RallarAiJsonValue>> => {
        const policyError = toRallarServerAiProviderPolicyError(
            generation.policy,
            generation.provider
        );
        if (policyError !== undefined) {
            throw policyError;
        }
        const limitError = toRallarServerAiRequestLimitError(request, generation.limits);
        if (limitError !== undefined) {
            throw limitError;
        }
        await assertRallarAiAuthorized(generation.authorize, {
            actorId: context.actorId,
            roomId: context.roomId,
            action: 'generate',
            source: 'server',
            schemaId: request.schemaId,
            schemaVersion: request.schemaVersion
        });

        if (activeGenerationCount >= generation.limits.maxConcurrentGenerations) {
            throw new RallarAiError(
                'quota-exceeded',
                'RallarAI server generation concurrency quota was exceeded.'
            );
        }

        activeGenerationCount += 1;
        const providerRequest = generation.redactRequest
            ? generation.redactRequest(request, context)
            : request;
        const startedAtEpochMs = Date.now();

        try {
            await reportGenerationStarted(generation, request);
            const result = await generateRallarServerAiProviderResult({
                provider: generation.provider,
                request: providerRequest,
                timeoutMs: generation.policy.timeoutMs ?? request.timeoutMs
            });
            await reportGenerationResult({
                generation,
                request,
                result,
                startedAtEpochMs
            });
            return result;
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            await reportGenerationFailure({
                generation,
                request,
                error: cause,
                startedAtEpochMs
            });
            throw cause;
        }
        finally {
            activeGenerationCount -= 1;
        }
    };
}

async function reportGenerationStarted(
    generation: CreateRallarServerAiInput,
    request: RallarServerAiJsonRequest
): Promise<void> {
    for (const kind of ['generation-requested', 'provider-started'] as const) {
        await emitRallarAiDiagnostic(
            generation.diagnostics,
            createRallarAiDiagnosticEvent(kind, {
                requestId: request.requestId,
                providerId: generation.provider.providerId,
                modelId: generation.provider.modelId,
                schemaId: request.schemaId,
                schemaVersion: request.schemaVersion,
                source: generation.provider.source
            })
        );
    }
}

async function reportGenerationResult(
    input: ReportRallarServerAiResultInput
): Promise<void> {
    requireJsonProviderResult(input.result);
    if (!input.result.validation.ok) {
        await emitRallarAiDiagnostic(
            input.generation.diagnostics,
            createRallarAiDiagnosticEvent('schema-validation-failed', {
                generationId: input.result.generationId,
                requestId: input.result.requestId,
                providerId: input.result.providerId,
                modelId: input.result.modelId,
                schemaId: input.result.schemaId,
                schemaVersion: input.result.schemaVersion,
                schemaHash: input.result.schemaHash,
                source: input.result.source,
                validationOk: false
            })
        );
        throw new RallarAiError(
            'schema-validation-failed',
            'RallarAI server provider returned JSON that failed schema validation.',
            input.result.validation
        );
    }

    await emitRallarAiDiagnostic(
        input.generation.diagnostics,
        createRallarAiDiagnosticEvent('provider-completed', {
            generationId: input.result.generationId,
            requestId: input.result.requestId,
            providerId: input.result.providerId,
            modelId: input.result.modelId,
            schemaId: input.result.schemaId,
            schemaVersion: input.result.schemaVersion,
            schemaHash: input.result.schemaHash,
            source: input.result.source,
            validationOk: true,
            elapsedMs: Date.now() - input.startedAtEpochMs
        })
    );
}

function requireJsonProviderResult(
    result: RallarAiJsonResult<RallarAiJsonValue>
): void {
    try {
        decodeJsonWireValue(result.value, 'RallarAI provider result');
    }
    catch (error) {
        throw new RallarAiError(
            'invalid-json',
            'RallarAI server provider returned a value that is not JSON-safe.',
            error instanceof Error ? error.message : String(error)
        );
    }
}

async function reportGenerationFailure(
    input: ReportRallarServerAiFailureInput
): Promise<void> {
    const aiError = input.error instanceof RallarAiError ? input.error : undefined;
    await emitRallarAiDiagnostic(
        input.generation.diagnostics,
        createRallarAiDiagnosticEvent(toGenerationFailureKind(aiError), {
            requestId: input.request.requestId,
            providerId: input.generation.provider.providerId,
            modelId: input.generation.provider.modelId,
            schemaId: input.request.schemaId,
            schemaVersion: input.request.schemaVersion,
            source: input.generation.provider.source,
            elapsedMs: Date.now() - input.startedAtEpochMs,
            validationOk: false,
            errorCode: aiError?.code ?? 'provider-failed',
            message: input.error.message
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
