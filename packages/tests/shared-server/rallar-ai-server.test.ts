import { createRallarAiFakeSidecarProvider, createRallarAiOllamaProvider, createRallarServerAi } from '@shared-server/rallar-ai/mod.ts';
import type { RallarServerWsPublishResult } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import {
    createRallarAiJsonResult,
    createRallarAiMockProvider,
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar server AI facade', () => {
    const schema = {
        type: 'object',
        required: ['kind'],
        properties: {
            kind: { type: 'string' }
        },
        additionalProperties: false
    } as const;

    const request: RallarAiJsonRequest = {
        requestId: 'request-1',
        schemaId: 'game-event',
        schemaVersion: '1',
        schema,
        prompt: 'secret prompt',
        context: { hidden: 'secret context' }
    };

    it('generates JSON through an opt-in server provider with safe diagnostics', async () => {
        const diagnostics = vi.fn();
        const authorize = vi.fn(() => true);
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn' },
            createdAtEpochMs: 10
        });
        const ai = createRallarServerAi({
            rallar: createFakeRallar().rallar,
            provider,
            diagnostics,
            authorize
        });

        const result = await ai.generateJson(request, {
            actorId: 'host-1',
            roomId: 'room-1'
        });

        expect(result.validation.ok).toBe(true);
        expect(authorize).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: 'host-1',
                action: 'generate',
                source: 'server',
                schemaId: 'game-event'
            })
        );
        expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'generation-requested',
                requestId: 'request-1',
                providerId: 'mock'
            })
        );
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret prompt');
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret context');
    });

    it('rejects browser-only policy and browser-target providers on the server', async () => {
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });

        await expect(
            createRallarServerAi({
                rallar: createFakeRallar().rallar,
                provider,
                policy: { mode: 'browser-only' }
            }).generateJson(request)
        ).rejects.toThrow('cannot run browser-only');

        await expect(
            createRallarServerAi({
                rallar: createFakeRallar().rallar,
                provider: {
                    ...provider,
                    capabilities: {
                        ...provider.capabilities,
                        target: 'browser'
                    }
                }
            }).generateJson(request)
        ).rejects.toThrow('cannot run on the server');
    });

    it('enforces request size and concurrency quotas', async () => {
        await expect(
            createRallarServerAi({
                rallar: createFakeRallar().rallar,
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
                limits: { maxPromptBytes: 4 }
            }).generateJson(request)
        ).rejects.toThrow('prompt exceeded');
        await expect(
            createRallarServerAi({
                rallar: createFakeRallar().rallar,
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
                limits: { maxSchemaBytes: 4 }
            }).generateJson(request)
        ).rejects.toThrow('schema exceeded');
        await expect(
            createRallarServerAi({
                rallar: createFakeRallar().rallar,
                provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
                limits: { maxContextBytes: 4 }
            }).generateJson(request)
        ).rejects.toThrow('context exceeded');

        let release: (() => void) | undefined;
        const slowProvider: RallarAiJsonProvider = {
            ...createRallarAiMockProvider({ value: { kind: 'spawn' } }),
            providerId: 'slow',
            async generateJson<TValue>(slowRequest: RallarAiJsonRequest) {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return createRallarAiJsonResult<TValue>({
                    request: slowRequest,
                    provider: this,
                    value: { kind: 'spawn' } as TValue
                });
            }
        };
        const ai = createRallarServerAi({
            rallar: createFakeRallar().rallar,
            provider: slowProvider,
            limits: { maxConcurrentGenerations: 1 }
        });

        const pending = ai.generateJson(request);
        await Promise.resolve();
        await expect(ai.generateJson({ ...request, requestId: 'request-2' }))
            .rejects.toThrow('concurrency quota');
        release?.();
        await expect(pending).resolves.toEqual(
            expect.objectContaining({
                providerId: 'slow'
            })
        );
    });

    it('applies authorization to server broadcast and persistence helpers', async () => {
        const fake = createFakeRallar();
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const result = createRallarAiJsonResult({
            request,
            provider,
            value: { kind: 'spawn' }
        });
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider,
            authorize: ({ action }) => action === 'generate'
        });

        await expect(ai.broadcastJson({
            result,
            actorId: 'peer-1',
            scope: 'world'
        }))
            .rejects.toMatchObject({ code: 'unauthorized' });
        await expect(ai.persistJson({ result, actorId: 'peer-1' }))
            .rejects.toMatchObject({ code: 'unauthorized' });
        expect(fake.rallar.ws.publish).not.toHaveBeenCalled();
        expect(fake.rallar.data.open).not.toHaveBeenCalled();
    });

    it('maps fake sidecar provider errors through the server facade', async () => {
        const diagnostics = vi.fn();
        const provider = createRallarAiFakeSidecarProvider({
            baseUrl: 'http://sidecar.test',
            fetch: vi.fn(async () => new Response('down', { status: 503 }))
        });
        const ai = createRallarServerAi({
            rallar: createFakeRallar().rallar,
            provider,
            diagnostics
        });

        await expect(ai.generateJson(request)).rejects.toMatchObject({
            code: 'provider-failed',
            message: 'Fake sidecar failed with HTTP 503.'
        });
        expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'provider-failed',
                requestId: 'request-1',
                errorCode: 'provider-failed'
            })
        );
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret');
    });

    it('maps REST generation into typed success and error responses', async () => {
        const ai = createRallarServerAi({
            rallar: createFakeRallar().rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });

        const ok = await ai.handleRestGenerateJson({
            body: request,
            actorId: 'host-1',
            roomId: 'room-1'
        });
        const invalid = await ai.handleRestGenerateJson({ body: { prompt: 'x' } });

        expect(ok).toEqual(
            expect.objectContaining({
                status: 200,
                body: expect.objectContaining({ ok: true })
            })
        );
        expect(invalid).toEqual(
            expect.objectContaining({
                status: 400,
                body: expect.objectContaining({
                    ok: false,
                    error: expect.objectContaining({ code: 'invalid-json' })
                })
            })
        );
    });

    it('installs a structural REST route installer', async () => {
        const app = {
            post: vi.fn()
        };
        const ai = createRallarServerAi({
            rallar: createFakeRallar().rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });

        ai.createRestRouteInstaller({ path: '/ai/json' })(app);

        expect(app.post).toHaveBeenCalledWith('/ai/json', expect.any(Function));
        const response = await app.post.mock.calls[0][1]({ body: request });
        expect(response).toBeInstanceOf(Response);
        expect(response.status).toBe(200);
    });

    it('persists and broadcasts generated envelopes through Rallar Server facades', async () => {
        const fake = createFakeRallar();
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });
        const result = await ai.generateJson(request);

        await ai.persistJson({
            result,
            storeName: 'ai-results',
            key: 'result-1',
            actorId: 'host-1'
        });
        await ai.broadcastJson({
            result,
            actorId: 'host-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            fanout: 'outbox'
        });

        expect(fake.rallar.data.open).toHaveBeenCalledWith('ai-results', {
            namespace: 'server',
            schemaVersion: 1,
            ttlMs: undefined
        });
        expect(fake.store.set).toHaveBeenCalledWith('result-1', result);
        expect(fake.rallar.ws.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                route: expect.objectContaining({
                    topicId: 'room.ai.generated',
                    contextId: 'room-1'
                }),
                targets: expect.objectContaining({
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1'
                    }
                }),
                payload: expect.objectContaining({
                    typeId: 'rallar.ai.generate-json.result.v1'
                })
            }),
            'outbox'
        );
    });

    it('rejects room broadcast input without a canonical workspace GroupRef', async () => {
        const fake = createFakeRallar();
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const result = createRallarAiJsonResult({
            request,
            provider,
            value: { kind: 'spawn' }
        });
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider
        });
        await expect(ai.broadcastJson({
            result,
            actorId: 'host-1',
            scope: 'room',
            // @ts-expect-error Runtime callers can still omit workspace identity.
            roomRef: {
                applicationId: 'app-1',
                groupId: 'room-1'
            },
            fanout: 'outbox'
        })).rejects.toThrow(/complete GroupRef/i);
        expect(fake.rallar.ws.publish).not.toHaveBeenCalled();

        if (false) {
            // @ts-expect-error Default room broadcasts require a complete GroupRef.
            await ai.broadcastJson({ result, fanout: 'outbox' });
            // @ts-expect-error Explicit room broadcasts require a complete GroupRef.
            await ai.broadcastJson({ result, scope: 'room', fanout: 'outbox' });
        }
    });

    it.each([
        ['unknown string', 'galaxy'],
        ['number', 7],
        ['null', null]
    ])('rejects a %s runtime broadcast scope before publishing', async (_label, invalidScope) => {
        const fake = createFakeRallar();
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const result = createRallarAiJsonResult({
            request,
            provider,
            value: { kind: 'spawn' }
        });
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider
        });
        const invalidInput = {
            result,
            scope: invalidScope,
            fanout: 'outbox' as const
        };

        // @ts-expect-error Runtime JavaScript callers can supply invalid scope values.
        await expect(ai.broadcastJson(invalidInput)).rejects.toMatchObject({
            code: 'invalid-json'
        });

        expect(fake.rallar.ws.publish).not.toHaveBeenCalled();
    });

    it('keeps world broadcasts intentionally unscoped', async () => {
        const fake = createFakeRallar();
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });
        const result = createRallarAiJsonResult({
            request,
            provider,
            value: { kind: 'spawn' }
        });
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider
        });

        await ai.broadcastJson({ result, scope: 'world' });

        expect(fake.rallar.ws.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                route: expect.objectContaining({ contextId: 'world' }),
                targets: {
                    mode: 'broadcast',
                    scope: 'world'
                }
            }),
            undefined
        );
    });

    it('fails closed when a room generation topic lacks canonical workspace context', async () => {
        const fake = createFakeRallar();
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });

        ai.installGenerationTopic({ resultFanout: 'outbox' });

        await expect(fake.handlers[0].handler(
            {
                payload: request,
                raw: newALBroadcastMessage(
                    'peer-1',
                    newALRoute('room.ai.generate', 'room-1', 'request-1'),
                    'room',
                    'rallar.ai.generate-json.request.v1',
                    request
                ),
                receivedAtEpochMs: 1
            },
            {
                senderId: 'peer-1',
                roomId: 'room-1',
                proxy: {}
            }
        )).rejects.toThrow(/complete GroupRef/i);
        expect(fake.rallar.ws.publish).not.toHaveBeenCalled();
    });

    it.each([
        ['unknown string', 'galaxy'],
        ['number', 7],
        ['null', null]
    ])('rejects a %s generation result scope before publishing', async (_label, invalidScope) => {
        const fake = createFakeRallar();
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });
        const invalidOptions = {
            scope: invalidScope,
            resultFanout: 'outbox' as const
        };
        // @ts-expect-error Runtime JavaScript callers can supply invalid scope values.
        ai.installGenerationTopic(invalidOptions);

        await expect(fake.handlers[0].handler(
            {
                payload: request,
                raw: newALBroadcastMessage(
                    'peer-1',
                    newALRoute('room.ai.generate', 'room-1', 'request-1'),
                    'room',
                    'rallar.ai.generate-json.request.v1',
                    request
                ),
                receivedAtEpochMs: 1
            },
            {
                senderId: 'peer-1',
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                proxy: {}
            }
        )).rejects.toMatchObject({ code: 'invalid-json' });

        expect(fake.rallar.ws.publish).not.toHaveBeenCalled();
    });

    it('installs WS request/result topic wiring', async () => {
        const fake = createFakeRallar();
        const ai = createRallarServerAi({
            rallar: fake.rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } })
        });

        const unregister = ai.installGenerationTopic({
            resultFanout: 'live-only'
        });
        await fake.handlers[0].handler(
            {
                payload: request,
                raw: newALBroadcastMessage(
                    'peer-1',
                    newALRoute('room.ai.generate', 'room-1', 'request-1'),
                    'room',
                    'rallar.ai.generate-json.request.v1',
                    request
                ),
                receivedAtEpochMs: 1
            },
            {
                senderId: 'peer-1',
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                proxy: {}
            }
        );

        expect(fake.topics[0]).toEqual(
            expect.objectContaining({
                topicId: 'room.ai.generate',
                typeId: 'rallar.ai.generate-json.request.v1',
                fanout: 'none'
            })
        );
        expect(fake.rallar.ws.publish).toHaveBeenCalledTimes(1);
        const published = fake.rallar.ws.publish.mock.calls[0][0];
        expect(published.targets).toEqual({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            }
        });
        expect(JSON.parse(published.payload.resource)).toEqual(
            expect.objectContaining({
                schemaId: 'game-event',
                value: { kind: 'spawn' }
            })
        );
        expect(unregister()).toBe(true);
    });

    it('creates a localhost-only Ollama provider for JSON schema generation', async () => {
        const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(_input)).toBe('http://127.0.0.1:11434/api/generate');
            const body = JSON.parse(String(init?.body));
            expect(body).toEqual(
                expect.objectContaining({
                    model: 'llama-test',
                    stream: false,
                    format: schema
                })
            );
            return new Response(
                JSON.stringify({ response: JSON.stringify({ kind: 'spawn' }) }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                }
            );
        });
        const provider = createRallarAiOllamaProvider({
            model: 'llama-test',
            fetch
        });

        const result = await provider.generateJson(request);

        expect(result).toEqual(
            expect.objectContaining({
                providerId: 'ollama',
                modelId: 'llama-test',
                value: { kind: 'spawn' }
            })
        );
        expect(() =>
            createRallarAiOllamaProvider({
                model: 'llama-test',
                baseUrl: 'http://example.com:11434',
                fetch
            })
        ).toThrow(RallarAiError);
    });
});

function createFakeRallar() {
    const store = {
        set: vi.fn(async () => undefined)
    };
    const topics: unknown[] = [];
    const handlers: Array<{
        selector: unknown;
        handler: (
            message: unknown,
            context: unknown
        ) => Promise<void> | void;
    }> = [];
    const ws = {
        defineTopic: vi.fn((definition) => {
            topics.push(definition);
            return ws;
        }),
        on: vi.fn((selector, handler) => {
            handlers.push({ selector, handler });
            return () => true;
        }),
        publish: vi.fn(async (message, fanout) => ({
            fanout: fanout ?? 'live-only',
            status: 'sent-live',
            message,
            sentCount: 1,
            entries: []
        } satisfies RallarServerWsPublishResult))
    };
    const rallar = {
        ws,
        data: {
            open: vi.fn(async () => store)
        }
    };

    return {
        rallar,
        store,
        topics,
        handlers
    };
}
