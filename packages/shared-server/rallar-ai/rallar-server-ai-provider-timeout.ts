import {
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonResult,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';

export interface GenerateRallarServerAiProviderResultInput {
    readonly provider: RallarAiJsonProvider;
    readonly request: RallarServerAiJsonRequest;
    readonly timeoutMs?: number;
}

export async function generateRallarServerAiProviderResult(
    input: GenerateRallarServerAiProviderResultInput
): Promise<RallarAiJsonResult<RallarAiJsonValue>> {
    if (input.timeoutMs === undefined) {
        return await input.provider.generateJson<RallarAiJsonValue, RallarAiJsonValue>(input.request);
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(input.request.signal?.reason);
    input.request.signal?.addEventListener('abort', abortFromRequest, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(
            new RallarAiError(
                'provider-timeout',
                `RallarAI server generation timed out after ${input.timeoutMs}ms.`
            )
        );
    }, input.timeoutMs);

    try {
        return await input.provider.generateJson<RallarAiJsonValue, RallarAiJsonValue>({
            ...input.request,
            signal: controller.signal,
            timeoutMs: input.timeoutMs
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
        input.request.signal?.removeEventListener('abort', abortFromRequest);
    }
}
