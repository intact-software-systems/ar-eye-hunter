import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import {
    applyEyeAttackAccepted,
    applyPickupAccepted,
    applyPlayerHitAccepted,
    hydrateArenaSnapshot,
    startArenaMatch as startArenaMatchState,
    toArenaSnapshot,
} from '../../simulation.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import {
    type ArenaEvent,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    GAME_PROTOCOL,
    type MatchStartIntent,
    type PickupAccepted,
    type PlayerHitAccepted,
} from '../../types.ts';

interface ArenaStateAcceptanceInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setPickupAcceptances: Dispatch<SetStateAction<readonly PickupAccepted[]>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
    readonly setRemotePlayerHits: Dispatch<SetStateAction<readonly PlayerHitAccepted[]>>;
}

export interface ArenaStateAcceptance {
    readonly acceptPlayerHit: (accepted: PlayerHitAccepted) => void;
    readonly acceptPickup: (accepted: PickupAccepted) => void;
    readonly acceptEyeAttack: (accepted: EyeAttackAccepted) => void;
    readonly acceptMatchStartIntent: (intent: MatchStartIntent) => Promise<void>;
}

export function useArenaStateAcceptance(
    input: ArenaStateAcceptanceInput,
): ArenaStateAcceptance {
    const {
        arenaMatchRef,
        arenaSnapshotRef,
        roomIdRef,
        setActiveEvent,
        setArenaSnapshot,
        setPickupAcceptances,
        setRemoteEvents,
        setRemotePlayerHits,
    } = input;

    const acceptPlayerHit = useCallback((accepted: PlayerHitAccepted) => {
        setRemotePlayerHits((previous) => [
            ...previous.filter((item) =>
                item.revision !== accepted.revision ||
                item.target.sessionId !== accepted.target.sessionId ||
                item.intent.shot.seq !== accepted.intent.shot.seq
            ).slice(-24),
            accepted,
        ]);
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyPlayerHitAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptPickup = useCallback((accepted: PickupAccepted) => {
        setPickupAcceptances((previous) => [
            ...previous.filter((item) =>
                item.revision !== accepted.revision ||
                item.pickup.id !== accepted.pickup.id
            ).slice(-24),
            accepted,
        ]);
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyPickupAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptEyeAttack = useCallback((accepted: EyeAttackAccepted) => {
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyEyeAttackAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptMatchStartIntent = useCallback(async (intent: MatchStartIntent) => {
        const previous = arenaSnapshotRef.current;
        const currentRoomId = roomIdRef.current;
        if (!previous || !currentRoomId) {
            return;
        }
        const result = startArenaMatchState(
            hydrateArenaSnapshot(previous),
            intent,
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
        setActiveEvent(snapshot.activeEvent);
        setRemoteEvents(snapshot.events);
        await arenaMatchRef.current?.publishEvent({
            protocol: GAME_PROTOCOL,
            kind: 'director-match-started',
            accepted: result.acceptedMatch,
        });
        await arenaMatchRef.current?.publishSnapshot(snapshot, {
            reliable: false,
        });
    }, []);

    return {
        acceptPlayerHit,
        acceptPickup,
        acceptEyeAttack,
        acceptMatchStartIntent,
    };
}
