import {
    createWebLlmRallarAiProvider,
    type RallarAiWebLlmRuntime
} from '@shared-web/browser/ai/providers/webllm-rallar-ai-provider.ts';
import { RallarAiError } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';

const gameEventSchema = {
    type: 'object',
    required: ['kind'],
    properties: {
        kind: { type: 'string' }
    },
    additionalProperties: false
} as const;

describe('shared-web WebLLM provider', () => {
    it('loads one runtime and validates each generated envelope', async () => {
        const generateJson = vi.fn(async () => ({ json: { kind: 'spawn' } }));
        const runtime: RallarAiWebLlmRuntime = {
            generateJson: async (input) => {
                expect(JSON.stringify(input)).toContain('Generate a spawn');
                return await generateJson();
            }
        };
        const loadRuntime = vi.fn(async () => runtime);
        const provider = createWebLlmRallarAiProvider({
            modelId: 'webllm-test-model',
            loadRuntime,
            typicalColdStartMs: 100
        });

        const first = await provider.generateJson(request('webllm-request-1'));
        const second = await provider.generateJson(request('webllm-request-2'));

        expect(loadRuntime).toHaveBeenCalledTimes(1);
        expect(generateJson).toHaveBeenCalledTimes(2);
        expect(provider.capabilities).toEqual(
            expect.objectContaining({
                target: 'browser',
                typicalColdStartMs: 100
            })
        );
        expect(first).toEqual(
            expect.objectContaining({
                providerId: 'webllm',
                modelId: 'webllm-test-model',
                source: 'browser',
                value: { kind: 'spawn' },
                validation: expect.objectContaining({ ok: true }),
                lifecycle: 'draft'
            })
        );
        expect(second.validation.ok).toBe(true);
    });

    it('rejects malformed runtime JSON at the live-provider boundary', async () => {
        const provider = createWebLlmRallarAiProvider({
            modelId: 'webllm-test-model',
            runtime: {
                generateJson: async () => ({ text: 'not json' })
            }
        });

        await expect(provider.generateJson(request('invalid-json'))).rejects.toMatchObject({
            name: 'RallarAiError',
            code: 'invalid-json'
        } satisfies Partial<RallarAiError>);
    });

    it('keeps schema-invalid output as an explicit unaccepted draft', async () => {
        const provider = createWebLlmRallarAiProvider({
            modelId: 'webllm-test-model',
            runtime: {
                generateJson: async () => ({ json: { kind: 42 } })
            }
        });

        const result = await provider.generateJson(request('invalid-schema'));

        expect(result.validation).toEqual(
            expect.objectContaining({ ok: false })
        );
        expect(result.lifecycle).toBe('draft');
    });
});

function request(requestId: string) {
    return {
        requestId,
        schemaId: 'game-event',
        schemaVersion: '1',
        schema: gameEventSchema,
        prompt: 'Generate a spawn.'
    };
}
