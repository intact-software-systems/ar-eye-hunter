// @vitest-environment happy-dom
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import { expect, it, vi } from 'vitest';

import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import { computeRelicTerminalPresentationKey } from '../../src/game/scene/neon/compute-relic-terminal-presentation-key.ts';
import { createFacilityMaterials } from '../../src/game/scene/neon/relic-materials.ts';
import type { RelicPickupPrompt } from '../../src/game/scene/neon/relic-relics.ts';
import { RelicSceneInput } from '../../src/game/scene/neon/relic-scene-input.ts';
import { RelicSceneLifecycle, renderRelicFrame } from '../../src/game/scene/neon/relic-scene-lifecycle.ts';
import { RelicSceneRuntime } from '../../src/game/scene/neon/relic-scene-runtime.ts';

class FrameDriver implements CappedFrameLoop.Driver {
    nowMs = 0;
    scheduled: (() => void) | undefined;
    start(frame: () => void): void {
        this.scheduled = frame;
    }
    stop(): void {
        this.scheduled = undefined;
    }
    resetTiming(): void {}
    advance(): void {
        this.nowMs += 40;
        this.scheduled?.();
    }
}

interface SceneFixture {
    readonly runtime: RelicSceneRuntime;
    readonly input: RelicSceneRuntime.Input;
    readonly lifecycle: RelicSceneLifecycle;
    readonly driver: FrameDriver;
    readonly frames: { value: number; };
}

it('keeps a terminal frame idle across HUD-only focus changes and redraws camera controls', () => {
    const fixture = createFixture(() => undefined);
    try {
        fixture.lifecycle.start();
        fixture.driver.advance();
        expect(fixture.frames.value).toBe(2);
        fixture.lifecycle.update({ ...fixture.input, focusRoomId: 'hud-event-room' });
        expect(fixture.frames.value, 'HUD-only focus must not invalidate a terminal image').toBe(2);
        fixture.lifecycle.changeCameraMode('overview');
        expect(fixture.frames.value).toBe(3);
        expect(fixture.driver.scheduled).toBeUndefined();
    }
    finally {
        fixture.lifecycle.dispose();
    }
});

it('clears a visible nearby pickup when the native attempt becomes cancelled', () => {
    const prompts: (RelicPickupPrompt | undefined)[] = [];
    const fixture = createFixture((prompt) => prompts.push(prompt));
    try {
        fixture.runtime.terminal = false;
        fixture.runtime.terminalKey = undefined;
        fixture.runtime.snapshot.value = {
            ...fixture.input.snapshot,
            tournament: { ...fixture.input.snapshot.tournament!, status: 'playing' },
            phase: 'planning'
        };
        fixture.lifecycle.start();
        const nearby = { relicId: 'badge', name: 'Visitor Badge', value: 1 };
        fixture.runtime.nearbyRelic.value = nearby;
        fixture.input.onPickupPromptChange(nearby);
        fixture.lifecycle.update({
            ...fixture.input,
            snapshot: { ...fixture.input.snapshot, tournament: { ...fixture.input.snapshot.tournament!, status: 'cancelled' }, phase: 'planning' }
        });
        expect(fixture.runtime.nearbyRelic.value).toBeUndefined();
        expect(prompts.at(-1)).toBeUndefined();
        expect(fixture.runtime.inputEnabled.value).toBe(false);
    }
    finally {
        fixture.lifecycle.dispose();
    }
});

it('removes partial input registrations and disposes graphics when listener registration fails', () => {
    const fixture = createFixture(() => undefined);
    const original = window.addEventListener.bind(window);
    const registration = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'keyup') {
            throw new Error('listener failure');
        }
        original(type, listener, options);
    });
    try {
        expect(() => fixture.lifecycle.start()).toThrow('listener failure');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
        expect(fixture.runtime.pressedKeys.size).toBe(0);
        expect(fixture.driver.scheduled).toBeUndefined();
        expect(fixture.runtime.scene.isDisposed).toBe(true);
    }
    finally {
        registration.mockRestore();
        fixture.lifecycle.dispose();
    }
});

it('observes every pending draw and accepts the complete visible image without disabled shaders', () => {
    const fixture = createFixture(() => undefined);
    const runtime = fixture.runtime;
    runtime.glow.isEnabled = false;
    const visible = MeshBuilder.CreateBox('visible', {}, runtime.scene);
    visible.alwaysSelectAsActiveMesh = true;
    const disabled = MeshBuilder.CreateBox('disabled', {}, runtime.scene);
    disabled.setEnabled(false);
    let visibleMaterialReady = true;
    vi.spyOn(visible, 'isReady').mockImplementation((completeCheck) => !completeCheck || visibleMaterialReady);
    vi.spyOn(disabled, 'isReady').mockImplementation((completeCheck) => !completeCheck);
    try {
        expect(renderRelicFrame(runtime)).toBe('pending');
        expect(renderRelicFrame(runtime)).toBe('ready');
        expect(runtime.scene.getActiveMeshes().data).toContain(visible);
        expect(runtime.canvas.dataset.sceneRenderCount).toBe('2');
        const readyStamp = runtime.canvas.dataset.sceneReadyMs;
        visibleMaterialReady = false;
        expect(renderRelicFrame(runtime)).toBe('pending');
        expect(runtime.canvas.dataset.sceneRenderCount).toBe('3');
        expect(runtime.canvas.dataset.sceneReady).toBe('false');
        expect(runtime.canvas.dataset.scenePendingMeshes).toBe('1');
        expect(runtime.canvas.dataset.sceneReadyMs).toBe(readyStamp);
        visibleMaterialReady = true;
        expect(renderRelicFrame(runtime)).toBe('ready');
        expect(runtime.canvas.dataset.sceneRenderCount).toBe('4');
        expect(runtime.canvas.dataset.sceneReady).toBe('true');
        expect(runtime.scene.isReady()).toBe(false);
    }
    finally {
        fixture.lifecycle.dispose();
    }
});

function createFixture(onPickupPromptChange: RelicSceneRuntime.Input['onPickupPromptChange']): SceneFixture {
    const input: RelicSceneRuntime.Input = {
        canvas: document.createElement('canvas'),
        snapshot: createFinishedSnapshot(),
        localPlayerId: undefined,
        selectedRoomId: undefined,
        primedAction: undefined,
        focusRoomId: undefined,
        inputEnabled: true,
        rtcReady: false,
        reviewDirector: false,
        onSelectRoom: () => undefined,
        onPrimeAction: () => undefined,
        onPickupRelic: () => undefined,
        onReviewPlaybackComplete: () => undefined,
        onPromptChange: () => undefined,
        onPickupPromptChange,
        onCameraModeChange: () => undefined
    };
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new UniversalCamera('camera', Vector3.Zero(), scene);
    const runtime = new RelicSceneRuntime(input, {
        canvas: input.canvas,
        engine,
        scene,
        camera,
        glow: new GlowLayer('glow', scene),
        materials: createFacilityMaterials(scene),
        firstPersonRig: { root: new TransformNode('visor', scene) },
        initialCameraMode: 'overview',
        reducedMotion: false
    });
    runtime.terminalKey = computeRelicTerminalPresentationKey(input.snapshot);
    runtime.terminal = true;
    const driver = new FrameDriver();
    const frames = { value: 0 };
    const loop = new CappedFrameLoop({
        driver,
        nowMs: () => driver.nowMs,
        renderFrame: () => {
            frames.value += 1;
            return 'ready';
        }
    }, { frameIntervalMs: 40 });
    loop.start();
    const lifecycle = new RelicSceneLifecycle(runtime, loop, new RelicSceneInput(runtime));
    return { runtime, input, lifecycle, driver, frames };
}

function createFinishedSnapshot(): RelicSceneRuntime.Input['snapshot'] {
    return {
        tournament: {
            binding: {
                tournamentRef: { applicationId: 'relic', workspaceId: 'test', tournamentId: 'cup' },
                slot: 'semifinal-1',
                attemptId: 'attempt',
                gameId: 'game',
                rulesId: 'relic-native-10-rounds-v1',
                roomRef: { applicationId: 'relic', workspaceId: 'test', groupId: 'room' },
                principalIds: ['alice', 'bob']
            },
            status: 'finished'
        },
        protocolVersion: 1,
        gameId: 'game',
        roomId: 'room',
        phase: 'finished',
        round: 1,
        maxRounds: 10,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        roundTimeLimitMs: 60000,
        map: [],
        relics: [],
        players: [],
        events: [],
        roomInvestigations: [],
        submittedPlayerIds: [],
        winnerIds: []
    };
}
