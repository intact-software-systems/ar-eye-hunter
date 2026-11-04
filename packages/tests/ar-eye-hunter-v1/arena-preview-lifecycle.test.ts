// @vitest-environment happy-dom
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createInitialArenaState, toArenaSnapshot } from '@ar-eye-hunter/simulation.ts';
import { createDefaultArenaAudioSettings } from '../../../apps/ar-eye-hunter-v1/src/game/arena-audio.ts';
import { createDefaultMobileControlSettings } from '../../../apps/ar-eye-hunter-v1/src/game/mobile-input.ts';
import type { BabylonArenaProps } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';
import { ArenaSceneRuntime } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-runtime.ts';
import { applyLook } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-step.ts';
import { ArenaTouchInput } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-touch-input.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.restoreAllMocks());

class PreviewFixture {
    now = 1_000;
    readonly engine = new NullEngine();
    readonly canvas = document.createElement('canvas');
    readonly props = { current: previewProps() };
    readonly runtime: ArenaSceneRuntime;

    constructor() {
        vi.mocked(vi.spyOn(HTMLCanvasElement.prototype, 'getContext'), { partial: true }).mockReturnValue({
            clearRect: () => {},
            fillRect: () => {},
            strokeRect: () => {},
            fillText: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {}
        });
        this.runtime = new ArenaSceneRuntime({
            canvas: this.canvas,
            engine: this.engine,
            props: this.props,
            mobileSettings: createDefaultMobileControlSettings(),
            audioSettings: createDefaultArenaAudioSettings(),
            clock: { nowEpochMs: () => this.now, nowMonotonicMs: () => this.now }
        });
        // NullEngine has no shader compiler; browser coverage checks actual material readiness.
        vi.spyOn(this.runtime.scene, 'isReady').mockReturnValue(true);
        this.runtime.start();
    }

    frames(count: number): void {
        for (let index = 0; index < count; index++) {
            this.now += 20;
            for (const frame of [...this.engine.activeRenderLoops]) {
                frame();
            }
        }
    }

    dispose(): void {
        this.runtime.stop();
        this.engine.dispose();
    }
}

describe('untouched arena preview', () => {
    it.each(['stopped', 'terminal'])('rejects real touch controls and look changes after the scene is %s', async (boundary) => {
        const fixture = new PreviewFixture();
        const element = document.createElement('div');
        const root = createRoot(element);
        const touch = new ArenaTouchInput({ runtimeRef: { current: fixture.runtime }, localColor: '#00ff88', onStickChange: () => {} });
        try {
            fixture.frames(10);
            if (boundary === 'stopped') {
                fixture.runtime.stop();
            }
            else {
                fixture.props.current = { ...fixture.props.current, tournament: cancelledTournament() };
            }
            const before = fixture.runtime.localPlayer;
            const effects = fixture.runtime.createdEffectCount;
            await act(async () =>
                root.render(
                    createElement(
                        'div',
                        null,
                        createElement('button', { onPointerDown: touch.onScanDown }, 'Scan'),
                        createElement('div', { onPointerDown: touch.onMovePointerDown }, 'Move'),
                        createElement('div', { onPointerDown: touch.onLookPointerDown }, 'Look')
                    )
                )
            );
            for (const control of element.querySelectorAll('button, div div')) {
                await act(async () => {
                    control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
                });
            }
            applyLook(fixture.runtime, 0.1, 0.2);
            expect(fixture.runtime.input.altFire).toBe(false);
            expect(fixture.runtime.touchState.movePointerId).toBeUndefined();
            expect(fixture.runtime.touchState.lookPointerId).toBeUndefined();
            expect(fixture.runtime.localPlayer.yaw).toBe(before.yaw);
            expect(fixture.runtime.localPlayer.pitch).toBe(before.pitch);
            expect(fixture.runtime.createdEffectCount).toBe(effects);
        }
        finally {
            await act(async () => root.unmount());
            fixture.dispose();
        }
    });
    it('fires a held offline control after preview interaction without enabling network publication', () => {
        const fixture = new PreviewFixture();
        try {
            fixture.frames(10);
            fixture.runtime.beginInteraction();
            fixture.runtime.input.fire = true;
            fixture.frames(2);
            expect(fixture.runtime.shotSeqRef.current).toBeGreaterThan(0);
            expect(fixture.runtime.simulation.canPublish(fixture.now)).toBe(false);
        }
        finally {
            fixture.dispose();
        }
    });
    it('keeps zero look samples idle and wakes fine aiming and pulse controls with fresh timing', () => {
        const fixture = new PreviewFixture();
        try {
            fixture.frames(10);
            applyLook(fixture.runtime, 0, 0);
            expect(fixture.engine.activeRenderLoops).toHaveLength(0);
            fixture.now += 60_000;
            applyLook(fixture.runtime, 0.1, -0.1);
            expect(fixture.runtime.localPlayer.yaw).toBeCloseTo(0.1);
            expect(fixture.runtime.localPlayer.pitch).toBeCloseTo(-0.1);
            expect(fixture.engine.activeRenderLoops).toHaveLength(1);
            fixture.runtime.pulse('jump', 120);
            expect(fixture.runtime.input.jump).toBe(true);
            fixture.frames(1);
            expect(fixture.runtime.localPlayer.position[1]).toBeGreaterThan(1.72);
        }
        finally {
            fixture.dispose();
        }
    });
    it('settles after ready drawing and ignores unrelated props until resize or game input', () => {
        const fixture = new PreviewFixture();
        try {
            fixture.frames(10);
            expect(fixture.runtime.scene.isReady()).toBe(true);
            expect(fixture.engine.activeRenderLoops).toHaveLength(0);
            const frame = fixture.runtime.scene.getFrameId();
            fixture.props.current = { ...fixture.props.current, presenceNotices: [] };
            fixture.runtime.refreshPresentation();
            fixture.frames(3);
            expect(fixture.runtime.scene.getFrameId()).toBe(frame);
            window.dispatchEvent(new Event('resize'));
            fixture.frames(3);
            expect(fixture.runtime.scene.getFrameId()).toBe(frame + 1);
            expect(fixture.engine.activeRenderLoops).toHaveLength(0);
        }
        finally {
            fixture.dispose();
        }
    });

    it('keeps Ops typing idle and resumes offline movement with fresh timing on a game key', () => {
        const fixture = new PreviewFixture();
        const field = document.createElement('input');
        document.body.append(field);
        try {
            fixture.frames(10);
            field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
            fixture.frames(2);
            expect(fixture.engine.activeRenderLoops).toHaveLength(0);
            expect(fixture.runtime.input.moveZ).toBe(0);
            fixture.now += 60_000;
            const before = fixture.runtime.localPlayer.position;
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
            fixture.frames(2);
            const after = fixture.runtime.localPlayer.position;
            expect(after[2]).toBeGreaterThan(before[2]);
            expect(after[2] - before[2]).toBeLessThan(1);
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
            fixture.frames(2);
            expect(fixture.engine.activeRenderLoops).toHaveLength(1);
        }
        finally {
            field.remove();
            fixture.dispose();
        }
    });

    it.each(['joining', 'spectating'])('keeps %s scenes live without requiring a local interaction', (mode) => {
        const fixture = new PreviewFixture();
        try {
            fixture.frames(10);
            fixture.props.current = { ...fixture.props.current, roomId: mode === 'joining' ? 'room' : undefined, spectating: mode === 'spectating' };
            fixture.runtime.refreshPresentation();
            fixture.frames(2);
            expect(fixture.engine.activeRenderLoops).toHaveLength(1);
            const queued = fixture.engine.activeRenderLoops[0];
            fixture.runtime.stop();
            const frame = fixture.runtime.scene.getFrameId();
            queued();
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
            expect(fixture.runtime.scene.getFrameId()).toBe(frame);
            expect(fixture.engine.activeRenderLoops).toHaveLength(0);
        }
        finally {
            fixture.dispose();
        }
    });
});

function cancelledTournament(): BabylonArenaProps['tournament'] {
    return {
        snapshot: {
            binding: {
                tournamentRef: { applicationId: 'arena', workspaceId: 'test', tournamentId: 'cup' },
                roomRef: { applicationId: 'arena', workspaceId: 'test', groupId: 'room' },
                slot: 'semifinal-1',
                attemptId: 'attempt',
                gameId: 'game',
                rulesId: 'ar-eye-native-60s-v1',
                principalIds: ['one', 'two']
            },
            status: 'cancelled',
            state: null,
            observedAtEpochMs: 1_000
        },
        sendControls: () => {}
    };
}

function previewProps(): BabylonArenaProps {
    return {
        localSessionId: undefined,
        localUsername: 'local',
        localColor: '#00ff88',
        roomId: undefined,
        roomReady: false,
        networkEnabled: false,
        spectating: false,
        authority: { roomId: undefined, sessionId: undefined, epoch: undefined, local: false, fresh: false, freshUntilEpochMs: 0 },
        linkState: { tone: 'live', label: 'Preview', detail: '', playerCount: 1, actionNeeded: false },
        presenceNotices: [],
        remotePlayers: new Map(),
        remoteShots: [],
        remotePlayerHits: [],
        remoteEvents: [],
        arenaSnapshot: toArenaSnapshot(createInitialArenaState(44, 1_000), undefined, 1_000),
        onLocalPose: () => {},
        onLocalShot: () => {},
        onPlayerHitIntent: () => {},
        onPickupIntent: () => {},
        onLocalCombatChange: () => {},
        onLocalPlayerChange: () => {},
        onArenaSnapshot: () => false
    };
}
