import {
    createRallarAiDiagnosticEvent,
    emitRallarAiDiagnostic,
    RallarAiError,
    type RallarAiDiagnosticEventKind,
    type RallarAiDiagnosticsSink,
    type RallarAiErrorCode,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
    type RallarAiJsonSource
} from '@shared/rallar-ai/mod.ts';

interface EmitBrowserRallarAiProviderStartedInput {
    readonly sink: RallarAiDiagnosticsSink | undefined;
    readonly kind: 'generation-requested' | 'provider-started';
    readonly request: RallarAiJsonRequest;
    readonly provider: RallarAiJsonProvider;
}

interface EmitBrowserRallarAiGenerationFailedInput {
    readonly sink: RallarAiDiagnosticsSink | undefined;
    readonly error: Error;
    readonly request: RallarAiJsonRequest;
    readonly provider: RallarAiJsonProvider;
    readonly elapsedMs: number;
}

interface EmitBrowserRallarAiResultDiagnosticInput {
    readonly sink: RallarAiDiagnosticsSink | undefined;
    readonly kind: Extract<
        RallarAiDiagnosticEventKind,
        | 'envelope-broadcast-started'
        | 'envelope-broadcast-completed'
        | 'envelope-broadcast-failed'
        | 'envelope-persistence-started'
        | 'envelope-persistence-completed'
        | 'envelope-persistence-failed'
    >;
    readonly result: RallarAiJsonResult;
    readonly failure?: Readonly<{
        errorCode: RallarAiErrorCode;
        message: string;
    }>;
}

interface BrowserRallarAiResultDiagnosticDetails {
    readonly generationId: string;
    readonly requestId?: string;
    readonly providerId: string;
    readonly modelId?: string;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaHash: string;
    readonly source: RallarAiJsonSource;
    readonly validationOk: boolean;
}

export async function emitBrowserRallarAiProviderStarted(
    input: EmitBrowserRallarAiProviderStartedInput
): Promise<void> {
    await emitRallarAiDiagnostic(
        input.sink,
        createRallarAiDiagnosticEvent(input.kind, {
            requestId: input.request.requestId,
            providerId: input.provider.providerId,
            modelId: input.provider.modelId,
            schemaId: input.request.schemaId,
            schemaVersion: input.request.schemaVersion,
            source: input.provider.source
        })
    );
}

export async function emitBrowserRallarAiProviderCompleted(
    sink: RallarAiDiagnosticsSink | undefined,
    result: RallarAiJsonResult,
    elapsedMs: number
): Promise<void> {
    await emitRallarAiDiagnostic(
        sink,
        createRallarAiDiagnosticEvent('provider-completed', {
            ...toResultDiagnosticDetails(result),
            elapsedMs
        })
    );
}

export async function emitBrowserRallarAiGenerationFailed(
    input: EmitBrowserRallarAiGenerationFailedInput
): Promise<void> {
    const aiError = input.error instanceof RallarAiError
        ? input.error
        : undefined;
    await emitRallarAiDiagnostic(
        input.sink,
        createRallarAiDiagnosticEvent(toGenerationFailureKind(aiError), {
            requestId: input.request.requestId,
            providerId: input.provider.providerId,
            modelId: input.provider.modelId,
            schemaId: input.request.schemaId,
            schemaVersion: input.request.schemaVersion,
            source: input.provider.source,
            validationOk: false,
            elapsedMs: input.elapsedMs,
            errorCode: aiError?.code ?? 'provider-failed',
            message: input.error.message
        })
    );
}

export async function emitBrowserRallarAiResultDiagnostic(
    input: EmitBrowserRallarAiResultDiagnosticInput
): Promise<void> {
    await emitRallarAiDiagnostic(
        input.sink,
        createRallarAiDiagnosticEvent(input.kind, {
            ...toResultDiagnosticDetails(input.result),
            ...input.failure
        })
    );
}

export function toBrowserRallarAiErrorMessage(error: Error): string {
    return error.message;
}

function toResultDiagnosticDetails(
    result: RallarAiJsonResult
): BrowserRallarAiResultDiagnosticDetails {
    return {
        generationId: result.generationId,
        requestId: result.requestId,
        providerId: result.providerId,
        modelId: result.modelId,
        schemaId: result.schemaId,
        schemaVersion: result.schemaVersion,
        schemaHash: result.schemaHash,
        source: result.source,
        validationOk: result.validation.ok
    };
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
