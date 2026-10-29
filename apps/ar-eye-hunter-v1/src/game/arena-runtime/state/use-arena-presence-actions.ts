import type { RefObject } from 'react';
import { useCallback } from 'react';

import type { AuthSession } from '@shared/api/api-config.ts';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';

import {
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    type GameRealtimeMessage,
    type PlayerPose
} from '../../arena-contracts.ts';
import type { AvatarProfile } from '../../avatarProfile.ts';
import { createDeterministicAvatarProfile } from '../../avatarProfile.ts';
import { colorForId } from '../../color.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaConnection } from '../arena-connection-contracts.ts';
import { isCurrentArenaSpectator } from '../arena-participation.ts';

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
    const sendPose = useCallback(
        (pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>) => sendArenaPose(input, pose),
        [input.isNetworkEnabled, input.runBestEffortNetworkTask]
    );
    return { sendPose };
}

function sendArenaPose(
    input: ArenaPresenceActionsInput,
    pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>
): void {
    const currentSession = input.sessionRef.current;
    const currentRoomId = input.roomIdRef.current;
    if (!currentSession || !currentRoomId || !input.isNetworkEnabled() || isCurrentArenaSpectator()) {
        return;
    }
    const generation = input.networkGenerationRef.current;

    const now = Date.now();
    if (!shouldSendRallarMotionSample(now, input.poseSendBudget.current, 50)) {
        return;
    }
    input.poseSendBudget.current = now + 50;

    const fullPose: PlayerPose = {
        ...pose,
        sessionId: currentSession.sessionId,
        username: currentSession.username,
        color: colorForId(currentSession.sessionId),
        avatarProfile: input.localAvatarProfileRef.current ??
            createDeterministicAvatarProfile(
                currentSession.sessionId,
                currentSession.username
            )
    };
    const poseIntent: GameRealtimeMessage = {
        protocol: GAME_PROTOCOL,
        kind: 'player-pose-intent',
        pose: fullPose
    };
    const presence: GameRealtimeMessage = {
        protocol: GAME_PROTOCOL,
        kind: 'player-pose',
        pose: fullPose
    };
    const match = input.arenaMatchRef.current;
    if (match?.status().directorIsFresh) {
        input.runBestEffortNetworkTask(() => match.sendInput(poseIntent), generation);
    }

    input.runBestEffortNetworkTask(() =>
        match?.sendPresence(presence, {
            laneId: GAME_MOTION_LANE_ID,
            key: `pose:${currentSession.sessionId}`,
            maxAgeMs: 250,
            openTimeoutMs: 1500
        }), generation);
}
