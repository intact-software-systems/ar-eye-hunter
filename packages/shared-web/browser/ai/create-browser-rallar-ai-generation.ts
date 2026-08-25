import {
    emitBrowserRallarAiGenerationFailed,
    emitBrowserRallarAiProviderCompleted,
    emitBrowserRallarAiProviderStarted
} from '@shared-web/browser/ai/browser-rallar-ai-diagnostics.ts';
import {
    assertBrowserRallarAiGenerationAllowed,
    assertBrowserRallarAiResultIsFresh
} from '@shared-web/browser/ai/browser-rallar-ai-generation-policy.ts';
import type { CreateRallarBrowserAiOptions, RallarBrowserAiFacade } from '@shared-web/browser/rallar-ai.ts';
import {
    RallarAiError,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';

/** Owns one browser provider request from policy checks through completion. */
export function createBrowserRallarAiGeneration(
    options: CreateRallarBrowserAiOptions,
    policy: RallarAiGenerationPolicy
): RallarBrowserAiFacade['generateJson'] {
    return async <TValue, TContext>(
        request: RallarAiJsonRequest<TContext>
    ): Promise<RallarAiJsonResult<TValue>> => {
        assertBrowserRallarAiGenerationAllowed(policy, options.provider);
        await emitBrowserRallarAiProviderStarted({
            sink: options.diagnostics,
            kind: 'generation-requested',
            request,
            provider: options.provider
        });

        const startedAtEpochMs = Date.now();
        await emitBrowserRallarAiProviderStarted({
            sink: options.diagnostics,
            kind: 'provider-started',
            request,
            provider: options.provider
        });

        let result: RallarAiJsonResult<TValue>;
        try {
            result = await generateWithTimeout<TValue, TContext>(
                options.provider,
                request,
                policy.timeoutMs ?? request.timeoutMs
            );
        }
        catch (error) {
            await emitBrowserRallarAiGenerationFailed({
                sink: options.diagnostics,
                error: error instanceof Error
                    ? error
                    : new Error(String(error)),
                request,
                provider: options.provider,
                elapsedMs: Date.now() - startedAtEpochMs
            });
            throw error;
        }

        assertBrowserRallarAiResultIsFresh(options, request);
        await emitBrowserRallarAiProviderCompleted(
            options.diagnostics,
            result,
            Date.now() - startedAtEpochMs
        );
        return result;
    };
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
