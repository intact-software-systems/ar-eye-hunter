import { useCallback } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';

import { hydrateArenaSnapshot, resolvePickupIntent, toArenaSnapshot } from '../../simulation.ts';
import {
    type ArenaMatchDurationMs,
    type ArenaSnapshot,
    GAME_COMBAT_LANE_ID,
    GAME_PROTOCOL,
    type GameRealtimeMessage,
    type MatchStartIntent,
    type PickupIntent,
} from '../../types.ts';
import type { ArenaActions, ArenaActionsInput } from '../actions/use-arena-actions.ts';

export function useArenaWorldActions(
    input: ArenaActionsInput,
): Pick<
    ArenaActions,
    'sendPickupIntent' | 'startArenaMatch' | 'publishArenaSnapshot'
> {
    const {
        acceptMatchStartIntent,
        acceptPickup,
        arenaMatchRef,
        arenaSnapshotRef,
        directorStatusRef,
        isNetworkEnabled,
        networkGenerationRef,
        roomIdRef,
        runBestEffortNetworkTask,
        scheduleReliableArenaSnapshot,
        sessionRef,
        setArenaSnapshot,
    } = input;

    const sendPickupIntent = useCallback((intent: PickupIntent) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId || !isNetworkEnabled()) {
            return;
        }
        const generation = networkGenerationRef.current;

        const fullIntent: PickupIntent = {
            ...intent,
            sessionId: currentSession.sessionId,
            sentAtEpochMs: Date.now(),
        };
        const message: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'pickup-intent',
            intent: fullIntent,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                const previous = arenaSnapshotRef.current;
                if (!previous) {
                    return;
                }
                const result = resolvePickupIntent(
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
                acceptPickup(result.acceptedPickup);
                runBestEffortNetworkTask(() =>
                    match.publishEvent({
                        protocol: GAME_PROTOCOL,
                        kind: 'director-pickup-accepted',
                        accepted: result.acceptedPickup,
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
                key: `pickup:${fullIntent.pickupId}`,
                maxAgeMs: 650,
            }), generation);
    }, [acceptPickup, isNetworkEnabled, runBestEffortNetworkTask]);

    const startArenaMatch = useCallback(async (durationMs: ArenaMatchDurationMs) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId || !isNetworkEnabled()) {
            return;
        }
        const now = Date.now();
        const intent: MatchStartIntent = {
            matchId: `match:${currentRoomId}:${now}:${durationMs}`,
            directorSessionId: currentSession.sessionId,
            durationMs,
            sentAtEpochMs: now,
        };
        const message: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'match-start-intent',
            intent,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                await acceptMatchStartIntent(intent);
            } else {
                await match.sendIntent(message);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        await rallar.realtime.room<GameRealtimeMessage>({
            laneId: GAME_COMBAT_LANE_ID,
            roomId: currentRoomId,
            openTimeoutMs: 1500,
        }).send(message, {
            key: `match-start:${intent.matchId}`,
            maxAgeMs: 1_000,
        });
    }, [acceptMatchStartIntent, isNetworkEnabled]);

    const publishArenaSnapshot = useCallback((snapshot: ArenaSnapshot) => {
        if (!isNetworkEnabled()) {
            return;
        }
        const generation = networkGenerationRef.current;
        const previousSnapshot = arenaSnapshotRef.current;
        if (previousSnapshot && snapshot.revision < previousSnapshot.revision) {
            return;
        }
        setArenaSnapshot((previous) =>
            !previous || snapshot.revision >= previous.revision ? snapshot : previous
        );
        arenaSnapshotRef.current = snapshot;

        const currentRoomId = roomIdRef.current;
        const currentDirector = directorStatusRef.current;
        if (!currentRoomId || !currentDirector.isDirector || !currentDirector.isFresh) {
            return;
        }

        scheduleReliableArenaSnapshot(snapshot, generation);
    }, [isNetworkEnabled, scheduleReliableArenaSnapshot]);

    return { sendPickupIntent, startArenaMatch, publishArenaSnapshot };
}
