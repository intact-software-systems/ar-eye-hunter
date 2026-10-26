import {
    createRallarAiMockProvider,
    RallarAiError,
    selectRallarAiProviders
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI provider selection', () => {
    it('selects providers by generation policy', () => {
        const mock = createRallarAiMockProvider();
        const server = {
            ...mock,
            providerId: 'server-provider',
            source: 'server' as const,
            capabilities: {
                ...mock.capabilities,
                target: 'server' as const
            }
        };

        expect(
            selectRallarAiProviders({
                mode: 'server-only'
            }, [mock, server]).primary.providerId
        ).toBe('server-provider');

        expect(() => selectRallarAiProviders({ mode: 'disabled' }, [mock])).toThrow(RallarAiError);
    });
});
