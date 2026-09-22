import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import {
    GAME_PROTOCOL,
    type ArenaMatchDurationMs,
    type ArenaSnapshot,
    type MatchStartIntent,
    type PickupIntent
} from '../../types.ts';
import type { ArenaConnection } from '../arena-connection-contracts.ts';

interface ArenaWorldActionsInput {
    readonly nowMs: () => number;
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isNetworkEnabled: () => boolean;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly runBestEffortNetworkTask: <T>(task: () => Promise<T> | undefined, generation?: number) => void;
    readonly scheduleReliableArenaSnapshot: (snapshot: ArenaSnapshot, generation: number) => void;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
}

export function useArenaWorldActions(
    input: ArenaWorldActionsInput
): Pick<ArenaConnection, 'sendPickupIntent' | 'startArenaMatch' | 'publishArenaSnapshot'> {
    const sendPickupIntent = useCallback((intent: PickupIntent) => sendArenaPickupIntent(input, intent), [
        input.isNetworkEnabled,
        input.runBestEffortNetworkTask,
        input.nowMs
    ]);
    const startArenaMatch = useCallback(
        (durationMs: ArenaMatchDurationMs) => startArenaMatchFromIntent(input, durationMs),
        [
            input.isNetworkEnabled,
            input.nowMs
        ]
    );
    const publishArenaSnapshot = useCallback(
        (snapshot: ArenaSnapshot) => publishCurrentArenaSnapshot(input, snapshot),
        [
            input.isNetworkEnabled,
            input.isCurrentNetworkGeneration,
            input.scheduleReliableArenaSnapshot
        ]
    );
    return { sendPickupIntent, startArenaMatch, publishArenaSnapshot };
}

function sendArenaPickupIntent(input: ArenaWorldActionsInput, intent: PickupIntent): void {
    const session = input.sessionRef.current;
    const match = input.arenaMatchRef.current;
    if (!session || !input.isNetworkEnabled() || !match?.status().directorIsFresh) {
        return;
    }
    const fullIntent: PickupIntent = { ...intent, sessionId: session.sessionId, sentAtEpochMs: input.nowMs() };
    input.runBestEffortNetworkTask(() =>
        match.sendIntent({
            protocol: GAME_PROTOCOL,
            kind: 'pickup-intent',
            intent: fullIntent
        }), input.networkGenerationRef.current);
}

async function startArenaMatchFromIntent(
    input: ArenaWorldActionsInput,
    durationMs: ArenaMatchDurationMs
): Promise<void> {
    const session = input.sessionRef.current;
    const roomId = input.roomIdRef.current;
    const match = input.arenaMatchRef.current;
    if (!session || !roomId || !input.isNetworkEnabled() || !match?.status().directorIsFresh) {
        return;
    }
    const nowEpochMs = input.nowMs();
    const intent: MatchStartIntent = {
        matchId: `match:${roomId}:${nowEpochMs}:${durationMs}`,
        directorSessionId: session.sessionId,
        durationMs,
        sentAtEpochMs: nowEpochMs
    };
    await match.sendIntent({ protocol: GAME_PROTOCOL, kind: 'match-start-intent', intent });
}

function publishCurrentArenaSnapshot(input: ArenaWorldActionsInput, snapshot: ArenaSnapshot): void {
    if (!input.isNetworkEnabled()) {
        return;
    }
    const generation = input.networkGenerationRef.current;
    const previous = input.arenaSnapshotRef.current;
    if (previous && snapshot.revision < previous.revision) {
        return;
    }
    input.setArenaSnapshot((current) =>
        input.isCurrentNetworkGeneration(generation) && (!current || snapshot.revision >= current.revision)
            ? snapshot
            : current
    );
    input.arenaSnapshotRef.current = snapshot;
    const director = input.directorStatusRef.current;
    if (input.roomIdRef.current && director.isDirector && director.isFresh) {
        input.scheduleReliableArenaSnapshot(snapshot, generation);
    }
}
