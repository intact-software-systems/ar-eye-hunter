import {
    createRallarAiJsonResult,
    createRallarAiMockProvider,
    type RallarAiDiagnosticEvent,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import { createRallarServerAiTestRequest, createRallarServerAiTestService } from './rallar-server-ai-test-fixtures.ts';

describe('Rallar server AI generation', () => {
    it('authorizes generation and reports diagnostics without request content', async () => {
        const diagnostics: RallarAiDiagnosticEvent[] = [];
        const authorize = vi.fn(() => true);
        const ai = createRallarServerAiTestService({
            provider: createRallarAiMockProvider({
                value: { kind: 'spawn' },
                createdAtEpochMs: 10
            }),
            authorize,
            diagnostics: (event) => diagnostics.push(event)
        });
        const request = {
            ...createRallarServerAiTestRequest(),
            prompt: 'secret prompt',
            context: { hidden: 'secret context' }
        };

        const result = await ai.generateJson(request, {
            actorId: 'host-1',
            roomId: 'room-1'
        });

        expect(result.validation.ok).toBe(true);
        expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
            actorId: 'host-1',
            roomId: 'room-1',
            action: 'generate',
            source: 'server',
            schemaId: 'game-event'
        }));
        expect(diagnostics.map((event) => event.kind)).toEqual([
            'generation-requested',
            'provider-started',
            'provider-completed'
        ]);
        expect(JSON.stringify(diagnostics)).not.toContain('secret prompt');
        expect(JSON.stringify(diagnostics)).not.toContain('secret context');
    });

    it('rejects browser policy and browser-only providers', async () => {
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const request = createRallarServerAiTestRequest();

        await expect(
            createRallarServerAiTestService({
                provider,
                policy: { mode: 'browser-only' }
            }).generateJson(request)
        ).rejects.toMatchObject({
            code: 'provider-target-mismatch'
        });
        await expect(
            createRallarServerAiTestService({
                provider: {
                    ...provider,
                    capabilities: { ...provider.capabilities, target: 'browser' }
                }
            }).generateJson(request)
        ).rejects.toMatchObject({
            code: 'provider-target-mismatch'
        });
    });

    it.each([
        ['prompt', { maxPromptBytes: 4 }],
        ['schema', { maxSchemaBytes: 4 }],
        ['context', { maxContextBytes: 4 }]
    ])('rejects an oversized %s before invoking the provider', async (_field, limits) => {
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const generateJson = vi.spyOn(provider, 'generateJson');
        const ai = createRallarServerAiTestService({ provider, limits });

        await expect(ai.generateJson(createRallarServerAiTestRequest()))
            .rejects.toMatchObject({ code: 'request-too-large' });
        expect(generateJson).not.toHaveBeenCalled();
    });

    it('limits concurrent provider generations', async () => {
        const enteredProvider = createDeferred();
        const releaseProvider = createDeferred();
        const baseProvider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const provider: RallarAiJsonProvider = {
            ...baseProvider,
            async generateJson<TValue, TContext>(request: RallarAiJsonRequest<TContext>) {
                enteredProvider.resolve();
                await releaseProvider.promise;
                return await baseProvider.generateJson<TValue, TContext>(request);
            }
        };
        const ai = createRallarServerAiTestService({
            provider,
            limits: { maxConcurrentGenerations: 1 }
        });
        const firstGeneration = ai.generateJson(createRallarServerAiTestRequest());
        await enteredProvider.promise;

        await expect(ai.generateJson(createRallarServerAiTestRequest('request-2')))
            .rejects.toMatchObject({ code: 'quota-exceeded' });
        releaseProvider.resolve();
        await expect(firstGeneration).resolves.toMatchObject({ providerId: 'mock' });
    });

    it('aborts provider work when its server timeout expires', async () => {
        const baseProvider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const provider: RallarAiJsonProvider = {
            ...baseProvider,
            generateJson: async <TValue, TContext>(request: RallarAiJsonRequest<TContext>) =>
                await new Promise<never>((_resolve, reject) => {
                    request.signal?.addEventListener(
                        'abort',
                        () => reject(request.signal?.reason),
                        { once: true }
                    );
                })
        };
        const ai = createRallarServerAiTestService({
            provider,
            policy: { mode: 'server-only', timeoutMs: 1 }
        });

        await expect(ai.generateJson(createRallarServerAiTestRequest()))
            .rejects.toMatchObject({ code: 'provider-timeout' });
    });

    it('rejects a provider result whose value is not JSON-safe', async () => {
        const request: RallarAiJsonRequest = {
            schemaId: 'json-result',
            schemaVersion: '1',
            schema: {},
            prompt: 'Return JSON.'
        };
        const provider = {
            ...createRallarAiMockProvider(),
            async generateJson(providerRequest: RallarAiJsonRequest) {
                return createRallarAiJsonResult({
                    request: providerRequest,
                    provider: {
                        providerId: 'invalid-result-provider',
                        source: 'server'
                    },
                    value: new Date(0)
                });
            }
        };
        const ai = createRallarServerAiTestService({
            // @ts-expect-error A runtime provider can violate the generic JSON result claim.
            provider
        });

        await expect(ai.generateJson(request)).rejects.toMatchObject({
            code: 'invalid-json'
        });
    });
});

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function createDeferred(): Deferred {
    let resolve = () => undefined;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
