import {
    isRallarAiLiveEvaluationEnabled,
    runRallarAiEvaluationSuite,
    runRallarAiEvaluationSuiteIfEnabled,
    type RallarAiEvaluationCase,
    type RallarAiEvaluationSuiteResult,
    type RallarAiJsonProvider,
    type RallarAiLiveEvaluationEnvironment,
    type RallarAiLiveEvaluationRunResult
} from '@shared/rallar-ai/mod.ts';

import {
    createAiDirectorMockProvider,
    createAiDirectorRequest,
    validateAiDirectorProposalValue
} from '../aiDirector.ts';
import { createInitialArenaState, toArenaSnapshot } from '../simulation.ts';
import { DEFAULT_ARENA_WEBLLM_MODEL_ID } from './arena-browser-ai-config.ts';
import {
    ARENA_WEBLLM_LIVE_EVALUATION_GATE,
    createArenaWebLlmProvider,
    type WebLlmModule
} from './arena-webllm-provider.ts';

export interface ArenaWebLlmEvaluationOptions {
    readonly nowEpochMs?: number;
    readonly roomId?: string;
    readonly seed?: number;
}

export interface ArenaWebLlmEvaluationInput {
    readonly nowEpochMs: number;
    readonly roomId: string;
    readonly seed: number;
}

export interface RunArenaWebLlmLiveEvaluationOptions extends ArenaWebLlmEvaluationOptions {
    readonly env: RallarAiLiveEvaluationEnvironment;
    readonly gate?: string;
    readonly modelId?: string;
    readonly createProvider?: () => RallarAiJsonProvider;
    readonly loadWebLlm?: () => Promise<WebLlmModule>;
    readonly hasWebGpu?: () => boolean;
    readonly onProgress?: (progress: object) => void;
}

export function createArenaWebLlmEvaluationCases(
    input: ArenaWebLlmEvaluationInput
): readonly RallarAiEvaluationCase[] {
    const state = createInitialArenaState(input.seed, input.nowEpochMs);
    const snapshot = toArenaSnapshot(
        state,
        input.roomId,
        input.nowEpochMs
    );

    return [
        {
            caseId: 'ai-director-chaos-event',
            request: createAiDirectorRequest(state, input.roomId),
            validateResult: (result) => {
                const validation = validateAiDirectorProposalValue(
                    result.value,
                    snapshot
                );
                return validation.ok ? [] : [validation.reason];
            }
        }
    ];
}

export async function runArenaWebLlmDeterministicEvaluation(
    options: ArenaWebLlmEvaluationOptions = {}
): Promise<RallarAiEvaluationSuiteResult> {
    return await runRallarAiEvaluationSuite({
        suiteId: 'ar-eye-hunter-webllm-ci',
        provider: createAiDirectorMockProvider(),
        cases: createArenaWebLlmEvaluationCases(
            resolveArenaWebLlmEvaluationInput(options)
        )
    });
}

export async function runArenaWebLlmLiveEvaluationIfEnabled(
    options: RunArenaWebLlmLiveEvaluationOptions
): Promise<RallarAiLiveEvaluationRunResult> {
    const gate = options.gate ?? ARENA_WEBLLM_LIVE_EVALUATION_GATE;
    if (!isRallarAiLiveEvaluationEnabled(options.env, gate)) {
        return {
            status: 'skipped',
            gate,
            reason: `AR Eye Hunter WebLLM live evaluation requires ${gate}=1.`
        };
    }

    const provider = options.createProvider?.() ?? createArenaWebLlmProvider({
        modelId: options.modelId ?? DEFAULT_ARENA_WEBLLM_MODEL_ID,
        loadWebLlm: options.loadWebLlm,
        hasWebGpu: options.hasWebGpu,
        onProgress: options.onProgress
    });

    return await runRallarAiEvaluationSuiteIfEnabled({
        suiteId: 'ar-eye-hunter-webllm-live',
        provider,
        cases: createArenaWebLlmEvaluationCases(
            resolveArenaWebLlmEvaluationInput(options)
        ),
        env: options.env,
        gate,
        providerLabel: 'AR Eye Hunter WebLLM'
    });
}

function resolveArenaWebLlmEvaluationInput(
    options: ArenaWebLlmEvaluationOptions
): ArenaWebLlmEvaluationInput {
    return {
        nowEpochMs: options.nowEpochMs ?? 18_000,
        roomId: options.roomId ?? 'arena-webllm-evaluation',
        seed: options.seed ?? 7_331
    };
}
