// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';

import type { RelicSceneRuntime } from '../../src/game/scene/neon/relic-scene-runtime.ts';
import { createRelicSceneRuntime } from '../../src/game/scene/neon/relic-scene-runtime.ts';

const graphics = vi.hoisted(() => ({ dispose: vi.fn() }));
vi.mock('@babylonjs/core/Engines/engine.js', () => ({
    Engine: class {
        setHardwareScalingLevel(): void {
            throw new Error('early scaling failure');
        }
        dispose(): void {
            graphics.dispose();
        }
    }
}));

it('disposes the allocated engine if early scaling fails before Scene construction', () => {
    const input: RelicSceneRuntime.Input = {
        canvas: document.createElement('canvas'),
        snapshot: {
            tournament: null,
            protocolVersion: 1,
            gameId: 'game',
            roomId: 'room',
            phase: 'lobby',
            round: 1,
            maxRounds: 10,
            createdAtEpochMs: 1,
            updatedAtEpochMs: 1,
            roundTimeLimitMs: 60000,
            map: [],
            players: [],
            relics: [],
            events: [],
            roomInvestigations: [],
            submittedPlayerIds: [],
            winnerIds: []
        },
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
        onPickupPromptChange: () => undefined,
        onCameraModeChange: () => undefined
    };
    expect(() => createRelicSceneRuntime(input)).toThrow('early scaling failure');
    // interaction: Failed startup releases its one allocated graphics lifetime exactly once;
    // missing or duplicate disposal exposes a leak or competing cleanup owners.
    expect(graphics.dispose).toHaveBeenCalledOnce();
});
