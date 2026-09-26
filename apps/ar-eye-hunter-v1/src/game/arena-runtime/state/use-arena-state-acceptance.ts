import { useMemo } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import {
    applyEyeAttackAccepted,
    applyPickupAccepted,
    applyPlayerHitAccepted,
    hydrateArenaSnapshot,
    startArenaMatch,
    toArenaSnapshot,
    type ArenaSimulationState
} from '../../simulation.ts';
import {
    GAME_PROTOCOL,
    type ArenaEvent,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    type MatchStartIntent,
    type PickupAccepted,
    type PlayerHitAccepted
} from '../../types.ts';
import type { ArenaMatchDelivery } from '../match/use-arena-match-delivery.ts';

export interface ArenaStateAcceptance {
    readonly acceptPlayerHit: (accepted: PlayerHitAccepted, isCurrent: () => boolean) => void;
    readonly acceptPickup: (accepted: PickupAccepted, isCurrent: () => boolean) => void;
    readonly acceptEyeAttack: (accepted: EyeAttackAccepted, isCurrent: () => boolean) => void;
    readonly acceptMatchStartIntent: (intent: MatchStartIntent, isCurrent: () => boolean) => Promise<void>;
}

interface ArenaStateAcceptanceInput extends Pick<ArenaMatchDelivery, 'publishMatchLifecycleOutput'> {
    readonly nowMs: () => number;
    readonly arenaMatchRef: RefObject<Pick<ArenaRallarGameMatchHandle, 'publishEvent' | 'publishSnapshot'> | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setPickupAcceptances: Dispatch<SetStateAction<readonly PickupAccepted[]>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
    readonly setRemotePlayerHits: Dispatch<SetStateAction<readonly PlayerHitAccepted[]>>;
}

interface ArenaAcceptedStateProjection {
    readonly isCurrent: () => boolean;
    readonly roomId: string | undefined;
    readonly nowEpochMs: number;
    readonly apply: (state: ArenaSimulationState) => ArenaSimulationState;
}

export function useArenaStateAcceptance(input: ArenaStateAcceptanceInput): ArenaStateAcceptance {
    return useMemo(() => ({
        acceptPlayerHit: (accepted: PlayerHitAccepted, isCurrent: () => boolean) =>
            acceptArenaPlayerHit(input, accepted, isCurrent),
        acceptPickup: (accepted: PickupAccepted, isCurrent: () => boolean) =>
            acceptArenaPickup(input, accepted, isCurrent),
        acceptEyeAttack: (accepted: EyeAttackAccepted, isCurrent: () => boolean) => {
            if (!isCurrent()) {
                return;
            }
            projectAcceptedArenaState(input, {
                isCurrent,
                roomId: input.roomIdRef.current,
                nowEpochMs: input.nowMs(),
                apply: (state) => applyEyeAttackAccepted(state, accepted)
            });
        },
        acceptMatchStartIntent: (intent: MatchStartIntent, isCurrent: () => boolean) =>
            acceptArenaMatchStart(input, intent, isCurrent)
    }), [
        input.nowMs,
        input.publishMatchLifecycleOutput,
        input.arenaMatchRef,
        input.arenaSnapshotRef,
        input.roomIdRef,
        input.setActiveEvent,
        input.setArenaSnapshot,
        input.setPickupAcceptances,
        input.setRemoteEvents,
        input.setRemotePlayerHits
    ]);
}

function acceptArenaPlayerHit(
    input: ArenaStateAcceptanceInput,
    accepted: PlayerHitAccepted,
    isCurrent: () => boolean
): void {
    if (!isCurrent()) {
        return;
    }
    input.setRemotePlayerHits((previous) =>
        isCurrent()
            ? [
                ...previous.filter((item) =>
                    item.revision !== accepted.revision ||
                    item.target.sessionId !== accepted.target.sessionId ||
                    item.intent.shot.seq !== accepted.intent.shot.seq
                ).slice(-24),
                accepted
            ]
            : previous
    );
    projectAcceptedArenaState(input, {
        isCurrent,
        roomId: input.roomIdRef.current,
        nowEpochMs: input.nowMs(),
        apply: (state) => applyPlayerHitAccepted(state, accepted)
    });
}

function acceptArenaPickup(input: ArenaStateAcceptanceInput, accepted: PickupAccepted, isCurrent: () => boolean): void {
    if (!isCurrent()) {
        return;
    }
    input.setPickupAcceptances((previous) =>
        isCurrent()
            ? [
                ...previous.filter((item) =>
                    item.revision !== accepted.revision || item.pickup.id !== accepted.pickup.id
                ).slice(-24),
                accepted
            ]
            : previous
    );
    projectAcceptedArenaState(input, {
        isCurrent,
        roomId: input.roomIdRef.current,
        nowEpochMs: input.nowMs(),
        apply: (state) => applyPickupAccepted(state, accepted)
    });
}

async function acceptArenaMatchStart(
    input: ArenaStateAcceptanceInput,
    intent: MatchStartIntent,
    isCurrent: () => boolean
): Promise<void> {
    const previous = input.arenaSnapshotRef.current;
    const roomId = input.roomIdRef.current;
    const match = input.arenaMatchRef.current;
    if (
        !isCurrent() || !previous || !roomId || !match ||
        (previous.roomId !== undefined && previous.roomId !== roomId)
    ) {
        return;
    }
    const isCurrentOwner = () =>
        isCurrent() && input.arenaMatchRef.current === match && input.roomIdRef.current === roomId;
    const nowEpochMs = input.nowMs();
    const result = startArenaMatch(hydrateArenaSnapshot(previous), intent, nowEpochMs);
    if (!result.accepted) {
        return;
    }
    const snapshot = toArenaSnapshot(result.state, previous.roomId ?? roomId, nowEpochMs);
    input.arenaSnapshotRef.current = snapshot;
    input.setArenaSnapshot((current) => isCurrentOwner() ? snapshot : current);
    publishAcceptedArenaEvents(input, snapshot, isCurrentOwner);
    await input.publishMatchLifecycleOutput(match, {
        protocol: GAME_PROTOCOL,
        kind: 'director-match-started',
        accepted: result.acceptedMatch
    });
    if (isCurrentOwner()) {
        await match.publishSnapshot(snapshot, { reliable: false });
    }
}

function projectAcceptedArenaState(input: ArenaStateAcceptanceInput, projection: ArenaAcceptedStateProjection): void {
    input.setArenaSnapshot((previous) => {
        if (
            !projection.isCurrent() || !previous ||
            (previous.roomId !== undefined && previous.roomId !== projection.roomId)
        ) {
            return previous;
        }
        const next = toArenaSnapshot(
            projection.apply(hydrateArenaSnapshot(previous)),
            previous.roomId ?? projection.roomId,
            projection.nowEpochMs
        );
        input.arenaSnapshotRef.current = next;
        publishAcceptedArenaEvents(input, next, projection.isCurrent);
        return next;
    });
}

function publishAcceptedArenaEvents(
    input: ArenaStateAcceptanceInput,
    snapshot: ArenaSnapshot,
    isCurrent: () => boolean
): void {
    input.setActiveEvent((previous) => isCurrent() ? snapshot.activeEvent : previous);
    input.setRemoteEvents((previous) => isCurrent() ? snapshot.events : previous);
}
