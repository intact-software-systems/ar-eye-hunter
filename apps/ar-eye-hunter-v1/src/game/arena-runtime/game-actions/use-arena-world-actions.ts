import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import {
    GAME_PROTOCOL,
    type ArenaEvent,
    type ArenaMatchDurationMs,
    type ArenaMatchLifecycleMessage,
    type ArenaPickupState,
    type ArenaSnapshot,
    type MatchStartIntent,
    type PickupIntent
} from '../../types.ts';
import type { ArenaConnection } from '../arena-connection-contracts.ts';
import type { ArenaMatchDelivery } from '../match/use-arena-match-delivery.ts';

interface ArenaWorldActionsInput extends Pick<ArenaMatchDelivery, 'publishMatchLifecycleOutput'> {
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
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
}

/** As long as the director's own pickup headline stays up. */
const PICKUP_TAKEN_HEADLINE_MS = 2_800;

export function useArenaWorldActions(
    input: ArenaWorldActionsInput
): Pick<ArenaConnection, 'sendPickupIntent' | 'startArenaMatch' | 'publishArenaSnapshot'> {
    const sendPickupIntent = useCallback((intent: PickupIntent) => sendArenaPickupIntent(input, intent), [
        input.isNetworkEnabled,
        input.isCurrentNetworkGeneration,
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
            input.publishMatchLifecycleOutput,
            input.runBestEffortNetworkTask,
            input.scheduleReliableArenaSnapshot
        ]
    );
    return { sendPickupIntent, startArenaMatch, publishArenaSnapshot };
}

/** The intent claims its pickup, so a pickup another session claimed first comes back `held-by-other`. */
function sendArenaPickupIntent(input: ArenaWorldActionsInput, intent: PickupIntent): void {
    const session = input.sessionRef.current;
    const match = input.arenaMatchRef.current;
    if (!session || !input.isNetworkEnabled() || !match?.status().directorIsFresh) {
        return;
    }
    const generation = input.networkGenerationRef.current;
    const fullIntent: PickupIntent = { ...intent, sessionId: session.sessionId, sentAtEpochMs: input.nowMs() };
    input.runBestEffortNetworkTask(async () => {
        const result = await match.sendIntent(
            { protocol: GAME_PROTOCOL, kind: 'pickup-intent', intent: fullIntent },
            { resourceId: intent.pickupId }
        );
        if (result.status === 'held-by-other') {
            setPickupTakenEvent(input, intent.pickupId, generation);
        }
    }, generation);
}

/** The loss is the local session's alone: it shows as the activity headline until the next arena event replaces it. */
function setPickupTakenEvent(input: ArenaWorldActionsInput, pickupId: string, generation: number): void {
    const snapshot = input.arenaSnapshotRef.current;
    const pickup = snapshot?.pickups.find((item) => item.id === pickupId);
    if (!snapshot || !pickup) {
        return;
    }
    const event = toPickupTakenEvent(pickup, snapshot.revision, input.nowMs());
    input.setActiveEvent((previous) => input.isCurrentNetworkGeneration(generation) ? event : previous);
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
        publishArenaMatchEnd(input, toArenaMatchEndedMessage(previous, snapshot), generation);
    }
}

function publishArenaMatchEnd(
    input: ArenaWorldActionsInput,
    message: ArenaMatchLifecycleMessage | undefined,
    generation: number
): void {
    const match = input.arenaMatchRef.current;
    if (message && match) {
        input.runBestEffortNetworkTask(() => input.publishMatchLifecycleOutput(match, message), generation);
    }
}

function toPickupTakenEvent(pickup: ArenaPickupState, revision: number, nowEpochMs: number): ArenaEvent {
    return {
        id: `pickup-taken:${pickup.id}`,
        kind: 'pickup-taken',
        position: pickup.position,
        durationMs: PICKUP_TAKEN_HEADLINE_MS,
        startsAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + PICKUP_TAKEN_HEADLINE_MS,
        revision,
        source: 'local',
        headline: `${pickup.label} was taken first`
    };
}

function toArenaMatchEndedMessage(
    previous: ArenaSnapshot | undefined,
    snapshot: ArenaSnapshot
): ArenaMatchLifecycleMessage | undefined {
    const match = snapshot.match;
    if (
        previous?.match?.status !== 'active' || match?.status !== 'complete' ||
        match.matchId !== previous.match.matchId
    ) {
        return undefined;
    }
    return {
        protocol: GAME_PROTOCOL,
        kind: 'director-match-ended',
        accepted: {
            match,
            revision: snapshot.revision,
            acceptedAtEpochMs: match.completedAtEpochMs ?? snapshot.sentAtEpochMs
        }
    };
}
