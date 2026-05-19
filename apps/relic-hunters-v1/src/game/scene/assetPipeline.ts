export type RelicAssetPipelineStrategy = 'procedural' | 'hybrid-gltf';

export type RelicAssetPipelineInput = Readonly<{
    appChunkKb: number;
    babylonChunkKb: number;
    meshCount?: number;
    activeMeshCount?: number;
    drawCalls?: number;
    frameTimeMs?: number;
    hasApprovedAssetSet?: boolean;
}>;

export type RelicAssetPipelineDecision = Readonly<{
    strategy: RelicAssetPipelineStrategy;
    importedAssetsAllowed: boolean;
    rationale: readonly string[];
    nextSteps: readonly string[];
}>;

export const RELIC_ASSET_PIPELINE_BUDGETS = {
    appChunkKb: 1_100,
    babylonChunkKb: 3_200,
    activeMeshCount: 900,
    drawCalls: 1_100,
    frameTimeMs: 22.5,
} as const;

export const CURRENT_RELIC_ASSET_PIPELINE: RelicAssetPipelineDecision = {
    strategy: 'procedural',
    importedAssetsAllowed: false,
    rationale: [
        'The current procedural kit is covered by deterministic tests and scene baselines.',
        'The Babylon chunk is already large enough that imported gameplay assets should not be added blindly.',
        'No approved modular glTF set exists yet for room pieces, avatars, or relics.',
    ],
    nextSteps: [
        'Keep gameplay rooms procedural while improving reusable kit pieces and instancing opportunities.',
        'Prototype imported assets only behind an explicit hybrid asset boundary after production performance work.',
        'Require naming, scale, origin, material, and fallback conventions before any glTF asset becomes gameplay-critical.',
    ],
};

export function recommendRelicAssetPipeline(input: RelicAssetPipelineInput): RelicAssetPipelineDecision {
    const overBudget = input.appChunkKb > RELIC_ASSET_PIPELINE_BUDGETS.appChunkKb ||
        input.babylonChunkKb > RELIC_ASSET_PIPELINE_BUDGETS.babylonChunkKb ||
        (input.activeMeshCount ?? 0) > RELIC_ASSET_PIPELINE_BUDGETS.activeMeshCount ||
        (input.drawCalls ?? 0) > RELIC_ASSET_PIPELINE_BUDGETS.drawCalls ||
        (input.frameTimeMs ?? 0) > RELIC_ASSET_PIPELINE_BUDGETS.frameTimeMs;

    if (overBudget || !input.hasApprovedAssetSet) {
        return CURRENT_RELIC_ASSET_PIPELINE;
    }

    return {
        strategy: 'hybrid-gltf',
        importedAssetsAllowed: true,
        rationale: [
            'Measured scene and bundle budgets have headroom.',
            'An approved modular asset set is available.',
            'The procedural fallback can remain in place while selected repeated pieces move to glTF.',
        ],
        nextSteps: [
            'Introduce a dedicated hybrid asset loader boundary.',
            'Start with non-authoritative visual pieces such as room shell variants or avatar skins.',
            'Keep procedural fallbacks and Playwright render contracts enabled for asset-load failure paths.',
        ],
    };
}
