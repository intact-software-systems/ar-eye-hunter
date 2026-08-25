import type { CreateRallarBrowserAiOptions } from '@shared-web/browser/rallar-ai.ts';
import {
    providerCanRunOnTarget,
    RallarAiError,
    type RallarAiGenerationPolicy,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';

export const DEFAULT_BROWSER_RALLAR_AI_POLICY: RallarAiGenerationPolicy = {
    mode: 'browser-only',
    staleResultMode: 'reject'
};

export function assertBrowserRallarAiGenerationAllowed(
    policy: RallarAiGenerationPolicy,
    provider: RallarAiJsonProvider
): void {
    if (policy.mode === 'disabled') {
        throw new RallarAiError(
            'disabled',
            'RallarAI browser generation is disabled.'
        );
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

export function assertBrowserRallarAiResultIsFresh(
    options: CreateRallarBrowserAiOptions,
    request: RallarAiJsonRequest
): void {
    if ((options.policy?.staleResultMode ?? 'reject') !== 'reject') {
        return;
    }
    if (!request.baseStateRevision || !options.readCurrentStateRevision) {
        return;
    }
    const currentStateRevision = options.readCurrentStateRevision(request);
    if (
        currentStateRevision !== undefined &&
        currentStateRevision !== request.baseStateRevision
    ) {
        throw new RallarAiError(
            'stale-result',
            'RallarAI browser generation result is stale.',
            {
                baseStateRevision: request.baseStateRevision,
                currentStateRevision
            }
        );
    }
}
