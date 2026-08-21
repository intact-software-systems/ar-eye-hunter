import type { AuthSession } from '@shared/api/api-config.ts';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';
import { useCallback } from 'react';
import type { RefObject } from 'react';

import { createDeterministicAvatarProfile } from '../../avatarProfile.ts';
import type { AvatarProfile } from '../../avatarProfile.ts';
import { colorForId } from '../../color.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import { GAME_MOTION_LANE_ID, GAME_PROTOCOL, type GameRealtimeMessage, type PlayerPose } from '../../types.ts';
import type { ArenaConnection } from '../arena-connection-contracts.ts';

interface ArenaPresenceActionsInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly isNetworkEnabled: () => boolean;
    readonly localAvatarProfileRef: RefObject<AvatarProfile | undefined>;
    readonly networkGenerationRef: RefObject<number>;
    readonly poseSendBudget: RefObject<number>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number
    ) => void;
    readonly sessionRef: RefObject<AuthSession | undefined>;
}

export function useArenaPresenceActions(
    input: ArenaPresenceActionsInput
): Pick<ArenaConnection, 'sendPose'> {
    const {
        arenaMatchRef,
        isNetworkEnabled,
        localAvatarProfileRef,
        networkGenerationRef,
        poseSendBudget,
        roomIdRef,
        runBestEffortNetworkTask,
        sessionRef
    } = input;

    const sendPose = useCallback((
        pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId || !isNetworkEnabled()) {
            return;
        }
        const generation = networkGenerationRef.current;

        const now = Date.now();
        if (!shouldSendRallarMotionSample(now, poseSendBudget.current, 50)) {
            return;
        }
        poseSendBudget.current = now + 50;

        const fullPose: PlayerPose = {
            ...pose,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
            avatarProfile: localAvatarProfileRef.current ??
                createDeterministicAvatarProfile(
                    currentSession.sessionId,
                    currentSession.username
                )
        };
        const input: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose-intent',
            pose: fullPose
        };
        const presence: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose',
            pose: fullPose
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            runBestEffortNetworkTask(() => match.sendInput(input), generation);
        }

        runBestEffortNetworkTask(() =>
            match?.sendPresence(presence, {
                laneId: GAME_MOTION_LANE_ID,
                key: `pose:${currentSession.sessionId}`,
                maxAgeMs: 250,
                openTimeoutMs: 1500
            }), generation);
    }, [isNetworkEnabled, runBestEffortNetworkTask]);

    return { sendPose };
}
