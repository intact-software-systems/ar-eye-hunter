import {
    defineRallarAiProviderGovernanceMetadata,
    isRallarAiProviderAllowedInProduction,
    validateRallarAiProviderCapabilities
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI provider governance', () => {
    it('validates provider capabilities and governance metadata', () => {
        expect(
            validateRallarAiProviderCapabilities({
                supportsJsonSchema: true,
                supportsStreaming: false,
                supportsCancellation: true,
                target: 'shared'
            }).ok
        ).toBe(true);

        const metadata = defineRallarAiProviderGovernanceMetadata({
            providerId: 'mock',
            target: 'shared',
            structuredOutput: true,
            productionAllowed: false
        });

        expect(isRallarAiProviderAllowedInProduction(metadata)).toBe(false);
    });
});
