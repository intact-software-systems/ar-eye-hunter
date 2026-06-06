import type {
    RallarAiGenerationPolicy,
    RallarAiJsonProvider,
    RallarAiProviderTarget,
} from './rallar-ai-types.ts';
import { RallarAiError } from './rallar-ai-types.ts';
import { providerCanRunOnTarget } from './rallar-ai-provider-capabilities.ts';

export type RallarAiProviderSelection = Readonly<{
    primary: RallarAiJsonProvider;
    fallback?: RallarAiJsonProvider;
}>;

export function selectRallarAiProviders(
    policy: RallarAiGenerationPolicy,
    providers: readonly RallarAiJsonProvider[],
): RallarAiProviderSelection {
    if (policy.mode === 'disabled') {
        throw new RallarAiError('disabled', 'RallarAI generation is disabled.');
    }

    const browser = firstProviderForTarget(providers, 'browser');
    const server = firstProviderForTarget(providers, 'server');

    switch (policy.mode) {
        case 'browser-only':
            return { primary: requireProvider(browser, 'browser') };
        case 'server-only':
            return { primary: requireProvider(server, 'server') };
        case 'browser-first':
            return {
                primary: requireProvider(browser ?? server, 'browser or server'),
                fallback: browser ? server : undefined,
            };
        case 'server-first':
            return {
                primary: requireProvider(server ?? browser, 'server or browser'),
                fallback: server ? browser : undefined,
            };
    }
}

export function assertRallarAiProviderTarget(
    provider: RallarAiJsonProvider,
    target: Exclude<RallarAiProviderTarget, 'shared'>,
): void {
    if (!providerCanRunOnTarget(provider.capabilities, target)) {
        throw new RallarAiError(
            'provider-target-mismatch',
            `Provider ${provider.providerId} cannot run on ${target}.`,
        );
    }
}

function firstProviderForTarget(
    providers: readonly RallarAiJsonProvider[],
    target: Exclude<RallarAiProviderTarget, 'shared'>,
): RallarAiJsonProvider | undefined {
    return providers.find((provider) => provider.capabilities.target === target) ??
        providers.find((provider) =>
            providerCanRunOnTarget(provider.capabilities, target)
        );
}

function requireProvider(
    provider: RallarAiJsonProvider | undefined,
    target: string,
): RallarAiJsonProvider {
    if (!provider) {
        throw new RallarAiError(
            'provider-unavailable',
            `No RallarAI provider available for ${target}.`,
        );
    }
    return provider;
}
