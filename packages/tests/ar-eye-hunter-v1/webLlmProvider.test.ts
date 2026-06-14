import { describe, expect, it, vi } from 'vitest';
import type { RallarAiJsonRequest } from '@shared/rallar-ai/mod.ts';

import {
    createWebLlmRallarAiProvider,
    type WebLlmChatRequest,
    type WebLlmEngine,
    type WebLlmModule,
} from '../../../apps/ar-eye-hunter-v1/src/game/webLlmProvider.ts';

describe('AR Eye Hunter WebLLM RallarAI provider', () => {
    it('loads one engine, requests JSON mode, and parses JSON results', async () => {
        const requests: WebLlmChatRequest[] = [];
        const engine: WebLlmEngine = {
            chat: {
                completions: {
                    create: vi.fn(async (input: WebLlmChatRequest) => {
                        requests.push(input);
                        return {
                            choices: [
                                {
                                    message: {
                                        content: '{"headline":"Mandatory fun detected","urgency":"low"}',
                                    },
                                },
                            ],
                        };
                    }),
                },
            },
        };
        const createEngine = vi.fn(async () => engine);
        const provider = createWebLlmRallarAiProvider({
            modelId: 'test-webllm-model',
            loadWebLlm: async (): Promise<WebLlmModule> => ({
                CreateMLCEngine: createEngine,
            }),
            hasWebGpu: () => true,
        });

        const first = await provider.generateJson<Record<string, unknown>>(request('one'));
        const second = await provider.generateJson<Record<string, unknown>>(request('two'));

        expect(createEngine).toHaveBeenCalledTimes(1);
        expect(createEngine).toHaveBeenCalledWith('test-webllm-model', expect.any(Object));
        expect(engine.chat.completions.create).toHaveBeenCalledTimes(2);
        expect(requests[0]?.response_format).toEqual({ type: 'json_object' });
        expect(requests[0]?.temperature).toBe(0.41);
        expect(requests[0]?.max_tokens).toBe(123);
        expect(requests[0]?.messages[1]?.content).toContain('"roomId":"room-1"');
        expect(requests[0]?.messages[1]?.content).toContain('"type":"object"');
        expect(first.value).toEqual({
            headline: 'Mandatory fun detected',
            urgency: 'low',
        });
        expect(second.providerId).toBe('ar-eye-hunter-webllm');
        expect(second.modelId).toBe('test-webllm-model');
    });

    it('rejects malformed JSON so app validation can fall back safely', async () => {
        const provider = createWebLlmRallarAiProvider({
            modelId: 'test-webllm-model',
            loadWebLlm: async (): Promise<WebLlmModule> => ({
                CreateMLCEngine: async () => ({
                    chat: {
                        completions: {
                            create: async () => ({
                                choices: [{ message: { content: 'not json' } }],
                            }),
                        },
                    },
                }),
            }),
            hasWebGpu: () => true,
        });

        await expect(provider.generateJson(request('bad-json'))).rejects.toThrow(
            'WebLLM returned malformed JSON',
        );
    });

    it('honors abort signals before and during generation', async () => {
        const provider = createWebLlmRallarAiProvider({
            modelId: 'test-webllm-model',
            loadWebLlm: async (): Promise<WebLlmModule> => ({
                CreateMLCEngine: async () => ({
                    chat: {
                        completions: {
                            create: async () => new Promise(() => undefined),
                        },
                    },
                }),
            }),
            hasWebGpu: () => true,
        });
        const alreadyAborted = new AbortController();
        alreadyAborted.abort(new Error('already cancelled'));

        await expect(provider.generateJson({
            ...request('pre-abort'),
            signal: alreadyAborted.signal,
        })).rejects.toThrow('already cancelled');

        const during = new AbortController();
        const pending = provider.generateJson({
            ...request('during-abort'),
            signal: during.signal,
        });
        during.abort(new Error('cancelled while running'));

        await expect(pending).rejects.toThrow('cancelled while running');
    });
});

function request(requestId: string): RallarAiJsonRequest<{ roomId: string }> {
    return {
        requestId,
        schemaId: 'ar-eye-hunter.test-webllm',
        schemaVersion: '1',
        schema: {
            type: 'object',
            required: ['headline', 'urgency'],
            additionalProperties: false,
            properties: {
                headline: { type: 'string' },
                urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
        },
        prompt: 'Return one funny arena status JSON object.',
        context: { roomId: 'room-1' },
        maxOutputTokens: 123,
        temperature: 0.41,
    };
}
