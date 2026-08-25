import {
    providerCanRunOnTarget,
    RallarAiError,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonValue
} from '@shared/rallar-ai/mod.ts';
import type { RallarServerAiJsonRequest } from './decode-rallar-server-ai-json-request.ts';
import type { RallarServerAiLimits } from './rallar-server-ai-contracts.ts';

export function toRallarServerAiProviderPolicyError(
    policy: RallarAiGenerationPolicy,
    provider: RallarAiJsonProvider
): RallarAiError | undefined {
    if (policy.mode === 'disabled') {
        return new RallarAiError('disabled', 'RallarAI server generation is disabled.');
    }
    if (policy.mode === 'browser-only') {
        return new RallarAiError(
            'provider-target-mismatch',
            'RallarAI server generation cannot run a browser-only policy.'
        );
    }
    if (!providerCanRunOnTarget(provider.capabilities, 'server')) {
        return new RallarAiError(
            'provider-target-mismatch',
            `RallarAI provider cannot run on the server target: ${provider.providerId}.`
        );
    }
    if (!provider.capabilities.supportsJsonSchema) {
        return new RallarAiError(
            'provider-unavailable',
            `RallarAI provider does not advertise JSON schema support: ${provider.providerId}.`
        );
    }
    return undefined;
}

export function toRallarServerAiRequestLimitError(
    request: RallarServerAiJsonRequest,
    limits: RallarServerAiLimits
): RallarAiError | undefined {
    if (byteLength({ ...request, signal: undefined }) > limits.maxRequestBytes) {
        return new RallarAiError(
            'request-too-large',
            `RallarAI request exceeded ${limits.maxRequestBytes} bytes.`
        );
    }
    if (byteLength(request.prompt) > limits.maxPromptBytes) {
        return new RallarAiError(
            'request-too-large',
            `RallarAI prompt exceeded ${limits.maxPromptBytes} bytes.`
        );
    }
    if (byteLength(request.schema) > limits.maxSchemaBytes) {
        return new RallarAiError(
            'request-too-large',
            `RallarAI schema exceeded ${limits.maxSchemaBytes} bytes.`
        );
    }
    if (
        request.context !== undefined &&
        byteLength(request.context) > limits.maxContextBytes
    ) {
        return new RallarAiError(
            'request-too-large',
            `RallarAI context exceeded ${limits.maxContextBytes} bytes.`
        );
    }
    return undefined;
}

function byteLength(value: RallarAiJsonValue | object): number {
    return new TextEncoder().encode(
        typeof value === 'string' ? value : JSON.stringify(value)
    ).length;
}
