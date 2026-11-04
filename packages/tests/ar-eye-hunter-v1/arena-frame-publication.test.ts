// @vitest-environment happy-dom
import { act } from 'react';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';
import {
    arenaRoomRef,
    ArenaRuntimeTestHarness,
    freshDirectorStatus,
    mockMatch,
    mockRallar,
    session,
    waitForState
} from './arena-runtime-test-harness.ts';

import { createInitialArenaState, toArenaSnapshot } from '@ar-eye-hunter/simulation.ts';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';
import { createDefaultArenaAudioSettings } from '../../../apps/ar-eye-hunter-v1/src/game/arena-audio.ts';
import { createDefaultMobileControlSettings } from '../../../apps/ar-eye-hunter-v1/src/game/mobile-input.ts';
import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import type { BabylonArenaProps } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-contracts.ts';
import { ArenaSceneRuntime } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-runtime.ts';
import { runFrame } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-step.ts';

const arena = new ArenaRuntimeTestHarness();
beforeEach(() => arena.reset());
afterEach(async () => {
    await arena.dispose();
    mockMatch.sendInput.mockReset();
});

it('completes an accepted minute after renderer pause while every resumed frame sends a local director pose', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockRallar.director.status.mockReturnValue(freshDirectorStatus());
    mockMatch.status.mockReturnValue({ ...mockMatch.status(), directorPeerId: session.sessionId, directorIsFresh: true });
    await arena.render();
    await waitForState(() => arena.current?.connectionState === 'connected');
    await act(async () => {
        arena.current!.publishArenaSnapshot(toArenaSnapshot(createInitialArenaState(44, now), 'arena-1', now), undefined);
    });
    const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)![0];
    let seq = 0;
    // The local-director transport invokes the registered input handler before its first await.
    mockMatch.sendInput.mockImplementation(async (payload) => {
        await config.onInput?.(createRallarGameEnvelope({
            protocol: 'ar-eye-hunter.v1',
            kind: 'input',
            roomRef: arenaRoomRef,
            senderId: session.sessionId,
            senderGenerationId: 'generation-session-1',
            seq: ++seq,
            directorEpoch: 1,
            sentAtEpochMs: now,
            payload
        }));
        return { status: 'sent', transport: 'local' };
    });
    installRasterCanvas();
    const engine = new NullEngine();
    const runtime = new ArenaSceneRuntime({
        canvas: document.createElement('canvas'),
        engine,
        props: { current: frameProps() },
        mobileSettings: createDefaultMobileControlSettings(),
        audioSettings: createDefaultArenaAudioSettings(),
        clock: { nowEpochMs: () => now, nowMonotonicMs: () => now }
    });
    try {
        now += 12_000;
        await act(async () =>
            config.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomRef: arenaRoomRef,
                senderId: session.sessionId,
                senderGenerationId: 'generation-session-1',
                seq: ++seq,
                directorEpoch: 1,
                sentAtEpochMs: now,
                payload: {
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'match-start-intent',
                    intent: {
                        matchId: 'paused-minute',
                        directorSessionId: session.sessionId,
                        durationMs: 60_000,
                        sentAtEpochMs: now
                    }
                }
            }))
        );
        expect(arena.current!.arenaSnapshot!.match?.status).toBe('active');
        const endsAt = arena.current!.arenaSnapshot!.match!.endsAtEpochMs;
        for (const frameTime of [now + 100, endsAt, endsAt + 100]) {
            now = frameTime;
            const props = frameProps();
            if (frameTime === endsAt) {
                // A real remote input accepted after capture must fence this frame, even at completion.
                await act(async () =>
                    config.onInput?.(createRallarGameEnvelope({
                        protocol: 'ar-eye-hunter.v1',
                        kind: 'input',
                        roomRef: arenaRoomRef,
                        senderId: 'peer-1',
                        senderGenerationId: 'generation-peer-1',
                        seq: 1,
                        directorEpoch: 1,
                        sentAtEpochMs: now,
                        payload: {
                            protocol: 'ar-eye-hunter.v1',
                            kind: 'player-pose-intent',
                            pose: {
                                sessionId: 'peer-1',
                                username: 'peer',
                                color: '#ffffff',
                                score: 7,
                                position: [40, 1.72, 40],
                                rotation: [0, 0, 0],
                                seq: 1,
                                sentAtEpochMs: now
                            }
                        }
                    }))
                );
            }
            await act(async () => runFrame({ ...props, runtime }));
            if (frameTime === endsAt) {
                expect(arena.current!.arenaSnapshot!.match?.status).toBe('active');
                expect(arena.current!.arenaSnapshot!.players.find((player) => player.sessionId === 'peer-1')?.score).toBe(7);
            }
        }
        expect(runtime.arenaState.match?.status).toBe('complete');
        expect(arena.current!.arenaSnapshot!.players.find((player) => player.sessionId === session.sessionId)?.seq).toBe(3);
        expect(arena.current!.arenaSnapshot!.match).toMatchObject({ matchId: 'paused-minute', status: 'complete' });
        expect(arena.current!.arenaSnapshot!.match!.results).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'peer-1', scoreDelta: 7 })]));
        expect(mockMatch.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'director-match-ended' }), { ack: 'all-logical-recipients' });
    }
    finally {
        runtime.stop();
        engine.dispose();
    }
});

function frameProps(): BabylonArenaProps {
    const current = arena.current!;
    return {
        localSessionId: session.sessionId,
        localUsername: session.username,
        localColor: '#00ff88',
        roomId: 'arena-1',
        roomReady: true,
        networkEnabled: true,
        spectating: false,
        authority: { roomId: 'arena-1', sessionId: session.sessionId, epoch: 1, local: true, fresh: true, freshUntilEpochMs: Infinity },
        linkState: current.linkState,
        presenceNotices: [],
        remotePlayers: new Map(),
        remoteShots: [],
        remotePlayerHits: [],
        remoteEvents: [],
        arenaSnapshot: current.arenaSnapshot,
        onLocalPose: current.sendPose,
        onLocalShot: current.sendShot,
        onPlayerHitIntent: current.sendPlayerHit,
        onPickupIntent: current.sendPickupIntent,
        onLocalCombatChange: () => {},
        onLocalPlayerChange: () => {},
        onArenaSnapshot: current.publishArenaSnapshot
    };
}

/** Only canvas raster drawing is replaced; the real frame, scene, simulation and runtime owners execute. */
function installRasterCanvas(): void {
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
}
