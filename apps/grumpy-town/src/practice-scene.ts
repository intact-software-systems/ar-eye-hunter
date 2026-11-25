import { Camera } from '@babylonjs/core/Cameras/camera';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';

import { createMarketEnvironment } from './create-market-environment.ts';
import { CutoutActor } from './cutout-actor.ts';
import { CutoutArt } from './cutout-art.ts';
import type { PracticeState } from './practice-rules.ts';
import { TownCreaturePresentation } from './town/creatures/town-creature-presentation.ts';
import { TownPersonalityPresentation } from './town/personalities/town-personality-presentation.ts';
import { TownRaidPresentation } from './town/raid-presentation.ts';
import { TownSpectaclePresentation } from './town/spectacles/town-spectacle-presentation.ts';
import { TownObjectPresentation } from './town/town-object-presentation.ts';
import { TownPresentation } from './town/town-presentation.ts';
import { TownStreetPresentation } from './town/town-street-presentation.ts';

export namespace PracticeScene {
    export interface Frame {
        readonly state: PracticeState;
        readonly zoom: number;
        readonly seconds: number;
        readonly reducedMotion: boolean;
    }
}

export class PracticeScene {
    readonly engine: Engine;
    readonly scene: Scene;
    private readonly camera: FreeCamera;
    private readonly player: CutoutActor;
    private readonly town: TownPresentation;
    private readonly creatures: TownCreaturePresentation;
    private readonly objects: TownObjectPresentation;
    private readonly personalities: TownPersonalityPresentation;
    private readonly spectacles: TownSpectaclePresentation;
    private readonly street: TownStreetPresentation;
    private readonly raid: TownRaidPresentation;
    private readonly cloud: Mesh;
    private readonly shadow: Mesh;
    private readonly marker: Mesh;
    private readonly canvas: HTMLCanvasElement;
    private cameraX = 0;
    private cameraZ = -2;
    private zoom = 13;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: true }, false);
        this.engine.setHardwareScalingLevel(1 / Math.min(devicePixelRatio, 1.5));
        this.scene = new Scene(this.engine);
        this.scene.detachControl();
        this.scene.clearColor = Color4.FromHexString('#b1a18aff');
        this.camera = new FreeCamera('market-camera', new Vector3(0, 12, -12), this.scene);
        this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
        this.camera.minZ = 0.1;
        const art = new CutoutArt(this.scene);
        const shops = createMarketEnvironment(this.scene, art);
        this.creatures = new TownCreaturePresentation(this.scene, art);
        this.objects = new TownObjectPresentation(this.scene, art);
        this.personalities = new TownPersonalityPresentation(this.scene, art);
        this.spectacles = new TownSpectaclePresentation(this.scene, art);
        this.town = new TownPresentation({ scene: this.scene, art, shops });
        this.street = new TownStreetPresentation(this.scene, art);
        this.raid = new TownRaidPresentation(this.scene, art);
        this.player = new CutoutActor({ scene: this.scene, art, color: '#347d79', guard: false });
        this.shadow = createShadow(this.scene, art);
        this.marker = createMarker(this.scene, art);
        this.cloud = CreatePlane('fart-decoy', { size: 2.3 }, this.scene);
        this.cloud.rotation.x = 0.55;
        this.cloud.material = art.texture(
            'puff',
            '<path fill="#a2b856" d="M39 148Q-5 106 43 85Q22 29 88 49Q109-4 144 39Q206 7 207 70Q265 65 233 127Q272 179 211 192Q196 251 143 218Q88 260 64 209Q2 212 39 148z"/><path fill="none" stroke="#728c49" stroke-width="6" d="M68 134q-15-38 20-45m43 78q39 12 44-21m-51-66q17-22 38-2"/>'
        );
        this.cloud.material.transparencyMode = 2;
        this.cloud.setEnabled(false);
    }

    render(frame: PracticeScene.Frame): void {
        const { state, reducedMotion } = frame;
        this.updateCamera(frame);
        const time = reducedMotion ? 0 : state.elapsed;
        this.player.render({
            x: state.x,
            z: state.z,
            time: state.frozenUntil > state.elapsed ? 0 : time,
            moving: Math.hypot(state.vx, state.vz) > 0.2,
            slipping: state.slipping,
            facing: state.facingX,
            angry: false,
            working: false,
            dizzy: state.dizzyUntil > state.elapsed,
            mini: false,
            stain: state.stain,
            puking: state.sickAt >= 0 && state.elapsed >= state.sickAt && state.elapsed < state.sickAt + 1
        });
        this.town.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.street.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.raid.render(frame);
        this.creatures.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.objects.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.personalities.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.spectacles.render({ town: state.town, now: state.elapsed, reducedMotion });
        this.shadow.position.set(state.x, 0.04, state.z);
        this.marker.position.set(state.x, 0.045, state.z);
        const cloud = state.clouds[0];
        this.cloud.setEnabled(Boolean(cloud));
        if (cloud) {
            this.cloud.position.set(cloud.x, 0.65 + cloud.age * 0.25, cloud.z);
            this.cloud.scaling.setAll(0.5 + cloud.age * 0.4);
            this.cloud.visibility = Math.min(0.45, (2.4 - cloud.age) * 0.7);
        }
        this.scene.render();
    }

    updatePlayerColor(color: string): void {
        this.player.updateColor(color);
    }

    resize(): void {
        this.engine.resize();
    }
    stop(): void {
        this.engine.stopRenderLoop();
        this.scene.dispose();
        this.engine.dispose();
    }

    private updateCamera(frame: PracticeScene.Frame): void {
        const { state, zoom, seconds, reducedMotion } = frame;
        const blend = reducedMotion ? 1 : 1 - Math.exp(-8 * seconds);
        this.cameraX += (state.x - this.cameraX) * blend;
        this.cameraZ += (state.z - this.cameraZ) * blend;
        this.zoom += (zoom - this.zoom) * blend;
        const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
        const width = this.zoom * Math.max(1, aspect);
        const height = width / aspect;
        this.camera.orthoLeft = -width / 2;
        this.camera.orthoRight = width / 2;
        this.camera.orthoTop = height / 2;
        this.camera.orthoBottom = -height / 2;
        this.camera.position.set(this.cameraX, 14, this.cameraZ - 12);
        this.camera.setTarget(new Vector3(this.cameraX, 0, this.cameraZ + 2.5));
    }
}

function createShadow(scene: Scene, art: CutoutArt): Mesh {
    const shadow = CreateGround('runner-shadow', { width: 1.6, height: 0.8 }, scene);
    const material = art.texture(
        'shadow',
        '<ellipse cx="128" cy="128" rx="120" ry="105" fill="#4e4c3d" opacity=".3"/>'
    );
    material.transparencyMode = 2;
    shadow.material = material;
    return shadow;
}

function createMarker(scene: Scene, art: CutoutArt): Mesh {
    const marker = CreateGround('your-marker', { width: 1.7, height: 1.3 }, scene);
    marker.material = art.texture(
        'marker',
        '<circle cx="128" cy="128" r="113" fill="none" stroke="#e6e3bc" stroke-width="8" stroke-dasharray="36 12"/>'
    );
    return marker;
}
