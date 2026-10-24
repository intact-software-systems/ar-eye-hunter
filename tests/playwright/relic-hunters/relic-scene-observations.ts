import type { Page } from '@playwright/test';

interface ScenePixelMetrics {
    readonly ready: boolean;
    readonly cssWidth: number;
    readonly cssHeight: number;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    readonly devicePixelRatio: number;
    readonly highDpi: boolean;
    readonly hasRenderedFrame: boolean;
    readonly averageLuma: number;
}

export interface SceneCanvasMetrics extends ScenePixelMetrics {
    readonly cameraMode: string | undefined;
    readonly lightingPreset: string | undefined;
    readonly assetPipeline: string | undefined;
    readonly meshCount: number;
    readonly activeMeshCount: number;
    readonly materialCount: number;
    readonly particleSystemCount: number;
    readonly activeParticleSystemCount: number;
    readonly activeRoomLightCount: number;
    readonly staticBatchCount: number;
    readonly batchedMeshCount: number;
    readonly activeEffectCount: number;
    readonly effectMeshCount: number;
    readonly drawCalls: number | undefined;
    readonly fps: number | undefined;
    readonly readyMs: number;
}

export async function readSceneVisibility(page: Page): Promise<boolean> {
    return (await readScenePixels(page)).ready;
}

export async function readSceneCanvasMetrics(page: Page): Promise<SceneCanvasMetrics> {
    const pixels = await readScenePixels(page);
    const metadata = await readSceneMetadata(page);
    return { ...pixels, ...metadata };
}

async function readScenePixels(page: Page): Promise<ScenePixelMetrics> {
    return await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.relic-scene');
        const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
        const box = canvas?.getBoundingClientRect();
        const width = gl?.drawingBufferWidth ?? 0;
        const height = gl?.drawingBufferHeight ?? 0;
        const samples = [[0.5, 0.5], [0.3, 0.38], [0.7, 0.38], [0.4, 0.62], [0.6, 0.62], [0.5, 0.24], [0.5, 0.76]];
        let visibleSamples = 0;
        let lumaTotal = 0;
        if (gl && width > 0 && height > 0) {
            const pixel = new Uint8Array(4);
            for (const [x, y] of samples) {
                gl.readPixels(
                    Math.floor((width - 1) * x),
                    Math.floor((height - 1) * y),
                    1,
                    1,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    pixel
                );
                const luma = pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722;
                lumaTotal += luma;
                if (pixel[3] > 0 && luma > 6) {
                    visibleSamples += 1;
                }
            }
        }
        const expectedScale = Math.min(window.devicePixelRatio || 1, 2);
        const hasDrawableCanvas = Boolean(gl && box && box.width > 0 && box.height > 0 && width > 0 && height > 0);
        const sceneReady = canvas?.dataset.sceneReady === 'true';
        return {
            ready: hasDrawableCanvas && (sceneReady || visibleSamples > 0),
            cssWidth: box?.width ?? 0,
            cssHeight: box?.height ?? 0,
            drawingBufferWidth: width,
            drawingBufferHeight: height,
            devicePixelRatio: window.devicePixelRatio,
            highDpi: Boolean(
                hasDrawableCanvas && box && width >= box.width * expectedScale - 2 &&
                    height >= box.height * expectedScale - 2
            ),
            hasRenderedFrame: hasDrawableCanvas && (sceneReady || visibleSamples >= 2),
            averageLuma: lumaTotal / samples.length
        };
    });
}

async function readSceneMetadata(page: Page): Promise<Omit<SceneCanvasMetrics, keyof ScenePixelMetrics>> {
    return await page.evaluate(() => {
        const dataset = document.querySelector<HTMLCanvasElement>('canvas.relic-scene')?.dataset;
        const numberDataset = (name: string): number => Number(dataset?.[name]) || 0;
        const optionalNumberDataset = (name: string): number | undefined => {
            const value = Number(dataset?.[name]);
            return Number.isFinite(value) ? value : undefined;
        };
        return {
            cameraMode: dataset?.cameraMode,
            lightingPreset: dataset?.lightingPreset,
            assetPipeline: dataset?.assetPipeline,
            meshCount: numberDataset('sceneMeshCount'),
            activeMeshCount: numberDataset('sceneActiveMeshCount'),
            materialCount: numberDataset('sceneMaterialCount'),
            particleSystemCount: numberDataset('sceneParticleSystemCount'),
            activeParticleSystemCount: numberDataset('sceneActiveParticleSystemCount'),
            activeRoomLightCount: numberDataset('sceneActiveRoomLightCount'),
            staticBatchCount: numberDataset('sceneStaticBatchCount'),
            batchedMeshCount: numberDataset('sceneBatchedMeshCount'),
            activeEffectCount: numberDataset('sceneActiveEffectCount'),
            effectMeshCount: numberDataset('sceneEffectMeshCount'),
            drawCalls: optionalNumberDataset('sceneDrawCalls'),
            fps: optionalNumberDataset('sceneFps'),
            readyMs: numberDataset('sceneReadyMs')
        };
    });
}
