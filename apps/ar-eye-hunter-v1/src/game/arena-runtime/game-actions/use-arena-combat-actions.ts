import { useCallback } from 'react';
import type { RefObject } from 'react';

import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { colorForId } from '../../color.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import {
    GAME_COMBAT_LANE_ID,
    GAME_PROTOCOL,
    type PlayerHitIntent,
    type PlayerShot,
    type ShotAccepted
} from '../../types.ts';
import type { ArenaConnection } from '../arena-connection-contracts.ts';
import type { ArenaPeerShotMessage } from '../messages/use-arena-peer-message-handlers.ts';

interface ArenaCombatActionsInput {
    readonly nowMs: () => number;
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isNetworkEnabled: () => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly runBestEffortNetworkTask: <T>(task: () => Promise<T> | undefined, generation?: number) => void;
    readonly sessionRef: RefObject<AuthSession | undefined>;
}

interface ArenaLocalShot {
    readonly shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>;
    readonly accepted: ShotAccepted;
}

export function useArenaCombatActions(
    input: ArenaCombatActionsInput
): Pick<ArenaConnection, 'sendShot' | 'sendPlayerHit'> {
    const sendShot = useCallback(
        (shot: ArenaLocalShot['shot'], accepted: ShotAccepted) => sendArenaShot(input, { shot, accepted }),
        [input.isNetworkEnabled, input.runBestEffortNetworkTask]
    );
    const sendPlayerHit = useCallback((intent: PlayerHitIntent) => sendArenaPlayerHit(input, intent), [
        input.isNetworkEnabled,
        input.runBestEffortNetworkTask,
        input.nowMs
    ]);
    return { sendShot, sendPlayerHit };
}

function sendArenaShot(input: ArenaCombatActionsInput, local: ArenaLocalShot): void {
    const session = input.sessionRef.current;
    const roomId = input.roomIdRef.current;
    const match = input.arenaMatchRef.current;
    if (!session || !roomId || !match || !input.isNetworkEnabled()) {
        return;
    }
    const generation = input.networkGenerationRef.current;
    const accepted: ShotAccepted = {
        ...local.accepted,
        shot: {
            ...local.shot,
            sessionId: session.sessionId,
            username: session.username,
            color: colorForId(session.sessionId)
        }
    };
    if (match.status().directorIsFresh) {
        input.runBestEffortNetworkTask(() =>
            match.sendIntent({
                protocol: GAME_PROTOCOL,
                kind: 'director-shot-accepted',
                accepted
            }), generation);
        return;
    }
    const director = input.directorStatusRef.current;
    if (director.appointment && !director.isFresh) {
        return;
    }
    const roomRef = rallar.rooms.state().currentRoomRef;
    if (!roomRef || roomRef.groupId !== roomId) {
        return;
    }
    const message: ArenaPeerShotMessage = {
        protocol: GAME_PROTOCOL,
        kind: 'director-shot-accepted',
        accepted,
        roomRef
    };
    input.runBestEffortNetworkTask(() =>
        rallar.realtime.room<ArenaPeerShotMessage>({
            laneId: GAME_COMBAT_LANE_ID,
            roomRef,
            openTimeoutMs: 1500
        }).send(message, { maxAgeMs: 1000 }), generation);
}

function sendArenaPlayerHit(input: ArenaCombatActionsInput, intent: PlayerHitIntent): void {
    const session = input.sessionRef.current;
    const match = input.arenaMatchRef.current;
    if (!session || !input.isNetworkEnabled() || !match?.status().directorIsFresh) {
        return;
    }
    const fullIntent: PlayerHitIntent = {
        ...intent,
        shot: {
            ...intent.shot,
            sessionId: session.sessionId,
            username: session.username,
            color: colorForId(session.sessionId)
        },
        sentAtEpochMs: input.nowMs()
    };
    input.runBestEffortNetworkTask(() =>
        match.sendIntent({
            protocol: GAME_PROTOCOL,
            kind: 'player-hit-intent',
            intent: fullIntent
        }), input.networkGenerationRef.current);
}
