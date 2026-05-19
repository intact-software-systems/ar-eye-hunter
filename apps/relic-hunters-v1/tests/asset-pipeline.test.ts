import { describe, expect, it } from 'vitest';
import {
    CURRENT_RELIC_ASSET_PIPELINE,
    recommendRelicAssetPipeline,
} from '../src/game/scene/assetPipeline.ts';

describe('asset pipeline decision', () => {
    it('keeps the current game procedural without an approved imported asset set', () => {
        expect(recommendRelicAssetPipeline({
            appChunkKb: 986,
            babylonChunkKb: 3_075,
            activeMeshCount: 260,
            drawCalls: 340,
            frameTimeMs: 18,
            hasApprovedAssetSet: false,
        })).toEqual(CURRENT_RELIC_ASSET_PIPELINE);
    });

    it('keeps the current game procedural when measured budgets are already pressured', () => {
        expect(recommendRelicAssetPipeline({
            appChunkKb: 1_220,
            babylonChunkKb: 3_075,
            activeMeshCount: 260,
            drawCalls: 340,
            frameTimeMs: 18,
            hasApprovedAssetSet: true,
        }).strategy).toBe('procedural');

        expect(recommendRelicAssetPipeline({
            appChunkKb: 986,
            babylonChunkKb: 3_075,
            activeMeshCount: 260,
            drawCalls: 1_250,
            frameTimeMs: 18,
            hasApprovedAssetSet: true,
        }).strategy).toBe('procedural');
    });

    it('allows a hybrid glTF path only with measured headroom and an approved asset set', () => {
        expect(recommendRelicAssetPipeline({
            appChunkKb: 820,
            babylonChunkKb: 2_700,
            activeMeshCount: 240,
            drawCalls: 300,
            frameTimeMs: 16,
            hasApprovedAssetSet: true,
        })).toMatchObject({
            strategy: 'hybrid-gltf',
            importedAssetsAllowed: true,
        });
    });
});
