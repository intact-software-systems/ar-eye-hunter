// @vitest-environment happy-dom
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import { expect, it } from 'vitest';

import { CappedFrameLoop } from '@shared/resilience/timing/capped-frame-loop.ts';

import { syncRelicAvatarPresentation } from '../../src/game/scene/neon/sync-relic-avatar-presentation.ts';

it('reconciles Visor entry and Overview redraw before a requested terminal image settles', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.activeCamera = new UniversalCamera('camera', new Vector3(0, 0, -5), scene);
    const body = MeshBuilder.CreateBox('body', {}, scene);
    const label = MeshBuilder.CreatePlane('label', {}, scene);
    const trail = MeshBuilder.CreateBox('trail', {}, scene);
    const root = new TransformNode('visor', scene);
    const hand = MeshBuilder.CreateBox('hand', {}, scene);
    hand.parent = root;
    trail.setEnabled(false);
    const avatars = new Map([['alice', { parts: [body, trail], label, trail }]]);
    let cameraMode: 'first-person' | 'overview' = 'first-person';
    let nowMs = 0;
    let scheduled: (() => void) | undefined;
    let frames = 0;
    const loop = new CappedFrameLoop({
        driver: {
            start: (frame) => {
                scheduled = frame;
            },
            stop: () => {
                scheduled = undefined;
            },
            resetTiming: () => undefined
        },
        nowMs: () => nowMs,
        renderFrame: () => {
            syncRelicAvatarPresentation({ avatars, firstPersonRig: { root }, localPlayerId: 'alice', cameraMode });
            scene.render();
            frames += 1;
            return 'ready';
        }
    }, { frameIntervalMs: 40 });
    try {
        loop.start();
        loop.pauseWhenReady();
        nowMs = 40;
        scheduled?.();
        expect(body.isEnabled()).toBe(false);
        expect(label.isEnabled()).toBe(false);
        expect(hand.isEnabled()).toBe(true);
        expect(scheduled).toBeUndefined();
        cameraMode = 'overview';
        loop.invalidate();
        expect(body.isEnabled()).toBe(true);
        expect(label.isEnabled()).toBe(true);
        expect(hand.isEnabled()).toBe(false);
        expect(trail.isEnabled(), 'terminal Overview must keep the motion trail disabled').toBe(false);
        expect(frames).toBe(3);
        expect(scheduled).toBeUndefined();
    }
    finally {
        loop.dispose();
        scene.dispose();
        engine.dispose();
    }
});

it('preserves stationary and moving/review trail decisions while Visor suppresses only the local trail', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const localBody = MeshBuilder.CreateBox('local-body', {}, scene);
    const localTrail = MeshBuilder.CreateBox('local-trail', {}, scene);
    const remoteBody = MeshBuilder.CreateBox('remote-body', {}, scene);
    const remoteTrail = MeshBuilder.CreateBox('remote-trail', {}, scene);
    const avatars = new Map([
        ['alice', { parts: [localBody, localTrail], label: MeshBuilder.CreatePlane('local-label', {}, scene), trail: localTrail }],
        ['bob', { parts: [remoteBody, remoteTrail], label: MeshBuilder.CreatePlane('remote-label', {}, scene), trail: remoteTrail }]
    ]);
    const firstPersonRig = { root: new TransformNode('visor', scene) };
    try {
        localTrail.setEnabled(false);
        remoteTrail.setEnabled(true);
        syncRelicAvatarPresentation({ avatars, firstPersonRig, localPlayerId: 'alice', cameraMode: 'overview' });
        expect(localTrail.isEnabled(), 'stationary trail must remain disabled').toBe(false);
        expect(remoteTrail.isEnabled(), 'moving/review trail must retain its owner decision').toBe(true);
        localTrail.setEnabled(true);
        syncRelicAvatarPresentation({ avatars, firstPersonRig, localPlayerId: 'alice', cameraMode: 'first-person' });
        expect(localTrail.isEnabled()).toBe(false);
        expect(remoteTrail.isEnabled()).toBe(true);
        remoteTrail.setEnabled(false);
        syncRelicAvatarPresentation({ avatars, firstPersonRig, localPlayerId: 'alice', cameraMode: 'overview' });
        expect(localBody.isEnabled()).toBe(true);
        expect(firstPersonRig.root.isEnabled()).toBe(false);
        expect(localTrail.isEnabled()).toBe(false);
        expect(remoteTrail.isEnabled()).toBe(false);
    }
    finally {
        scene.dispose();
        engine.dispose();
    }
});
