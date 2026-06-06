import { describe, expect, it, vi } from 'vitest';
import {
    createRallarAiAcceptedResultTracker,
    createRallarAiMockProvider,
    RallarAiError,
    transitionRallarAiResultLifecycle,
} from '@shared/rallar-ai/mod.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';

describe('Rallar browser AI facade', () => {
    const schema = {
        type: 'object',
        required: ['kind'],
        properties: {
            kind: { type: 'string' },
        },
        additionalProperties: false,
    } as const;

    it('delegates generation to the configured provider and emits safe diagnostics', async () => {
        const diagnostics = vi.fn();
        const ai = createRallarBrowserAi({
            rallar: createFakeRallar(),
            provider: createRallarAiMockProvider({
                value: { kind: 'spawn' },
                createdAtEpochMs: 10,
            }),
            diagnostics,
        });

        const result = await ai.generateJson({
            requestId: 'request-1',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema,
            prompt: 'secret prompt should not be in diagnostics',
            context: { secret: 'hidden' },
        });

        expect(result.validation.ok).toBe(true);
        expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'generation-requested',
                requestId: 'request-1',
                schemaId: 'game-event',
            }),
        );
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret');
    });

    it('rejects disabled, server-only, and server-target browser generation', async () => {
        const rallar = createFakeRallar();
        const provider = createRallarAiMockProvider({ value: { kind: 'spawn' } });

        await expect(
            createRallarBrowserAi({
                rallar,
                provider,
                policy: { mode: 'disabled' },
            }).generateJson({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema,
                prompt: 'generate',
            }),
        ).rejects.toThrow(RallarAiError);

        await expect(
            createRallarBrowserAi({
                rallar,
                provider,
                policy: { mode: 'server-only' },
            }).generateJson({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema,
                prompt: 'generate',
            }),
        ).rejects.toThrow('cannot run server-only generation');

        await expect(
            createRallarBrowserAi({
                rallar,
                provider: {
                    ...provider,
                    providerId: 'server-provider',
                    source: 'server',
                    capabilities: {
                        ...provider.capabilities,
                        target: 'server',
                    },
                },
            }).generateJson({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema,
                prompt: 'generate',
            }),
        ).rejects.toThrow('targets server');
    });

    it('emits failure diagnostics when browser provider generation fails', async () => {
        const diagnostics = vi.fn();
        const provider = {
            ...createRallarAiMockProvider({ value: { kind: 'spawn' } }),
            async generateJson() {
                throw new RallarAiError('provider-failed', 'model down');
            },
        };
        const ai = createRallarBrowserAi({
            rallar: createFakeRallar(),
            provider,
            diagnostics,
        });

        await expect(
            ai.generateJson({
                requestId: 'request-failed',
                schemaId: 'game-event',
                schemaVersion: '1',
                schema,
                prompt: 'secret prompt',
                context: { hidden: 'secret context' },
            }),
        ).rejects.toThrow('model down');

        expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'provider-failed',
                requestId: 'request-failed',
                errorCode: 'provider-failed',
            }),
        );
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret');
    });

    it('rejects stale results when configured with a revision reader', async () => {
        const ai = createRallarBrowserAi({
            rallar: createFakeRallar(),
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
            readCurrentStateRevision: () => 'revision-2',
        });

        await expect(
            ai.generateJson({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema,
                prompt: 'generate',
                baseStateRevision: 'revision-1',
            }),
        ).rejects.toThrow('result is stale');
    });

    it('broadcasts generated envelopes over realtime, RTC messages, and WS messages', async () => {
        const rallar = createFakeRallar();
        const ai = createRallarBrowserAi({
            rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
        });
        const result = await ai.generateJson({
            schemaId: 'game-event',
            schemaVersion: '1',
            schema,
            prompt: 'generate',
        });

        await ai.broadcastJson({
            result,
            transport: 'realtime',
            laneId: 'game-events',
            roomId: 'room-1',
        });
        await ai.broadcastJson({
            result,
            transport: 'messages.rtc',
            roomId: 'room-1',
        });
        await ai.broadcastJson({
            result,
            transport: 'messages.ws',
            roomId: 'room-1',
        });

        expect(rallar.realtime.sendJson).toHaveBeenCalledWith(
            expect.objectContaining({
                laneId: 'game-events',
                roomId: 'room-1',
                data: result,
            }),
        );
        expect(rallar.messages.rtc.send).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'room.ai',
                typeId: 'generated',
                payload: result,
                roomId: 'room-1',
            }),
        );
        expect(rallar.messages.ws.send).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: 'room',
                topicId: 'room.ai',
                typeId: 'generated',
                payload: result,
                roomId: 'room-1',
            }),
        );
    });

    it('supports an app-level proposal approval flow that applies accepted results once', async () => {
        const rallar = createFakeRallar();
        const ai = createRallarBrowserAi({
            rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
        });
        const draft = await ai.generateJson({
            requestId: 'approval-request',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema,
            prompt: 'Generate a spawn.',
            dedupeKey: 'room:1:turn:3',
        });
        const proposed = transitionRallarAiResultLifecycle(draft, 'proposed');
        const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
        const tracker = createRallarAiAcceptedResultTracker<typeof accepted.value>();
        const gameEvents: unknown[] = [];

        await ai.broadcastJson({
            result: proposed,
            transport: 'messages.rtc',
            roomId: 'room-1',
            topicId: 'room.ai.proposals',
            typeId: 'rallar.ai.proposed',
        });
        await ai.broadcastJson({
            result: accepted,
            transport: 'messages.ws',
            roomId: 'room-1',
            topicId: 'room.ai.accepted',
            typeId: 'rallar.ai.accepted',
        });

        await tracker.acceptOnce(accepted, (result) => {
            gameEvents.push(result.value);
        });
        await tracker.acceptOnce(accepted, (result) => {
            gameEvents.push(result.value);
        });

        expect(gameEvents).toEqual([{ kind: 'spawn' }]);
        expect(rallar.messages.rtc.send).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'room.ai.proposals',
                typeId: 'rallar.ai.proposed',
                payload: proposed,
            }),
        );
        expect(rallar.messages.ws.send).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'room.ai.accepted',
                typeId: 'rallar.ai.accepted',
                payload: accepted,
            }),
        );
    });

    it('persists generated envelopes through Rallar data', async () => {
        const rallar = createFakeRallar();
        const ai = createRallarBrowserAi({
            rallar,
            provider: createRallarAiMockProvider({ value: { kind: 'spawn' } }),
        });
        const result = await ai.generateJson({
            schemaId: 'game-event',
            schemaVersion: '1',
            schema,
            prompt: 'generate',
        });

        await ai.persistJson({
            result,
            storeName: 'ai-results',
            key: 'result-1',
            scope: 'session',
        });

        expect(rallar.data.open).toHaveBeenCalledWith('ai-results', {
            durability: 'write-behind',
            schemaVersion: 1,
            scope: 'session',
        });
        expect(rallar.store.set).toHaveBeenCalledWith('result-1', result);
    });

    it('supports dynamic import of the browser WebLLM provider entry point', async () => {
        const { createWebLlmRallarAiProvider } = await import(
            '@shared-web/browser/rallar-ai-providers/webllm.ts'
        );
        const runtime = {
            generateJson: vi.fn(async (input: unknown) => {
                expect(JSON.stringify(input)).toContain('Generate a spawn');
                return { json: { kind: 'spawn' } };
            }),
        };
        const provider = createWebLlmRallarAiProvider({
            modelId: 'webllm-test-model',
            runtime,
            typicalColdStartMs: 100,
        });
        const ai = createRallarBrowserAi({
            rallar: createFakeRallar(),
            provider,
        });

        const result = await ai.generateJson({
            requestId: 'webllm-request',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema,
            prompt: 'Generate a spawn.',
        });

        expect(provider.capabilities).toEqual(
            expect.objectContaining({
                target: 'browser',
                typicalColdStartMs: 100,
            }),
        );
        expect(runtime.generateJson).toHaveBeenCalledOnce();
        expect(result).toEqual(
            expect.objectContaining({
                providerId: 'webllm',
                modelId: 'webllm-test-model',
                source: 'browser',
                value: { kind: 'spawn' },
                validation: expect.objectContaining({ ok: true }),
            }),
        );
    });
});

function createFakeRallar() {
    const store = {
        set: vi.fn(async () => undefined),
    };
    return {
        store,
        data: {
            open: vi.fn(async () => store),
        },
        realtime: {
            sendJson: vi.fn(async () => []),
        },
        messages: {
            rtc: {
                send: vi.fn(async () => ({
                    transport: 'rtc',
                    status: 'queued',
                    entries: [],
                })),
            },
            ws: {
                send: vi.fn(async () => ({
                    transport: 'ws',
                    status: 'queued',
                    entries: [],
                })),
            },
        },
    };
}
