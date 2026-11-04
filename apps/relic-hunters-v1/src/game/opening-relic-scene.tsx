import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
import { useEffect, useRef } from 'react';

import { type CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import { CURRENT_RELIC_ASSET_PIPELINE } from './scene/assetPipeline.ts';
import { lightingPresetById, type RelicLightingPreset } from './scene/lightingPresets.ts';
import { startCappedRenderLoop } from './scene/start-capped-render-loop.ts';

interface MaterialInput {
    readonly scene: Scene;
    readonly name: string;
    readonly diffuse: Color3;
    readonly emissive: Color3;
}

interface OpeningLights {
    readonly gateLight: PointLight;
    readonly relicLight: PointLight;
}

interface OpeningSceneRuntime extends OpeningLights {
    readonly canvas: HTMLCanvasElement;
    readonly engine: Engine;
    readonly scene: Scene;
    readonly camera: UniversalCamera;
    readonly createdAtMs: number;
}

interface OpeningMaterials {
    readonly stone: StandardMaterial;
    readonly moss: StandardMaterial;
    readonly wood: StandardMaterial;
    readonly gold: StandardMaterial;
    readonly glow: StandardMaterial;
}

export function OpeningRelicScene() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => startOpeningScene(canvasRef.current), []);
    return <canvas ref={canvasRef} className="relic-scene" aria-label="Relic Hunters opening scene" tabIndex={-1} />;
}

function startOpeningScene(canvas: HTMLCanvasElement | null): (() => void) | undefined {
    if (!canvas) {
        return;
    }
    const runtime = createOpeningRuntime(canvas);
    const resize = () => runtime.engine.resize();
    const loop = startOpeningSceneRendering(runtime);
    window.addEventListener('resize', resize);
    return () => {
        window.removeEventListener('resize', resize);
        loop.dispose();
        delete canvas.dataset.sceneReady;
        delete canvas.dataset.sceneReadyMs;
        delete canvas.dataset.assetPipeline;
        delete canvas.dataset.lightingPreset;
        delete canvas.dataset.sceneMeshCount;
        delete canvas.dataset.sceneMaterialCount;
        delete canvas.dataset.sceneFps;
        runtime.scene.dispose();
        runtime.engine.dispose();
    };
}

function startOpeningSceneRendering(runtime: OpeningSceneRuntime): CappedFrameLoop {
    try {
        return startCappedRenderLoop({
            engine: runtime.engine,
            frameIntervalMs: 1000 / 30,
            renderFrame: () => drawOpeningFrame(runtime)
        });
    }
    catch (error) {
        runtime.scene.dispose();
        runtime.engine.dispose();
        throw error;
    }
}

function createOpeningRuntime(canvas: HTMLCanvasElement): OpeningSceneRuntime {
    const engine = new Engine(canvas, true, {
        antialias: true,
        preserveDrawingBuffer: false,
        stencil: false,
        adaptToDeviceRatio: true,
        limitDeviceRatio: 2
    });

    try {
        const createdAtMs = performance.now();
        const openingLighting = lightingPresetById('day');
        canvas.dataset.assetPipeline = CURRENT_RELIC_ASSET_PIPELINE.strategy;
        canvas.dataset.lightingPreset = openingLighting.id;

        const scene = new Scene(engine);
        scene.clearColor = toColor4(openingLighting.clearColor);
        scene.ambientColor = Color3.FromHexString(openingLighting.ambientColor);
        scene.fogMode = Scene.FOGMODE_EXP2;
        scene.fogColor = Color3.FromHexString(openingLighting.fogColor);
        scene.fogDensity = openingLighting.fogDensity;

        const camera = new UniversalCamera('opening-camera', new Vector3(0, 2.2, -9.4), scene);
        camera.setTarget(new Vector3(0, 1.7, 1.2));
        camera.fov = 0.92;
        camera.minZ = 0.05;
        camera.maxZ = 60;

        const lights = createOpeningLights(scene, openingLighting);
        buildOpeningScene(scene);
        return { canvas, engine, scene, camera, createdAtMs, ...lights };
    }
    catch (error) {
        engine.dispose();
        throw error;
    }
}

function createOpeningLights(scene: Scene, openingLighting: RelicLightingPreset): OpeningLights {
    const sun = new DirectionalLight('opening-sun', toVector3(openingLighting.sunDirection), scene);
    sun.position = toVector3(openingLighting.sunPosition);
    sun.diffuse = Color3.FromHexString(openingLighting.sunDiffuse);
    sun.specular = Color3.FromHexString(openingLighting.sunSpecular);
    sun.intensity = openingLighting.sunIntensity * 0.62;

    const moon = new HemisphericLight('opening-sky-fill', toVector3(openingLighting.hemiDirection), scene);
    moon.diffuse = Color3.FromHexString(openingLighting.hemiDiffuse);
    moon.groundColor = Color3.FromHexString(openingLighting.hemiGround);
    moon.intensity = openingLighting.hemiIntensity;

    const gateLight = new PointLight('opening-gate-light', new Vector3(0, 2.1, 1.5), scene);
    gateLight.diffuse = new Color3(1.0, 0.72, 0.28);
    gateLight.intensity = 2.1;
    gateLight.range = 9;

    const relicLight = new PointLight('opening-relic-light', new Vector3(0, 1.2, -1.7), scene);
    relicLight.diffuse = new Color3(0.45, 0.9, 0.82);
    relicLight.intensity = 1.35;
    relicLight.range = 5;

    return { gateLight, relicLight };
}

function drawOpeningFrame(runtime: OpeningSceneRuntime): 'ready' | 'pending' {
    const { canvas, camera, gateLight, relicLight, scene, engine, createdAtMs } = runtime;
    const readyBeforeRender = scene.isReady();
    const t = performance.now() / 1000;
    camera.position.x = Math.sin(t * 0.12) * 0.55;
    camera.position.y = 2.15 + Math.sin(t * 0.17) * 0.08;
    camera.position.z = -9.35 + Math.sin(t * 0.1) * 0.35;
    camera.setTarget(new Vector3(Math.sin(t * 0.09) * 0.45, 1.7, 1.2));
    gateLight.intensity = 1.65 + Math.sin(t * 2.4) * 0.14;
    relicLight.intensity = 1.1 + Math.sin(t * 1.7) * 0.18;
    scene.render();
    if (readyBeforeRender && canvas.dataset.sceneReady !== 'true') {
        canvas.dataset.sceneReady = 'true';
        canvas.dataset.sceneReadyMs = String(Math.round(performance.now() - createdAtMs));
    }
    canvas.dataset.sceneMeshCount = String(scene.meshes.length);
    canvas.dataset.sceneMaterialCount = String(scene.materials.length);
    canvas.dataset.sceneFps = String(Math.round(engine.getFps()));
    return readyBeforeRender ? 'ready' : 'pending';
}

function buildOpeningScene(scene: Scene): void {
    const stone = createOpeningMaterial({
        scene: scene,
        name: 'opening-stone',
        diffuse: new Color3(0.34, 0.36, 0.32),
        emissive: new Color3(0.03, 0.04, 0.035)
    });
    const moss = createOpeningMaterial({
        scene: scene,
        name: 'opening-moss',
        diffuse: new Color3(0.16, 0.34, 0.24),
        emissive: new Color3(0.01, 0.04, 0.025)
    });
    const wood = createOpeningMaterial({
        scene: scene,
        name: 'opening-wood',
        diffuse: new Color3(0.43, 0.19, 0.12),
        emissive: new Color3(0.05, 0.02, 0.01)
    });
    const gold = createOpeningMaterial({
        scene: scene,
        name: 'opening-gold',
        diffuse: new Color3(0.88, 0.63, 0.18),
        emissive: new Color3(0.26, 0.16, 0.04)
    });
    const glow = createOpeningMaterial({
        scene: scene,
        name: 'opening-glow',
        diffuse: new Color3(0.2, 0.85, 0.76),
        emissive: new Color3(0.1, 0.65, 0.58)
    });
    const materials = { stone, moss, wood, gold, glow };
    createOpeningEntrance(scene, materials);
    createOpeningGate(scene, materials);
    createOpeningRubble(scene, materials);
}

function createOpeningEntrance(scene: Scene, { stone, moss, wood, gold }: OpeningMaterials): void {
    const ground = MeshBuilder.CreateGround('opening-ground', { width: 28, height: 24 }, scene);
    ground.position.z = 1.5;
    ground.material = moss;

    for (let i = 0; i < 7; i += 1) {
        const step = MeshBuilder.CreateBox(`opening-step-${i}`, {
            width: 6.6 - i * 0.24,
            height: 0.16,
            depth: 0.82
        }, scene);
        step.position.set(0, 0.08 + i * 0.055, -4.2 + i * 0.86);
        step.material = i % 2 === 0 ? stone : moss;
    }

    for (const side of [-1, 1]) {
        const pillar = MeshBuilder.CreateBox(`opening-gate-pillar-${side}`, {
            width: 0.58,
            height: 4.6,
            depth: 0.58
        }, scene);
        pillar.position.set(side * 2.7, 2.3, 1.4);
        pillar.material = wood;

        const cap = MeshBuilder.CreateBox(`opening-gate-cap-${side}`, {
            width: 0.92,
            height: 0.36,
            depth: 0.82
        }, scene);
        cap.position.set(side * 2.7, 4.72, 1.4);
        cap.material = gold;
    }
}

function createOpeningGate(scene: Scene, { stone, wood, gold, glow }: OpeningMaterials): void {
    const lintel = MeshBuilder.CreateBox('opening-gate-lintel', { width: 6.4, height: 0.48, depth: 0.72 }, scene);
    lintel.position.set(0, 4.12, 1.4);
    lintel.material = wood;

    const upper = MeshBuilder.CreateBox('opening-gate-upper', { width: 5.4, height: 0.22, depth: 0.6 }, scene);
    upper.position.set(0, 4.65, 1.4);
    upper.material = gold;

    for (const side of [-1, 1]) {
        const wall = MeshBuilder.CreateBox(`opening-wall-${side}`, { width: 6, height: 2.3, depth: 0.8 }, scene);
        wall.position.set(side * 5.8, 1.15, 1.62);
        wall.rotation.y = side * 0.18;
        wall.material = stone;
    }

    const relic = MeshBuilder.CreatePolyhedron('opening-relic', { type: 1, size: 0.52 }, scene);
    relic.position.set(0, 1.02, -1.7);
    relic.rotation.y = Math.PI / 4;
    relic.material = glow;

    for (const side of [-1, 1]) {
        const lantern = MeshBuilder.CreateSphere(`opening-lantern-${side}`, { diameter: 0.34, segments: 10 }, scene);
        lantern.position.set(side * 1.75, 2.45, 0.72);
        lantern.material = gold;
    }
}

function createOpeningRubble(scene: Scene, { stone, moss }: OpeningMaterials): void {
    for (let i = 0; i < 18; i += 1) {
        const rock = MeshBuilder.CreateBox(`opening-rubble-${i}`, {
            width: 0.18 + (i % 3) * 0.08,
            height: 0.12 + (i % 4) * 0.05,
            depth: 0.2 + (i % 5) * 0.04
        }, scene);
        const side = i % 2 === 0 ? -1 : 1;
        rock.position.set(side * (3.4 + (i % 5) * 0.62), rock.scaling.y * 0.08, -3.8 + (i % 7) * 1.15);
        rock.rotation.y = i * 0.47;
        rock.material = i % 3 === 0 ? moss : stone;
    }
}

function createOpeningMaterial({ scene, name, diffuse, emissive }: MaterialInput): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = diffuse;
    mat.emissiveColor = emissive;
    mat.specularColor = new Color3(0.08, 0.07, 0.05);
    return mat;
}

function toVector3(tuple: readonly [number, number, number]): Vector3 {
    return new Vector3(tuple[0], tuple[1], tuple[2]);
}

function toColor4(hex: string): Color4 {
    const color = Color3.FromHexString(hex);
    return new Color4(color.r, color.g, color.b, 1);
}
