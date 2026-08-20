import { useCallback } from 'react';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';

import { colorForId } from '../../color.ts';
import { createDeterministicAvatarProfile } from '../../avatarProfile.ts';
import {
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    type GameRealtimeMessage,
    type PlayerPose,
} from '../../types.ts';
import type { ArenaActions, ArenaActionsInput } from '../actions/use-arena-actions.ts';

export function useArenaPresenceActions(
    input: ArenaActionsInput,
): Pick<ArenaActions, 'sendPose'> {
    const {
        arenaMatchRef,
        isNetworkEnabled,
        localAvatarProfileRef,
        networkGenerationRef,
        poseSendBudget,
        roomIdRef,
        runBestEffortNetworkTask,
        sessionRef,
    } = input;

    const sendPose = useCallback((
        pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>,
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
                    currentSession.username,
                ),
        };
        const input: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose-intent',
            pose: fullPose,
        };
        const presence: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose',
            pose: fullPose,
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
                openTimeoutMs: 1500,
            }), generation);
    }, [isNetworkEnabled, runBestEffortNetworkTask]);

    return { sendPose };
}
