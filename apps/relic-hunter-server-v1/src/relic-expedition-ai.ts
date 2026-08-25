import {
    assertRelicExpeditionBlueprint,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    RELIC_EXPEDITION_BLUEPRINT_LIMITS,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA_ID,
    RELIC_EXPEDITION_BLUEPRINT_SCHEMA_VERSION,
    RELIC_EXPEDITION_VISUAL_LIMITS,
    RELIC_EXPEDITION_VISUAL_THEMES,
    RELIC_ROOM_KINDS,
    validateRelicExpeditionBlueprint,
    validateRelicExpeditionVisualFit,
    type RelicExpeditionBlueprint,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import {
    createRallarAiOllamaProvider,
    type RallarAiOllamaFetch
} from '@shared-server/rallar-ai/create-rallar-ai-ollama-provider.ts';
import { createRallarServerAi } from '@shared-server/rallar-ai/create-rallar-server-ai.ts';
import type { RallarServerAiJsonRequest } from '@shared-server/rallar-ai/decode-rallar-server-ai-json-request.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    createRallarAiMockProvider,
    defineRallarAiProviderGovernanceMetadata,
    isRallarAiLiveEvaluationEnabled,
    runRallarAiEvaluationSuite,
    runRallarAiEvaluationSuiteIfEnabled,
    type RallarAiDiagnosticsSink,
    type RallarAiEvaluationCase,
    type RallarAiEvaluationSuiteResult,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiLiveEvaluationEnvironment,
    type RallarAiLiveEvaluationRunResult
} from '@shared/rallar-ai/mod.ts';
import type { RelicAiExpeditionConfiguration, RelicAiExpeditionMode } from './relic-hunter-server-configuration.ts';

export type RelicInitialStateReason = 'ensure' | 'reset' | 'command';

export type RelicInitialStateFactory = (
    gameId: string,
    reason: RelicInitialStateReason
) => Promise<RelicGameState>;

export interface RelicAiExpeditionFallbackEvent {
    readonly gameId: string;
    readonly reason: RelicInitialStateReason;
    readonly mode: RelicAiExpeditionMode;
    readonly seed: string;
    readonly error: string;
}

export interface CreateRelicExpeditionInitialStateFactoryOptions {
    readonly configuration: RelicAiExpeditionConfiguration;
    readonly fetch?: RallarAiOllamaFetch;
    readonly provider?: RallarAiJsonProvider;
    readonly mockBlueprint?:
        | RelicExpeditionBlueprint
        | ((
            input: Readonly<{ gameId: string; reason: RelicInitialStateReason; seed: string; }>
        ) => RelicExpeditionBlueprint);
    readonly now?: () => number;
    readonly diagnostics?: RallarAiDiagnosticsSink;
    readonly onFallback?: (event: RelicAiExpeditionFallbackEvent) => void;
}

export const RELIC_EXPEDITION_OLLAMA_PROVIDER_ID = 'relic-expedition-ollama';
export const RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE = 'RALLAR_AI_LIVE_OLLAMA';
export const RELIC_EXPEDITION_OLLAMA_PROVIDER_GOVERNANCE = defineRallarAiProviderGovernanceMetadata(
    {
        providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
        adapterVersion: 'relic-hunter-server-v1/ollama-expedition:1',
        modelId: 'llama-test',
        target: 'server',
        licenseNotes: 'Runs through a private Ollama sidecar; model license follows RELIC_AI_EXPEDITION_OLLAMA_MODEL.',
        productionAllowed: false,
        structuredOutput: true,
        knownLimits: {
            maxOutputTokens: 1_600,
            recommendedTimeoutMs: 15_000
        }
    }
);

export function createRelicExpeditionInitialStateFactory(
    options: CreateRelicExpeditionInitialStateFactoryOptions
): RelicInitialStateFactory {
    const mode = options.configuration.mode;
    const now = options.now ?? (() => Date.now());

    if (mode === 'off') {
        return (gameId) => Promise.resolve(createRelicGame(gameId, gameId, now()));
    }

    const provider = options.provider ?? createProvider(options, mode);
    const ai = createRallarServerAi({
        provider,
        policy: {
            mode: 'server-only',
            timeoutMs: options.configuration.timeoutMs
        },
        diagnostics: options.diagnostics,
        limits: {
            maxConcurrentGenerations: 2,
            maxRequestBytes: 96 * 1024,
            maxPromptBytes: 12 * 1024,
            maxSchemaBytes: 32 * 1024,
            maxContextBytes: 16 * 1024
        }
    });

    return async (gameId, reason) => {
        const createdAt = now();
        const seed = createExpeditionSeed(gameId, reason, createdAt);
        const request = createRelicExpeditionAiRequest({
            gameId,
            reason,
            seed,
            timeoutMs: options.configuration.timeoutMs
        });

        try {
            const result = await ai.generateJson(
                request,
                { roomId: gameId }
            );
            assertRelicExpeditionBlueprint(result.value);

            const visualFit = validateRelicExpeditionVisualFit(result.value);
            if (!visualFit.ok) {
                throw new Error(
                    `Generated blueprint failed Relic visual fit: ${visualFit.errors.join('; ')}`
                );
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
                    blueprintId: result.generationId
                }
            );
        }
        catch (error) {
            options.onFallback?.({
                gameId,
                reason,
                mode,
                seed,
                error: toErrorMessage(error)
            });
            return createRelicGameFromBlueprint(
                gameId,
                gameId,
                createProceduralRelicExpeditionBlueprint({
                    seed,
                    source: 'procedural'
                }),
                createdAt,
                {
                    source: 'procedural',
                    seed,
                    blueprintId: `procedural:${seed}`
                }
            );
        }
    };
}

export interface CreateRelicExpeditionAiRequestInput {
    readonly gameId: string;
    readonly reason: RelicInitialStateReason;
    readonly seed: string;
    readonly timeoutMs: number;
}

export function createRelicExpeditionAiRequest(
    input: CreateRelicExpeditionAiRequestInput
): RallarServerAiJsonRequest {
    return {
        requestId: `relic-expedition:${input.gameId}:${input.reason}:${input.seed}`,
        schemaId: RELIC_EXPEDITION_BLUEPRINT_SCHEMA_ID,
        schemaVersion: RELIC_EXPEDITION_BLUEPRINT_SCHEMA_VERSION,
        schema: RELIC_EXPEDITION_BLUEPRINT_SCHEMA,
        prompt: [
            'Generate a Relic Hunters expedition blueprint as JSON only.',
            'Create a playable, fresh, sunlit Japanese castle adventure with varied room names and reward placement.',
            'Use a bright tactical footprint that fits the browser UI and camera; avoid gloomy, haunted, ruined, or oversized castle layouts.',
            'Keep canonical room ids entrance and exit exactly as written.',
            'Use only the allowed room kinds and make every neighbor relationship symmetric.',
            'Every room must be reachable from entrance, and exit must be reachable.',
            'Use one of the allowed visual themes exactly, integer coordinates, compact room names, and short readable room edges.',
            'Do not include collapsed or unstable rooms at setup time.'
        ].join(' '),
        context: {
            gameId: input.gameId,
            reason: input.reason,
            seed: input.seed,
            canonicalIds: ['entrance', 'exit'],
            allowedRoomKinds: RELIC_ROOM_KINDS,
            allowedVisualThemes: RELIC_EXPEDITION_VISUAL_THEMES,
            limits: RELIC_EXPEDITION_BLUEPRINT_LIMITS,
            visualLimits: RELIC_EXPEDITION_VISUAL_LIMITS
        },
        baseStateRevision: `relic-expedition-setup:${input.gameId}:${input.reason}`,
        dedupeKey: `relic-expedition:${input.gameId}:${input.reason}:${input.seed}`,
        temperature: 0.65,
        maxOutputTokens: 1_600,
        timeoutMs: input.timeoutMs
    };
}

export interface CreateRelicExpeditionAiEvaluationCasesOptions {
    readonly gameId: string;
    readonly reason: RelicInitialStateReason;
    readonly seed: string;
    readonly timeoutMs: number;
}

export interface RunRelicExpeditionDeterministicAiEvaluationOptions
    extends CreateRelicExpeditionAiEvaluationCasesOptions {
    readonly mockBlueprint?:
        | RelicExpeditionBlueprint
        | ((
            input: Readonly<{ gameId: string; reason: RelicInitialStateReason; seed: string; }>
        ) => RelicExpeditionBlueprint);
}

export interface RunRelicExpeditionOllamaLiveEvaluationOptions {
    readonly env: RallarAiLiveEvaluationEnvironment;
    readonly configuration: RelicAiExpeditionConfiguration;
    readonly gate?: string;
    readonly cases?: readonly RallarAiEvaluationCase[];
    readonly provider?: RallarAiJsonProvider;
    readonly fetch?: RallarAiOllamaFetch;
    readonly allowedBaseUrls?: readonly string[];
}

export function createRelicExpeditionAiEvaluationCases(
    options: CreateRelicExpeditionAiEvaluationCasesOptions
): readonly RallarAiEvaluationCase[] {
    return [
        {
            caseId: 'expedition-blueprint',
            request: createRelicExpeditionAiRequest({
                gameId: options.gameId,
                reason: options.reason,
                seed: options.seed,
                timeoutMs: options.timeoutMs
            }),
            validateResult: (result) => validateExpeditionEvaluationBlueprint(result.value)
        }
    ];
}

export async function runRelicExpeditionDeterministicAiEvaluation(
    options: RunRelicExpeditionDeterministicAiEvaluationOptions
): Promise<RallarAiEvaluationSuiteResult> {
    return await runRallarAiEvaluationSuite({
        suiteId: 'relic-expedition-ollama-ci',
        provider: createMockRelicExpeditionProvider(options.mockBlueprint),
        cases: createRelicExpeditionAiEvaluationCases(options)
    });
}

export async function runRelicExpeditionOllamaLiveEvaluationIfEnabled(
    options: RunRelicExpeditionOllamaLiveEvaluationOptions
): Promise<RallarAiLiveEvaluationRunResult> {
    const gate = options.gate ?? RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE;
    if (!isRallarAiLiveEvaluationEnabled(options.env, gate)) {
        return {
            status: 'skipped',
            gate,
            reason: `Relic Ollama live evaluation requires ${gate}=1.`
        };
    }

    const baseUrl = options.configuration.ollamaBaseUrl;
    const provider = options.provider ?? createRallarAiOllamaProvider({
        providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
        model: options.configuration.ollamaModel,
        baseUrl,
        allowedBaseUrls: options.allowedBaseUrls ?? [
            baseUrl,
            'http://127.0.0.1:11434',
            'http://localhost:11434',
            'http://[::1]:11434'
        ],
        fetch: options.fetch,
        systemPrompt: [
            'You generate strict JSON for a turn-based multiplayer castle game.',
            'The application will reject unsafe, disconnected, or unbalanced data.'
        ].join(' ')
    });

    return await runRallarAiEvaluationSuiteIfEnabled({
        suiteId: 'relic-expedition-ollama-live',
        provider,
        cases: options.cases ?? createRelicExpeditionAiEvaluationCases({
            gameId: 'relic-expedition-live-evaluation',
            reason: 'ensure',
            seed: 'relic-expedition-live-evaluation',
            timeoutMs: options.configuration.timeoutMs
        }),
        env: options.env,
        gate,
        providerLabel: 'Relic Ollama'
    });
}

function createProvider(
    options: CreateRelicExpeditionInitialStateFactoryOptions,
    mode: Exclude<RelicAiExpeditionMode, 'off'>
): RallarAiJsonProvider {
    if (mode === 'mock') {
        return createMockRelicExpeditionProvider(options.mockBlueprint);
    }

    return createRallarAiOllamaProvider({
        providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
        model: options.configuration.ollamaModel,
        baseUrl: options.configuration.ollamaBaseUrl,
        fetch: options.fetch,
        systemPrompt: [
            'You generate strict JSON for a turn-based multiplayer castle game.',
            'The application will reject unsafe, disconnected, or unbalanced data.'
        ].join(' ')
    });
}

function createMockRelicExpeditionProvider(
    mockBlueprint: CreateRelicExpeditionInitialStateFactoryOptions['mockBlueprint']
): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'relic-expedition-mock',
        modelId: 'deterministic-expedition-blueprint-v1',
        value: (request: RallarAiJsonRequest) => {
            const context = decodeRelicExpeditionMockContext(request.context);
            const input = {
                gameId: context?.gameId ?? 'relic-room',
                reason: context?.reason ?? 'ensure',
                seed: context?.seed ?? 'relic-mock-seed'
            };
            return typeof mockBlueprint === 'function'
                ? mockBlueprint(input)
                : mockBlueprint ??
                    createProceduralRelicExpeditionBlueprint({
                        seed: input.seed,
                        source: 'mock'
                    });
        }
    });
}

interface RelicExpeditionMockContext {
    readonly gameId?: string;
    readonly reason?: RelicInitialStateReason;
    readonly seed?: string;
}

function decodeRelicExpeditionMockContext(
    value: RallarAiJsonRequest['context']
): RelicExpeditionMockContext | undefined {
    if (value === undefined) {
        return undefined;
    }
    const context = decodeJsonWireValue(value, 'Relic expedition mock context');
    if (!isJsonWireObject(context)) {
        return undefined;
    }
    return {
        gameId: typeof context.gameId === 'string' ? context.gameId : undefined,
        reason: isRelicInitialStateReason(context.reason) ? context.reason : undefined,
        seed: typeof context.seed === 'string' ? context.seed : undefined
    };
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRelicInitialStateReason(
    value: JsonWireValue | undefined
): value is RelicInitialStateReason {
    return value === 'ensure' || value === 'reset' || value === 'command';
}

function validateExpeditionEvaluationBlueprint(
    blueprint: unknown
): readonly string[] {
    const validation = validateRelicExpeditionBlueprint(blueprint);
    const visualFit = validateRelicExpeditionVisualFit(blueprint);
    return [
        ...validation.errors.map((error) => `blueprint: ${error}`),
        ...visualFit.errors.map((error) => `visual-fit: ${error}`)
    ];
}

function createExpeditionSeed(
    gameId: string,
    reason: RelicInitialStateReason,
    now: number
): string {
    return `${gameId}:${reason}:${now}`;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
