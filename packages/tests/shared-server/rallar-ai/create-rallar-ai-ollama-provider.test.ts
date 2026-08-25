import { createRallarAiOllamaProvider } from '@shared-server/rallar-ai/create-rallar-ai-ollama-provider.ts';
import { RallarAiError } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import { createRallarServerAiTestRequest } from './rallar-server-ai-test-fixtures.ts';

describe('Rallar AI Ollama provider', () => {
    it('sends JSON-schema generation to an allowed local endpoint', async () => {
        const request = createRallarServerAiTestRequest();
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('http://127.0.0.1:11434/api/generate');
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toMatchObject({
                model: 'llama-test',
                stream: false,
                format: request.schema
            });
            return Response.json({ response: JSON.stringify({ kind: 'spawn' }) });
        });
        const provider = createRallarAiOllamaProvider({
            model: 'llama-test',
            fetch
        });

        const result = await provider.generateJson(request);

        expect(result).toMatchObject({
            providerId: 'ollama',
            modelId: 'llama-test',
            value: { kind: 'spawn' },
            validation: { ok: true }
        });
    });

    it('rejects a response that does not use the current Ollama envelope', async () => {
        const provider = createRallarAiOllamaProvider({
            model: 'llama-test',
            fetch: async () => Response.json({ content: '{"kind":"spawn"}' })
        });

        await expect(provider.generateJson(createRallarServerAiTestRequest()))
            .rejects.toMatchObject({
                code: 'invalid-json',
                message: 'Ollama returned a malformed response envelope.'
            });
    });

    it('rejects remote endpoints unless composition explicitly allows them', () => {
        expect(() =>
            createRallarAiOllamaProvider({
                model: 'llama-test',
                baseUrl: 'http://example.com:11434',
                fetch: async () => Response.json({ response: '{}' })
            })
        ).toThrow(RallarAiError);
    });
});
