import {
    assertRallarAiAuthorized,
    assertRallarAiResultLifecycleTransition,
    canonicalRallarAiJson,
    createRallarAiAcceptedResultTracker,
    createRallarAiFakeSidecarProvider,
    createRallarAiFunnyRoomName,
    createRallarAiMockProvider,
    createRallarAiRoomNameSeed,
    createRallarAiSchemaRegistry,
    defineRallarAiProviderGovernanceMetadata,
    defineRallarAiTransportPolicy,
    hashRallarAiJson,
    isRallarAiProviderAllowedInProduction,
    RallarAiError,
    runRallarAiEvaluationSuite,
    runRallarAiEvaluationSuiteIfEnabled,
    selectRallarAiProviders,
    summarizeRallarAiReplayLog,
    transitionRallarAiResultLifecycle,
    validateRallarAiJsonSchemaValue,
    validateRallarAiProviderCapabilities
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';

describe('RallarAI shared contracts', () => {
    const gameEventSchema = {
        type: 'object',
        required: ['kind', 'amount'],
        properties: {
            kind: { type: 'string', enum: ['spawn', 'reward'] },
            amount: { type: 'integer', minimum: 1 }
        },
        additionalProperties: false
    } as const;

    it('canonicalizes and hashes JSON independent of object property order', () => {
        expect(canonicalRallarAiJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
        expect(hashRallarAiJson({ b: 2, a: 1 })).toBe(
            hashRallarAiJson({ a: 1, b: 2 })
        );
    });

    it('validates the supported JSON schema subset', () => {
        expect(
            validateRallarAiJsonSchemaValue(gameEventSchema, {
                kind: 'spawn',
                amount: 2
            }).ok
        ).toBe(true);

        const invalid = validateRallarAiJsonSchemaValue(gameEventSchema, {
            kind: 'spawn',
            amount: 0,
            extra: true
        });

        expect(invalid.ok).toBe(false);
        expect(invalid.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining(['minimum', 'additional-property'])
        );
    });

    it('registers schemas with stable hashes and compatibility metadata', () => {
        const registry = createRallarAiSchemaRegistry()
            .register({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema: gameEventSchema
            })
            .register({
                schemaId: 'game-event',
                schemaVersion: '2',
                schema: gameEventSchema,
                compatibleWith: ['1']
            });

        expect(registry.require('game-event', '1').schemaHash).toMatch(
            /^rallar-ai-fnv1a32:/
        );
        expect(registry.isCompatible('game-event', '1', '2')).toBe(true);
        expect(registry.isCompatible('game-event', '2', '1')).toBe(false);
    });

    it('creates deterministic mock provider envelopes', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'reward', amount: 3 },
            createdAtEpochMs: 1_000
        });

        const result = await provider.generateJson({
            requestId: 'request-1',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: gameEventSchema,
            prompt: 'Generate a reward.',
            dedupeKey: 'turn-1'
        });

        expect(result).toMatchObject({
            protocolVersion: 1,
            requestId: 'request-1',
            generationId: 'mock:request-1',
            dedupeKey: 'turn-1',
            source: 'mock',
            providerId: 'mock',
            validation: { ok: true },
            lifecycle: 'draft'
        });
        expect(result.schemaHash).toMatch(/^rallar-ai-fnv1a32:/);
        expect(result.promptHash).toMatch(/^rallar-ai-fnv1a32:/);
    });

    it('creates deterministic funny room names for game groups', () => {
        const first = createRallarAiFunnyRoomName({
            baseName: 'AR Eye Hunter Arena',
            theme: 'ar-eye-hunter',
            seed: 'arena-seed-1'
        });
        const same = createRallarAiFunnyRoomName({
            baseName: 'AR Eye Hunter Arena',
            theme: 'ar-eye-hunter',
            seed: 'arena-seed-1'
        });
        const different = createRallarAiFunnyRoomName({
            baseName: 'AR Eye Hunter Arena',
            theme: 'ar-eye-hunter',
            seed: 'arena-seed-2'
        });

        expect(first).toBe(same);
        expect(first).not.toBe(different);
        expect(first).toContain('AR Eye Hunter Arena');
        expect(first).toMatch(/^AR Eye Hunter Arena: [A-Za-z]+ [A-Za-z]+ #[0-9A-F]{6}$/);
        expect(first.length).toBeLessThanOrEqual(72);
    });

    it('avoids funny room name collisions and keeps fallback names compact', () => {
        const existingNames: string[] = [];

        for (let index = 0; index < 70; index += 1) {
            const name = createRallarAiFunnyRoomName({
                baseName: 'Relic Hunters Expedition',
                theme: 'relic-hunters',
                seed: 'crowded-expedition',
                existingNames
            });

            expect(existingNames.map((existing) => existing.toLowerCase()))
                .not.toContain(name.toLowerCase());
            expect(name).toContain('Relic Hunters Expedition');
            expect(name).toMatch(/^Relic Hunters Expedition: .+ #[0-9A-F]{6}/);
            expect(name.length).toBeLessThanOrEqual(72);
            existingNames.push(name);
        }

        expect(new Set(existingNames).size).toBe(existingNames.length);
    });

    it('creates room name seeds with the requested prefix', () => {
        expect(createRallarAiRoomNameSeed('test-room')).toMatch(/^test-room:/);
    });

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

    it('enforces authorization hooks and lifecycle transitions', async () => {
        await expect(
            assertRallarAiAuthorized(() => false, {
                action: 'generate',
                source: 'server',
                schemaId: 'game-event',
                schemaVersion: '1'
            })
        ).rejects.toThrow('RallarAI action is not authorized');

        expect(() => assertRallarAiResultLifecycleTransition('accepted', 'draft')).toThrow('Invalid RallarAI lifecycle transition');
        expect(() => assertRallarAiResultLifecycleTransition('proposed', 'accepted')).not.toThrow();
    });

    it('applies accepted proposal envelopes once and summarizes replay metadata', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });
        const result = await provider.generateJson({
            requestId: 'request-approval',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: gameEventSchema,
            prompt: 'Generate a spawn.',
            dedupeKey: 'room:1:turn:7'
        });
        const proposed = transitionRallarAiResultLifecycle(result, 'proposed');
        const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
        const tracker = createRallarAiAcceptedResultTracker<typeof accepted.value>();
        const applied: unknown[] = [];

        await expect(
            tracker.acceptOnce(proposed, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: false,
            dedupeId: 'room:1:turn:7',
            reason: 'not-accepted'
        });
        await expect(
            tracker.acceptOnce(accepted, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: true,
            dedupeId: 'room:1:turn:7'
        });
        await expect(
            tracker.acceptOnce(accepted, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: false,
            dedupeId: 'room:1:turn:7',
            reason: 'duplicate'
        });

        expect(applied).toEqual([{ kind: 'spawn', amount: 1 }]);
        expect(tracker.snapshot()).toEqual(['room:1:turn:7']);
        expect(summarizeRallarAiReplayLog([accepted, accepted])).toEqual(
            expect.objectContaining({
                total: 2,
                accepted: 2,
                validationFailed: 0,
                duplicateDedupeIds: ['room:1:turn:7']
            })
        );
    });

    it('defines transport policy defaults', () => {
        expect(defineRallarAiTransportPolicy({
            delivery: 'persisted'
        })).toMatchObject({
            delivery: 'persisted',
            ordering: 'none',
            acknowledgement: 'none',
            conflictPolicy: 'app-defined'
        });
    });

    it('uses the fake sidecar provider without a real model', async () => {
        const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({
                schemaId: 'game-event',
                prompt: 'Generate a spawn.'
            });
            return new Response(JSON.stringify({ kind: 'spawn', amount: 1 }), {
                status: 200
            });
        });
        const provider = createRallarAiFakeSidecarProvider({
            baseUrl: 'http://127.0.0.1:11434',
            fetch
        });

        const result = await provider.generateJson({
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: gameEventSchema,
            prompt: 'Generate a spawn.'
        });

        expect(fetch).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            source: 'server',
            providerId: 'fake-sidecar-http',
            value: { kind: 'spawn', amount: 1 },
            validation: { ok: true }
        });
    });

    it('runs deterministic mock-provider evaluations without live AI', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });

        const report = await runRallarAiEvaluationSuite({
            suiteId: 'game-event-smoke',
            provider,
            cases: [
                {
                    caseId: 'spawn-event',
                    request: {
                        schemaId: 'game-event',
                        schemaVersion: '1',
                        schema: gameEventSchema,
                        prompt: 'Generate a spawn.'
                    },
                    expectedValue: { amount: 1, kind: 'spawn' },
                    validateResult: (result) =>
                        result.promptHash.startsWith('rallar-ai-fnv1a32:')
                            ? []
                            : ['missing prompt hash']
                }
            ]
        });

        expect(report).toMatchObject({
            suiteId: 'game-event-smoke',
            providerId: 'mock',
            passed: 1,
            failed: 0,
            results: [
                expect.objectContaining({
                    providerId: 'mock',
                    validationOk: true
                })
            ]
        });
    });

    it('gates optional live evaluation runs behind environment variables', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });
        const cases = [
            {
                caseId: 'spawn-event',
                request: {
                    schemaId: 'game-event',
                    schemaVersion: '1',
                    schema: gameEventSchema,
                    prompt: 'Generate a spawn.'
                },
                expectedValue: { kind: 'spawn', amount: 1 }
            }
        ];

        await expect(
            runRallarAiEvaluationSuiteIfEnabled({
                suiteId: 'ollama-live-smoke',
                provider,
                cases,
                env: {},
                gate: 'RALLAR_AI_LIVE_OLLAMA',
                providerLabel: 'Ollama'
            })
        ).resolves.toEqual(
            expect.objectContaining({
                status: 'skipped',
                gate: 'RALLAR_AI_LIVE_OLLAMA'
            })
        );

        await expect(
            runRallarAiEvaluationSuiteIfEnabled({
                suiteId: 'ollama-live-smoke',
                provider,
                cases,
                env: { RALLAR_AI_LIVE_OLLAMA: '1' },
                gate: 'RALLAR_AI_LIVE_OLLAMA',
                providerLabel: 'Ollama'
            })
        ).resolves.toEqual(
            expect.objectContaining({
                status: 'ran',
                report: expect.objectContaining({
                    suiteId: 'ollama-live-smoke',
                    passed: 1,
                    failed: 0
                })
            })
        );
    });
});
