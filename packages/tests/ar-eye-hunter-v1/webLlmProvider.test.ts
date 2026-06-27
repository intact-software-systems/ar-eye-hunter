import { describe, expect, it, vi } from 'vitest';
import {
    isRallarAiProviderAllowedInProduction,
    type RallarAiJsonRequest,
} from '@shared/rallar-ai/mod.ts';

import {
    ARENA_WEBLLM_LIVE_EVALUATION_GATE,
    ARENA_WEBLLM_PROVIDER_GOVERNANCE,
    createWebLlmRallarAiProvider,
    runArenaWebLlmDeterministicEvaluation,
    runArenaWebLlmLiveEvaluationIfEnabled,
    type WebLlmChatRequest,
    type WebLlmEngine,
    type WebLlmModule,
} from '../../../apps/ar-eye-hunter-v1/src/game/webLlmProvider.ts';
import { DEFAULT_ARENA_WEBLLM_MODEL_ID } from '../../../apps/ar-eye-hunter-v1/src/game/browserAiConfig.ts';

describe('AR Eye Hunter WebLLM RallarAI provider', () => {
    it('declares app-owned governance metadata for the WebLLM provider', () => {
        expect(ARENA_WEBLLM_PROVIDER_GOVERNANCE).toMatchObject({
            providerId: 'ar-eye-hunter-webllm',
            adapterVersion: 'ar-eye-hunter-v1/webllm-provider:1',
            modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
            target: 'browser',
            structuredOutput: true,
            productionAllowed: false,
            knownLimits: {
                maxOutputTokens: 1_200,
                recommendedTimeoutMs: 4_000,
            },
        });
        expect(
            isRallarAiProviderAllowedInProduction(
                ARENA_WEBLLM_PROVIDER_GOVERNANCE,
                'browser',
            ),
        ).toBe(false);
    });

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

    it('runs deterministic WebLLM evaluation cases in CI without live browser AI', async () => {
        const report = await runArenaWebLlmDeterministicEvaluation({
            nowEpochMs: 18_000,
        });

        expect(report).toMatchObject({
            suiteId: 'ar-eye-hunter-webllm-ci',
            providerId: 'ar-eye-hunter-chaos-mock',
            passed: 1,
            failed: 0,
        });
        expect(report.results[0]).toEqual(
            expect.objectContaining({
                caseId: 'ai-director-chaos-event',
                validationOk: true,
            }),
        );
    });

    it('keeps live WebLLM evaluation behind an explicit opt-in gate', async () => {
        const skipped = await runArenaWebLlmLiveEvaluationIfEnabled({
            env: {},
            nowEpochMs: 18_000,
            createProvider: () => createWebLlmRallarAiProvider({
                modelId: 'should-not-load',
                hasWebGpu: () => false,
            }),
        });

        expect(skipped).toEqual(expect.objectContaining({
            status: 'skipped',
            gate: ARENA_WEBLLM_LIVE_EVALUATION_GATE,
        }));

        const ran = await runArenaWebLlmLiveEvaluationIfEnabled({
            env: { [ARENA_WEBLLM_LIVE_EVALUATION_GATE]: '1' },
            nowEpochMs: 18_000,
            createProvider: () => createWebLlmRallarAiProvider({
                modelId: 'mock-live-webllm',
                hasWebGpu: () => true,
                loadWebLlm: async (): Promise<WebLlmModule> => ({
                    CreateMLCEngine: async () => ({
                        chat: {
                            completions: {
                                create: async () => ({
                                    choices: [
                                        {
                                            message: {
                                                content: JSON.stringify({
                                                    event: {
                                                        kind: 'combo-bounty',
                                                        headline: 'Live bounty marked',
                                                        scoreBonus: 150,
                                                        durationMs: 9000,
                                                    },
                                                    urgency: 'medium',
                                                    reason: 'Keep the live model inside app bounds.',
                                                }),
                                            },
                                        },
                                    ],
                                }),
                            },
                        },
                    }),
                }),
            }),
        });

        expect(ran).toEqual(expect.objectContaining({
            status: 'ran',
            report: expect.objectContaining({
                suiteId: 'ar-eye-hunter-webllm-live',
                providerId: 'ar-eye-hunter-webllm',
                passed: 1,
                failed: 0,
            }),
        }));
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
