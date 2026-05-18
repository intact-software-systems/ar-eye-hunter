import { useEffect, useRef } from 'react';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { Scene } from '@babylonjs/core/scene.js';
import { startCappedRenderLoop } from './scene/renderLoop.ts';

const OPENING_FRAME_INTERVAL_MS = 1000 / 24;

export function OpeningRelicScene() {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const engine = new Engine(canvas, true, {
            antialias: true,
            preserveDrawingBuffer: false,
            stencil: false,
        });
        engine.setHardwareScalingLevel(1.5);

        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.035, 0.045, 0.065, 1);
        scene.ambientColor = new Color3(0.35, 0.31, 0.24);
        scene.fogMode = Scene.FOGMODE_EXP2;
        scene.fogColor = new Color3(0.04, 0.055, 0.07);
        scene.fogDensity = 0.018;

        const camera = new UniversalCamera('opening-camera', new Vector3(0, 2.2, -9.4), scene);
        camera.setTarget(new Vector3(0, 1.7, 1.2));
        camera.fov = 0.92;
        camera.minZ = 0.05;
        camera.maxZ = 60;

        const moon = new HemisphericLight('opening-moon', new Vector3(-0.25, 1, 0.15), scene);
        moon.diffuse = new Color3(0.58, 0.68, 0.78);
        moon.groundColor = new Color3(0.16, 0.12, 0.08);
        moon.intensity = 0.92;

        const gateLight = new PointLight('opening-gate-light', new Vector3(0, 2.1, 1.5), scene);
        gateLight.diffuse = new Color3(1.0, 0.72, 0.28);
        gateLight.intensity = 1.8;
        gateLight.range = 9;

        const relicLight = new PointLight('opening-relic-light', new Vector3(0, 1.2, -1.7), scene);
        relicLight.diffuse = new Color3(0.45, 0.9, 0.82);
        relicLight.intensity = 1.15;
        relicLight.range = 5;

        buildOpeningScene(scene);

        const resize = () => engine.resize();
        window.addEventListener('resize', resize);

        startCappedRenderLoop(engine, OPENING_FRAME_INTERVAL_MS, () => {
            const t = performance.now() / 1000;
            camera.position.x = Math.sin(t * 0.12) * 0.55;
            camera.position.y = 2.15 + Math.sin(t * 0.17) * 0.08;
            camera.position.z = -9.35 + Math.sin(t * 0.1) * 0.35;
            camera.setTarget(new Vector3(Math.sin(t * 0.09) * 0.45, 1.7, 1.2));
            gateLight.intensity = 1.65 + Math.sin(t * 2.4) * 0.14;
            relicLight.intensity = 1.1 + Math.sin(t * 1.7) * 0.18;
            scene.render();
            if (canvas.dataset.sceneReady !== 'true') {
                canvas.dataset.sceneReady = 'true';
            }
        });

        return () => {
            window.removeEventListener('resize', resize);
            delete canvas.dataset.sceneReady;
            scene.dispose();
            engine.dispose();
        };
    }, []);

    return <canvas ref={canvasRef} className="relic-scene" aria-label="Relic Hunters opening scene" tabIndex={-1}/>;
}

function buildOpeningScene(scene: Scene): void {
    const stone = material(scene, 'opening-stone', new Color3(0.34, 0.36, 0.32), new Color3(0.03, 0.04, 0.035));
    const moss = material(scene, 'opening-moss', new Color3(0.16, 0.34, 0.24), new Color3(0.01, 0.04, 0.025));
    const wood = material(scene, 'opening-wood', new Color3(0.43, 0.19, 0.12), new Color3(0.05, 0.02, 0.01));
    const gold = material(scene, 'opening-gold', new Color3(0.88, 0.63, 0.18), new Color3(0.26, 0.16, 0.04));
    const glow = material(scene, 'opening-glow', new Color3(0.2, 0.85, 0.76), new Color3(0.1, 0.65, 0.58));

    const ground = MeshBuilder.CreateGround('opening-ground', { width: 28, height: 24 }, scene);
    ground.position.z = 1.5;
    ground.material = moss;

    for (let i = 0; i < 7; i += 1) {
        const step = MeshBuilder.CreateBox(`opening-step-${i}`, {
            width: 6.6 - i * 0.24,
            height: 0.16,
            depth: 0.82,
        }, scene);
        step.position.set(0, 0.08 + i * 0.055, -4.2 + i * 0.86);
        step.material = i % 2 === 0 ? stone : moss;
    }

    for (const side of [-1, 1]) {
        const pillar = MeshBuilder.CreateBox(`opening-gate-pillar-${side}`, {
            width: 0.58,
            height: 4.6,
            depth: 0.58,
        }, scene);
        pillar.position.set(side * 2.7, 2.3, 1.4);
        pillar.material = wood;

        const cap = MeshBuilder.CreateBox(`opening-gate-cap-${side}`, {
            width: 0.92,
            height: 0.36,
            depth: 0.82,
        }, scene);
        cap.position.set(side * 2.7, 4.72, 1.4);
        cap.material = gold;
    }

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

    for (let i = 0; i < 18; i += 1) {
        const rock = MeshBuilder.CreateBox(`opening-rubble-${i}`, {
            width: 0.18 + (i % 3) * 0.08,
            height: 0.12 + (i % 4) * 0.05,
            depth: 0.2 + (i % 5) * 0.04,
        }, scene);
        const side = i % 2 === 0 ? -1 : 1;
        rock.position.set(side * (3.4 + (i % 5) * 0.62), rock.scaling.y * 0.08, -3.8 + (i % 7) * 1.15);
        rock.rotation.y = i * 0.47;
        rock.material = i % 3 === 0 ? moss : stone;
    }
}

function material(scene: Scene, name: string, diffuse: Color3, emissive: Color3): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = diffuse;
    mat.emissiveColor = emissive;
    mat.specularColor = new Color3(0.08, 0.07, 0.05);
    return mat;
}
