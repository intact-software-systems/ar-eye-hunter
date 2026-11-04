// @vitest-environment happy-dom
import { act } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
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

import type { ArenaSimulationState, ArenaSnapshot } from '@ar-eye-hunter/arena-contracts.ts';
import { applyArenaRematchCommand, type ArenaRematchCommand } from '@ar-eye-hunter/arena-rematch.ts';
import {
    createInitialArenaState,
    hydrateArenaSnapshot,
    spawnWeaponPickup,
    toArenaSnapshot
} from '@ar-eye-hunter/simulation.ts';
import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';
import { readRallarGameParticipants } from '@shared/rallar-game/read-rallar-game-participants.ts';
import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { ArenaSceneState } from '../../../apps/ar-eye-hunter-v1/src/game/scene/arena-scene-state.ts';

const arena = new ArenaRuntimeTestHarness();
beforeEach(() => arena.reset());
afterEach(async () => {
    await arena.dispose();
    mockMatch.publishSnapshot.mockReset();
});

function readyMatch(): ArenaSimulationState {
    const state = createInitialArenaState(44, 1_000);
    const completed: ArenaSimulationState = {
        ...state,
        match: {
            matchId: 'completed',
            status: 'complete',
            enrollment: 'open',
            durationMs: 60_000,
            directorSessionId: session.sessionId,
            startedAtEpochMs: 1_000,
            endsAtEpochMs: 61_000,
            completedAtEpochMs: 61_001,
            baseline: {},
            results: [{ sessionId: session.sessionId, username: 'hunter', scoreDelta: 0, killsDelta: 0, deathsDelta: 0, rank: 1 }]
        }
    };
    return applyArenaRematchCommand(completed, readyCommand(true), authority()).right!.state;
}

function authority() {
    return {
        nowEpochMs: Date.now(),
        leaderSessionId: session.sessionId,
        participants: readRallarGameParticipants(mockRallar.rooms.state().currentRoom, Date.now())
    };
}

function readyCommand(ready: boolean): ArenaRematchCommand {
    return {
        kind: 'ready',
        ready,
        sessionId: session.sessionId,
        completedGameId: 'completed',
        settingsKey: 'duration:60000:0',
        participationKey: authority().participants.find((player) => player.sessionId === session.sessionId)!.participationKey
    };
}

function snapshot(state: ArenaSimulationState): ArenaSnapshot {
    return toArenaSnapshot(state, 'arena-1', Date.now());
}

function isReady(state: ArenaSimulationState | ArenaSnapshot | undefined): boolean | undefined {
    return state?.match?.rematch?.preparation.players.find((player) => player.sessionId === session.sessionId)?.ready;
}

describe('accepted rematch state across renderer publication', () => {
    it('adopts an accepted cancellation at the same revision as an independent renderer advance', () => {
        const base = readyMatch();
        const scene = new ArenaSceneState(base);
        const local = { roomId: 'arena-1', sessionId: session.sessionId, epoch: 1, local: true, fresh: true, freshUntilEpochMs: Infinity };
        scene.reconcile({ snapshot: snapshot(base), authority: local });
        const predicted = spawnWeaponPickup(base, 62_000);
        scene.setPrediction(predicted);
        const predictedSnapshot = snapshot(predicted);
        scene.publishSnapshot(predictedSnapshot, () => true);
        scene.reconcile({ snapshot: predictedSnapshot, authority: local });
        const cancelled = applyArenaRematchCommand(base, readyCommand(false), authority()).right!.state;
        expect(predicted.revision).toBe(cancelled.revision);

        scene.reconcile({ snapshot: snapshot(cancelled), authority: local });

        expect(isReady(scene.getSimulation())).toBe(false);
        expect(scene.getSimulation().nextPickupAtEpochMs).toBe(predicted.nextPickupAtEpochMs);
        expect(scene.getSimulation().nextPickupSeq).toBe(predicted.nextPickupSeq);
    });

    it.each([1, 2])('rejects a renderer %i advances beyond its predecessor after cancellation was accepted', async (advances) => {
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        mockMatch.status.mockReturnValue({ ...mockMatch.status(), directorPeerId: session.sessionId, directorIsFresh: true });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const base = readyMatch();
        await act(async () => void arena.current?.publishArenaSnapshot(snapshot(base), arena.current?.arenaSnapshot));
        const predecessor = arena.current!.arenaSnapshot!;
        const rendererPublish = arena.current!.publishArenaSnapshot;
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)![0];
        const cancellation = createRallarGameEnvelope({
            protocol: 'ar-eye-hunter.v1',
            kind: 'intent',
            roomRef: arenaRoomRef,
            senderId: session.sessionId,
            senderGenerationId: 'generation-session-1',
            seq: 1,
            directorEpoch: 1,
            sentAtEpochMs: Date.now(),
            payload: { protocol: 'ar-eye-hunter.v1' as const, kind: 'match-rematch-intent' as const, command: readyCommand(false) }
        });
        await act(async () => config.onIntent?.(cancellation));
        expect(isReady(arena.current?.arenaSnapshot)).toBe(false);
        let stale = hydrateArenaSnapshot(predecessor);
        for (let index = 0; index < advances; index++) {
            stale = spawnWeaponPickup(stale, 62_000 + index);
        }
        await act(async () => void rendererPublish(snapshot(stale), predecessor));

        expect(isReady(arena.current?.arenaSnapshot)).toBe(false);
    });
    it('keeps accepted frame chains progressing and rejected chains fenced until authority adoption', async () => {
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        mockMatch.status.mockReturnValue({ ...mockMatch.status(), directorPeerId: session.sessionId, directorIsFresh: true });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const base = readyMatch();
        const observed = snapshot(base);
        await act(async () => {
            arena.current!.publishArenaSnapshot(observed, undefined);
        });
        const scene = new ArenaSceneState(base);
        const local = { roomId: 'arena-1', sessionId: session.sessionId, epoch: 1, local: true, fresh: true, freshUntilEpochMs: Infinity };
        scene.reconcile({ snapshot: observed, authority: local });
        const first = snapshot(spawnWeaponPickup(base, 62_000));
        const second = snapshot(spawnWeaponPickup(hydrateArenaSnapshot(first), 62_001));
        await act(async () => {
            expect(scene.publishSnapshot(first, arena.current!.publishArenaSnapshot)).toBe(true);
            scene.reconcile({ snapshot: observed, authority: local });
            expect(scene.getPublicationBase()).toBe(first);
            expect(scene.publishSnapshot(second, arena.current!.publishArenaSnapshot)).toBe(true);
        });
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)![0];
        await act(async () => {
            const accepted = config.onIntent?.(cancelEnvelope());
            const stale = snapshot(spawnWeaponPickup(hydrateArenaSnapshot(second), 62_002));
            expect(scene.publishSnapshot(stale, arena.current!.publishArenaSnapshot)).toBe(false);
            expect(scene.getPublicationBase()).toBe(second);
            expect(scene.publishSnapshot(snapshot(spawnWeaponPickup(hydrateArenaSnapshot(stale), 62_003)), arena.current!.publishArenaSnapshot)).toBe(false);
            await accepted;
        });
        expect(isReady(arena.current?.arenaSnapshot)).toBe(false);
        scene.reconcile({ snapshot: arena.current!.arenaSnapshot, authority: local });
        const rebased = snapshot(spawnWeaponPickup(scene.getSimulation(), 62_004));
        await act(async () => {
            expect(scene.publishSnapshot(rebased, arena.current!.publishArenaSnapshot)).toBe(true);
        });
        expect(isReady(arena.current?.arenaSnapshot)).toBe(false);
    });

    it('never sends a queued pre-cancellation renderer snapshot after the accepted cancellation', async () => {
        vi.useFakeTimers();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        mockMatch.status.mockReturnValue({ ...mockMatch.status(), directorPeerId: session.sessionId, directorIsFresh: true });
        const readiness: (boolean | undefined)[] = [];
        mockMatch.publishSnapshot.mockImplementation(async (value: ArenaSnapshot) => {
            readiness.push(isReady(value));
        });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const base = snapshot(readyMatch());
        await act(async () => {
            arena.current!.publishArenaSnapshot(base, undefined);
        });
        await act(async () => {
            arena.current!.publishArenaSnapshot(snapshot(spawnWeaponPickup(hydrateArenaSnapshot(base), 62_000)), base);
        });
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)![0];
        await act(async () => config.onIntent?.(cancelEnvelope()));
        expect(readiness).toEqual([true, false]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(readiness).toEqual([true, false]);
        const current = arena.current!.arenaSnapshot!;
        const next = snapshot(spawnWeaponPickup(hydrateArenaSnapshot(current), 63_000));
        await act(async () => {
            expect(arena.current!.publishArenaSnapshot(next, current)).toBe(true);
        });
        expect(readiness).toEqual([true, false, false]);
    });
});

function cancelEnvelope() {
    return createRallarGameEnvelope({
        protocol: 'ar-eye-hunter.v1',
        kind: 'intent',
        roomRef: arenaRoomRef,
        senderId: session.sessionId,
        senderGenerationId: 'generation-session-1',
        seq: 1,
        directorEpoch: 1,
        sentAtEpochMs: Date.now(),
        payload: { protocol: 'ar-eye-hunter.v1' as const, kind: 'match-rematch-intent' as const, command: readyCommand(false) }
    });
}
