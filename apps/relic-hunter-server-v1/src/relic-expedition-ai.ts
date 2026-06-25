import {
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
  type RelicExpeditionBlueprint,
  type RelicGameState,
  validateRelicExpeditionBlueprint,
  validateRelicExpeditionVisualFit,
} from '@relic-hunters/mod.ts';
import {
  createRallarAiMockProvider,
  defineRallarAiProviderGovernanceMetadata,
  isRallarAiLiveEvaluationEnabled,
  type RallarAiDiagnosticsSink,
  type RallarAiEvaluationCase,
  type RallarAiEvaluationSuiteResult,
  type RallarAiJsonProvider,
  type RallarAiJsonRequest,
  type RallarAiLiveEvaluationEnvironment,
  type RallarAiLiveEvaluationRunResult,
  runRallarAiEvaluationSuite,
  runRallarAiEvaluationSuiteIfEnabled,
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
  mockBlueprint?:
    | RelicExpeditionBlueprint
    | ((
      input: Readonly<{ gameId: string; reason: RelicInitialStateReason; seed: string }>,
    ) => RelicExpeditionBlueprint);
  now?: () => number;
  diagnostics?: RallarAiDiagnosticsSink;
  onFallback?: (event: RelicAiExpeditionFallbackEvent) => void;
}>;

export const DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS = 15_000;
export const DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL = 'llama-test';
export const RELIC_EXPEDITION_OLLAMA_PROVIDER_ID = 'relic-expedition-ollama';
export const RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE = 'RALLAR_AI_LIVE_OLLAMA';
export const RELIC_EXPEDITION_OLLAMA_PROVIDER_GOVERNANCE = defineRallarAiProviderGovernanceMetadata(
  {
    providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
    adapterVersion: 'relic-hunter-server-v1/ollama-expedition:1',
    modelId: DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL,
    target: 'server',
    licenseNotes:
      'Runs through a private Ollama sidecar; model license follows RELIC_AI_EXPEDITION_OLLAMA_MODEL.',
    productionAllowed: false,
    structuredOutput: true,
    knownLimits: {
      maxOutputTokens: 1_600,
      recommendedTimeoutMs: DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS,
    },
  },
);

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
    return (gameId) => Promise.resolve(createRelicGame(gameId, gameId, now()));
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
        throw new Error(
          `Generated blueprint failed Relic validation: ${validation.errors.join('; ')}`,
        );
      }
      const visualFit = validateRelicExpeditionVisualFit(result.value);
      if (!visualFit.ok) {
        throw new Error(
          `Generated blueprint failed Relic visual fit: ${visualFit.errors.join('; ')}`,
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
      'Create a playable, fresh, sunlit Japanese castle adventure with varied room names and reward placement.',
      'Use a bright tactical footprint that fits the browser UI and camera; avoid gloomy, haunted, ruined, or oversized castle layouts.',
      'Keep canonical room ids entrance and exit exactly as written.',
      'Use only the allowed room kinds and make every neighbor relationship symmetric.',
      'Every room must be reachable from entrance, and exit must be reachable.',
      'Use one of the allowed visual themes exactly, integer coordinates, compact room names, and short readable room edges.',
      'Do not include collapsed or unstable rooms at setup time.',
    ].join(' '),
    context: {
      gameId,
      reason,
      seed,
      canonicalIds: ['entrance', 'exit'],
      allowedRoomKinds: RELIC_ROOM_KINDS,
      allowedVisualThemes: RELIC_EXPEDITION_VISUAL_THEMES,
      limits: RELIC_EXPEDITION_BLUEPRINT_LIMITS,
      visualLimits: RELIC_EXPEDITION_VISUAL_LIMITS,
    },
    baseStateRevision: `relic-expedition-setup:${gameId}:${reason}`,
    dedupeKey: `relic-expedition:${gameId}:${reason}:${seed}`,
    temperature: 0.65,
    maxOutputTokens: 1_600,
    timeoutMs,
  };
}

export type CreateRelicExpeditionAiEvaluationCasesOptions = Readonly<{
  gameId: string;
  reason: RelicInitialStateReason;
  seed: string;
  timeoutMs?: number;
}>;

export type RunRelicExpeditionDeterministicAiEvaluationOptions =
  & CreateRelicExpeditionAiEvaluationCasesOptions
  & Readonly<{
    mockBlueprint?:
      | RelicExpeditionBlueprint
      | ((
        input: Readonly<{ gameId: string; reason: RelicInitialStateReason; seed: string }>,
      ) => RelicExpeditionBlueprint);
  }>;

export type RunRelicExpeditionOllamaLiveEvaluationOptions = Readonly<{
  env: RallarAiLiveEvaluationEnvironment;
  gate?: string;
  cases?: readonly RallarAiEvaluationCase[];
  provider?: RallarAiJsonProvider;
  fetch?: RallarAiOllamaFetch;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  allowedBaseUrls?: readonly string[];
}>;

export function createRelicExpeditionAiEvaluationCases(
  options: CreateRelicExpeditionAiEvaluationCasesOptions,
): readonly RallarAiEvaluationCase[] {
  return [
    {
      caseId: 'expedition-blueprint',
      request: createRelicExpeditionAiRequest({
        gameId: options.gameId,
        reason: options.reason,
        seed: options.seed,
        timeoutMs: options.timeoutMs ?? DEFAULT_RELIC_AI_EXPEDITION_TIMEOUT_MS,
      }),
      validateResult: (result) => validateExpeditionEvaluationBlueprint(result.value),
    },
  ];
}

export async function runRelicExpeditionDeterministicAiEvaluation(
  options: RunRelicExpeditionDeterministicAiEvaluationOptions,
): Promise<RallarAiEvaluationSuiteResult> {
  return await runRallarAiEvaluationSuite({
    suiteId: 'relic-expedition-ollama-ci',
    provider: createProvider({
      mockBlueprint: options.mockBlueprint,
    }, 'mock'),
    cases: createRelicExpeditionAiEvaluationCases(options),
  });
}

export async function runRelicExpeditionOllamaLiveEvaluationIfEnabled(
  options: RunRelicExpeditionOllamaLiveEvaluationOptions,
): Promise<RallarAiLiveEvaluationRunResult> {
  const gate = options.gate ?? RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE;
  if (!isRallarAiLiveEvaluationEnabled(options.env, gate)) {
    return {
      status: 'skipped',
      gate,
      reason: `Relic Ollama live evaluation requires ${gate}=1.`,
    };
  }

  const env = readRelicAiExpeditionEnv({
    get: (name) => options.env[name],
  });
  const baseUrl = options.ollamaBaseUrl ?? env.ollamaBaseUrl;
  const provider = options.provider ?? createRallarAiOllamaProvider({
    providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
    model: options.ollamaModel ?? env.ollamaModel,
    baseUrl,
    allowedBaseUrls: options.allowedBaseUrls ?? [
      baseUrl,
      DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL,
      'http://localhost:11434',
      'http://[::1]:11434',
    ],
    fetch: options.fetch,
    systemPrompt: [
      'You generate strict JSON for a turn-based multiplayer castle game.',
      'The application will reject unsafe, disconnected, or unbalanced data.',
    ].join(' '),
  });

  return await runRallarAiEvaluationSuiteIfEnabled({
    suiteId: 'relic-expedition-ollama-live',
    provider,
    cases: options.cases ?? createRelicExpeditionAiEvaluationCases({
      gameId: 'relic-expedition-live-evaluation',
      reason: 'ensure',
      seed: 'relic-expedition-live-evaluation',
      timeoutMs: env.timeoutMs,
    }),
    env: options.env,
    gate,
    providerLabel: 'Relic Ollama',
  });
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
    providerId: RELIC_EXPEDITION_OLLAMA_PROVIDER_ID,
    model: options.ollamaModel ?? DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_MODEL,
    baseUrl: options.ollamaBaseUrl ?? DEFAULT_RELIC_AI_EXPEDITION_OLLAMA_BASE_URL,
    fetch: options.fetch,
    systemPrompt: [
      'You generate strict JSON for a turn-based multiplayer castle game.',
      'The application will reject unsafe, disconnected, or unbalanced data.',
    ].join(' '),
  });
}

function validateExpeditionEvaluationBlueprint(
  blueprint: unknown,
): readonly string[] {
  const validation = validateRelicExpeditionBlueprint(blueprint);
  const visualFit = validateRelicExpeditionVisualFit(blueprint);
  return [
    ...validation.errors.map((error) => `blueprint: ${error}`),
    ...visualFit.errors.map((error) => `visual-fit: ${error}`),
  ];
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
