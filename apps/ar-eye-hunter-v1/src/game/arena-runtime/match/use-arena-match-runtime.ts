import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';

import { GAME_SNAPSHOT_LANE_ID } from '../../rallar-game-match-adapter.ts';
import { GAME_AI_LANE_ID, GAME_COMBAT_LANE_ID, GAME_FX_LANE_ID, GAME_MOTION_LANE_ID } from '../../types.ts';
import type { ArenaConnectionState, DirectorAttemptSource } from '../arena-connection-contracts.ts';
import type { ArenaPeerShotMessage } from '../messages/use-arena-peer-message-handlers.ts';
import { createArenaMatchRuntime, type ArenaMatchRuntimeInput } from './create-arena-match-runtime.ts';

interface ArenaMatchLifecycleInput extends ArenaMatchRuntimeInput {
    readonly activeMatchRoomIdRef: RefObject<string | undefined>;
    readonly bumpNetworkGeneration: () => number;
    readonly connectionState: ArenaConnectionState;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomId: string | undefined;
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number
    ) => void;
    readonly setDirectorStatus: Dispatch<SetStateAction<RallarDirectorStatus>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
}

interface ArenaMatchSession {
    readonly input: ArenaMatchLifecycleInput;
    readonly match: ReturnType<typeof createArenaMatchRuntime>;
    readonly generation: number;
    readonly roomId: string;
    readonly signal: AbortSignal;
}

export function useArenaMatchRuntime(
    input: ArenaMatchLifecycleInput,
    attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>
): void {
    useEffect(() => startArenaMatchSession(input, attemptDirectorAppointment), [
        input.acceptDirectorOutput,
        input.acceptPeerShot,
        input.acceptMatchStartIntent,
        input.acceptMotionMessage,
        input.acceptPickup,
        input.acceptPlayerHit,
        attemptDirectorAppointment,
        input.bumpNetworkGeneration,
        input.connectionState,
        input.isCurrentNetworkGeneration,
        input.roomId,
        input.runBestEffortNetworkTask
    ]);
}

function startArenaMatchSession(
    input: ArenaMatchLifecycleInput,
    attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>
): (() => void) | undefined {
    const previousRoomId = input.activeMatchRoomIdRef.current;
    const generation = previousRoomId || (input.connectionState === 'connected' && input.roomId)
        ? input.bumpNetworkGeneration()
        : input.networkGenerationRef.current;
    input.arenaMatchRef.current?.stop();
    input.arenaMatchRef.current = undefined;
    input.activeMatchRoomIdRef.current = undefined;
    if (input.connectionState !== 'connected' || !input.roomId) {
        return;
    }
    const controller = new AbortController();
    const session: ArenaMatchSession = {
        input,
        generation,
        roomId: input.roomId,
        match: createArenaMatchRuntime(input, generation, input.roomId),
        signal: controller.signal
    };
    input.arenaMatchRef.current = session.match;
    input.activeMatchRoomIdRef.current = session.roomId;
    const unsubscribePeerShots = subscribeArenaPeerShots(session);
    const unsubscribe = session.match.onStatus(() => {
        input.setDirectorStatus(rallar.director.status(session.roomId));
        input.setGameDiagnostics(session.match.diagnostics());
    });
    void startAndSyncArenaMatch(session, attemptDirectorAppointment).catch((error) => {
        if (isCurrentArenaMatchSession(session)) {
            input.setError(error instanceof Error ? error.message : String(error));
        }
    });
    return () => {
        controller.abort();
        unsubscribe();
        unsubscribePeerShots();
        session.match.stop();
        if (input.arenaMatchRef.current === session.match) {
            input.arenaMatchRef.current = undefined;
        }
    };
}

async function startAndSyncArenaMatch(
    session: ArenaMatchSession,
    attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>
): Promise<void> {
    await session.match.start();
    if (!isCurrentArenaMatchSession(session)) {
        return;
    }
    session.input.setGameDiagnostics(session.match.diagnostics());
    await attemptDirectorAppointment('auto');
    if (!isCurrentArenaMatchSession(session)) {
        return;
    }
    session.input.setGameDiagnostics(session.match.diagnostics());
    await session.match.requestSync({ reason: 'arena-join' });
    session.input.runBestEffortNetworkTask(() => syncReadyArenaPeers(session), session.generation);
}

async function syncReadyArenaPeers(session: ArenaMatchSession): Promise<void> {
    const readiness = await session.match.waitForReadyLanes({
        laneIds: [GAME_MOTION_LANE_ID, GAME_COMBAT_LANE_ID, GAME_SNAPSHOT_LANE_ID, GAME_FX_LANE_ID, GAME_AI_LANE_ID],
        expect: { min: 0 },
        timeoutMs: 650
    });
    if (!isCurrentArenaMatchSession(session)) {
        return;
    }
    session.input.setGameDiagnostics(session.match.diagnostics());
    if (readiness.readyPeerIds.length > 0) {
        await session.match.requestSync({ reason: 'arena-peer-ready' });
    }
}

function isCurrentArenaMatchSession(session: ArenaMatchSession): boolean {
    return !session.signal.aborted && session.input.arenaMatchRef.current === session.match &&
        session.input.isCurrentNetworkGeneration(session.generation);
}

function subscribeArenaPeerShots(session: ArenaMatchSession): () => void {
    return rallar.realtime.onJson<ArenaPeerShotMessage>(GAME_COMBAT_LANE_ID, (message) => {
        if (!isCurrentArenaMatchSession(session)) {
            return;
        }
        const roomRef = rallar.rooms.state().currentRoomRef;
        if (!roomRef || roomRef.groupId !== session.roomId) {
            return;
        }
        const isCurrent = () => {
            if (!isCurrentArenaMatchSession(session) || session.input.roomIdRef.current !== session.roomId) {
                return false;
            }
            const currentRoomRef = rallar.rooms.state().currentRoomRef;
            return Boolean(currentRoomRef && isSameGroupRef(currentRoomRef, roomRef));
        };
        session.input.acceptPeerShot({ peerId: message.peerId, message: message.data, roomRef, isCurrent });
    });
}
