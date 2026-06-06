import {
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    RELIC_EXPEDITION_BLUEPRINT_LIMITS,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA_ID,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA_VERSION,
    RELIC_ROOM_KINDS,
    validateRelicExpeditionBlueprint,
    type RelicExpeditionBlueprint,
    type RelicGameState,
} from '@relic-hunters/mod.ts';
import {
    createRallarAiMockProvider,
    type RallarAiDiagnosticsSink,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
} from '@shared/rallar-ai/mod.ts';
import {
    createRallarAiOllamaProvider,
    createRallarServerAi,
    type RallarAiOllamaFetch,
    type RallarServerAiRallar,
} from '@shared-server/rallar-ai/mod.ts';

export type RelicAiExpeditionMode = 'off' | 'mock' | 'ollama';

export type RelicInitialStateReason = 'ensure' | 'reset' | 'command';

export type RelicInitialStateFactory = (
    gameId: string,
    reason: RelicInitialStateReason,
) => Promise<RelicGameState>;

export type RelicAiExpeditionEnv = Readonly<{
    mode: RelicAiExpeditionMode;
    timeoutMs: number;
    ollamaBaseUrl: string;
    ollamaModel: string;
}>;

export type RelicAiExpeditionFallbackEvent = Readonly<{
    gameId: string;
    reason: RelicInitialStateReason;
    mode: RelicAiExpeditionMode;
    seed: string;
    error: string;
}>;

export type CreateRelicExpeditionInitialStateFactoryOptions = Readonly<{
    rallar?: RallarServerAiRallar;
    mode?: RelicAiExpeditionMode;
    timeoutMs?: number;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    fetch?: RallarAiOllamaFetch;
    provider?: RallarAiJsonProvider;
    mockBlueprint?: RelicExpeditionBlueprint | ((
        input: Readonly<{ gameId: string; reason: RelicInitialStateReason; seed: string }>,
    ) => RelicExpeditionBlueprint);
    now?: () => number;
    diagnostics?: RallarAiDiagnosticsSink;
    onFallback?: (event: RelicAiExpeditionFallbackEvent) => void;
}>;

const DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS = 15_000;
const DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL = 'llama-test';

export function readRelicAiExpeditionEnv(
    env: Readonly<{ get(name: string): string | undefined }>,
): RelicAiExpeditionEnv {
    return {
        mode: readMode(env.get('RELIC_AI_EXPEDITION_MODE')),
        timeoutMs: readPositiveInteger(
            env.get('RELIC_AI_EXPEDITION_TIMEOUT_MS'),
            DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS,
        ),
        ollamaBaseUrl: env.get('RELIC_AI_EXPEDITION_OLLAMA_BASE_URL') ??
            DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL,
        ollamaModel: env.get('RELIC_AI_EXPEDITION_OLLAMA_MODEL') ??
            DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL,
    };
}

export function createRelicExpeditionInitialStateFactory(
    options: CreateRelicExpeditionInitialStateFactoryOptions = {},
): RelicInitialStateFactory {
    const mode = options.mode ?? 'off';
    const now = options.now ?? (() => Date.now());

    if (mode === 'off') {
        return async (gameId) => createRelicGame(gameId, gameId, now());
    }

    const rallar = options.rallar;
    if (!rallar) {
        throw new Error('Relic AI expedition generation requires a Rallar server facade.');
    }

    const provider = options.provider ?? createProvider(options, mode);
    const ai = createRallarServerAi({
        rallar,
        provider,
        policy: {
            mode: 'server-only',
            timeoutMs: options.timeoutMs ?? DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS,
        },
        diagnostics: options.diagnostics,
        limits: {
            maxConcurrentGenerations: 2,
            maxRequestBytes: 96 * 1024,
            maxPromptBytes: 12 * 1024,
            maxSchemaBytes: 32 * 1024,
            maxContextBytes: 16 * 1024,
        },
    });

    return async (gameId, reason) => {
        const createdAt = now();
        const seed = createExpeditionSeed(gameId, reason, createdAt);
        const request = createRelicExpeditionAiRequest({
            gameId,
            reason,
            seed,
            timeoutMs: options.timeoutMs ?? DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS,
        });

        try {
            const result = await ai.generateJson<RelicExpeditionBlueprint>(
                request,
                { roomId: gameId },
            );
            const validation = validateRelicExpeditionBlueprint(result.value);
            if (!validation.ok) {
                throw new Error(`Generated blueprint failed Relic validation: ${validation.errors.join('; ')}`);
            }
            return createRelicGameFromBlueprint(
                gameId,
                gameId,
                result.value,
                createdAt,
                {
                    source: mode === 'mock' ? 'mock' : 'rallar-ai',
                    seed: result.value.seed,
                    theme: result.value.theme,
                    blueprintId: result.generationId,
                },
            );
        } catch (error) {
            options.onFallback?.({
                gameId,
                reason,
                mode,
                seed,
                error: toErrorMessage(error),
            });
            return createRelicGameFromBlueprint(
                gameId,
                gameId,
                createProceduralRelicExpeditionBlueprint({
                    seed,
                    source: 'procedural',
                }),
                createdAt,
                {
                    source: 'procedural',
                    seed,
                    blueprintId: `procedural:${seed}`,
                },
            );
        }
    };
}

export function createRelicExpeditionAiRequest({
    gameId,
    reason,
    seed,
    timeoutMs,
}: Readonly<{
    gameId: string;
    reason: RelicInitialStateReason;
    seed: string;
    timeoutMs: number;
}>): RallarAiJsonRequest {
    return {
        requestId: `relic-expedition:${gameId}:${reason}:${seed}`,
        schemaId: RELIC_EXPEDITION_BLUEPRINT_SCHEMA_ID,
        schemaVersion: RELIC_EXPEDITION_BLUEPRINT_SCHEMA_VERSION,
        schema: RELIC_EXPEDITION_BLUEPRINT_SCHEMA,
        prompt: [
            'Generate a Relic Hunters expedition blueprint as JSON only.',
            'Create a playable Japanese castle maze with varied room names and reward placement.',
            'Keep canonical room ids entrance and exit exactly as written.',
            'Use only the allowed room kinds and make every neighbor relationship symmetric.',
            'Every room must be reachable from entrance, and exit must be reachable.',
            'Do not include collapsed or unstable rooms at setup time.',
        ].join(' '),
        context: {
            gameId,
            reason,
            seed,
            canonicalIds: ['entrance', 'exit'],
            allowedRoomKinds: RELIC_ROOM_KINDS,
            limits: RELIC_EXPEDITION_BLUEPRINT_LIMITS,
        },
        baseStateRevision: `relic-expedition-setup:${gameId}:${reason}`,
        dedupeKey: `relic-expedition:${gameId}:${reason}:${seed}`,
        temperature: 0.65,
        maxOutputTokens: 1_600,
        timeoutMs,
    };
}

function createProvider(
    options: CreateRelicExpeditionInitialStateFactoryOptions,
    mode: Exclude<RelicAiExpeditionMode, 'off'>,
): RallarAiJsonProvider {
    if (mode === 'mock') {
        return createRallarAiMockProvider({
            providerId: 'relic-expedition-mock',
            modelId: 'deterministic-expedition-blueprint-v1',
            value: (request: RallarAiJsonRequest) => {
                const context = request.context as {
                    gameId?: string;
                    reason?: RelicInitialStateReason;
                    seed?: string;
                } | undefined;
                const input = {
                    gameId: context?.gameId ?? 'relic-room',
                    reason: context?.reason ?? 'ensure',
                    seed: context?.seed ?? 'relic-mock-seed',
                };
                return typeof options.mockBlueprint === 'function'
                    ? options.mockBlueprint(input)
                    : options.mockBlueprint ??
                        createProceduralRelicExpeditionBlueprint({
                            seed: input.seed,
                            source: 'mock',
                        });
            },
        });
    }

    return createRallarAiOllamaProvider({
        model: options.ollamaModel ?? DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL,
        baseUrl: options.ollamaBaseUrl ?? DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL,
        fetch: options.fetch,
        systemPrompt: [
            'You generate strict JSON for a turn-based multiplayer castle game.',
            'The application will reject unsafe, disconnected, or unbalanced data.',
        ].join(' '),
    });
}

function createExpeditionSeed(
    gameId: string,
    reason: RelicInitialStateReason,
    now: number,
): string {
    return `${gameId}:${reason}:${now}`;
}

function readMode(value: string | undefined): RelicAiExpeditionMode {
    if (value === 'mock' || value === 'ollama') {
        return value;
    }
    return 'off';
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
