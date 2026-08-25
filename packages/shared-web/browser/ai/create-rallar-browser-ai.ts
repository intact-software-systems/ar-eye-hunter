import { DEFAULT_BROWSER_RALLAR_AI_POLICY } from '@shared-web/browser/ai/browser-rallar-ai-generation-policy.ts';
import {
    createBrowserRallarAiBroadcast,
    createBrowserRallarAiPersistence
} from '@shared-web/browser/ai/browser-rallar-ai-result-delivery.ts';
import { createBrowserRallarAiGeneration } from '@shared-web/browser/ai/create-browser-rallar-ai-generation.ts';
import type { CreateRallarBrowserAiOptions, RallarBrowserAiFacade } from '@shared-web/browser/rallar-ai.ts';

export function createRallarBrowserAi(
    options: CreateRallarBrowserAiOptions
): RallarBrowserAiFacade {
    const policy = options.policy ?? DEFAULT_BROWSER_RALLAR_AI_POLICY;
    return {
        generateJson: createBrowserRallarAiGeneration(options, policy),
        broadcastJson: createBrowserRallarAiBroadcast(options),
        persistJson: createBrowserRallarAiPersistence(options)
    };
}
