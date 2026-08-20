import { useCallback } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';

import { colorForId } from '../../color.ts';
import { hydrateArenaSnapshot, resolvePlayerHitIntent, toArenaSnapshot } from '../../simulation.ts';
import {
    GAME_COMBAT_LANE_ID,
    GAME_PROTOCOL,
    type GameRealtimeMessage,
    type PlayerHitIntent,
    type PlayerShot,
    type ShotAccepted,
} from '../../types.ts';
import type { ArenaActions, ArenaActionsInput } from '../actions/use-arena-actions.ts';

export function useArenaCombatActions(
    input: ArenaActionsInput,
): Pick<ArenaActions, 'sendShot' | 'sendPlayerHit'> {
    const {
        acceptPlayerHit,
        arenaMatchRef,
        arenaSnapshotRef,
        directorStatusRef,
        isNetworkEnabled,
        networkGenerationRef,
        roomIdRef,
        runBestEffortNetworkTask,
        sessionRef,
        setArenaSnapshot,
    } = input;

    const sendShot = useCallback((
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId || !isNetworkEnabled()) {
            return;
        }
        const generation = networkGenerationRef.current;

        const fullShot: PlayerShot = {
            ...shot,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
        };
        const fullAccepted: ShotAccepted = {
            ...accepted,
            shot: fullShot,
        };
        const acceptedMessage: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'director-shot-accepted',
            accepted: fullAccepted,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                runBestEffortNetworkTask(() => match.publishEvent(acceptedMessage), generation);
            } else {
                runBestEffortNetworkTask(() => match.sendIntent(acceptedMessage), generation);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        runBestEffortNetworkTask(() =>
            rallar.realtime.room<GameRealtimeMessage>({
                laneId: GAME_COMBAT_LANE_ID,
                roomId: currentRoomId,
                openTimeoutMs: 1500,
            }).send({
                protocol: GAME_PROTOCOL,
                kind: 'director-shot-accepted',
                accepted: fullAccepted,
            }, {
                maxAgeMs: 1000,
            }), generation);
    }, [isNetworkEnabled, runBestEffortNetworkTask]);

    const sendPlayerHit = useCallback((intent: PlayerHitIntent) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId || !isNetworkEnabled()) {
            return;
        }
        const generation = networkGenerationRef.current;

        const fullIntent: PlayerHitIntent = {
            ...intent,
            shot: {
                ...intent.shot,
                sessionId: currentSession.sessionId,
                username: currentSession.username,
                color: colorForId(currentSession.sessionId),
            },
            sentAtEpochMs: Date.now(),
        };
        const message: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-hit-intent',
            intent: fullIntent,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                const previous = arenaSnapshotRef.current;
                if (!previous) {
                    return;
                }
                const result = resolvePlayerHitIntent(
                    hydrateArenaSnapshot(previous),
                    fullIntent,
                    Date.now(),
                );
                if (!result.accepted) {
                    return;
                }
                const snapshot = toArenaSnapshot(
                    result.state,
                    previous.roomId ?? currentRoomId,
                    Date.now(),
                );
                arenaSnapshotRef.current = snapshot;
                setArenaSnapshot(snapshot);
                acceptPlayerHit(result.acceptedHit);
                runBestEffortNetworkTask(() =>
                    match.publishEvent({
                        protocol: GAME_PROTOCOL,
                        kind: 'director-player-hit-accepted',
                        accepted: result.acceptedHit,
                    }), generation);
                runBestEffortNetworkTask(
                    () => match.publishSnapshot(snapshot, { reliable: false }),
                    generation,
                );
            } else {
                runBestEffortNetworkTask(() => match.sendIntent(message), generation);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        runBestEffortNetworkTask(() =>
            rallar.realtime.room<GameRealtimeMessage>({
                laneId: GAME_COMBAT_LANE_ID,
                roomId: currentRoomId,
                openTimeoutMs: 1500,
            }).send(message, {
                maxAgeMs: 650,
            }), generation);
    }, [acceptPlayerHit, isNetworkEnabled, runBestEffortNetworkTask]);

    return { sendShot, sendPlayerHit };
}
