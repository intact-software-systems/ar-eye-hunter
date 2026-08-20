import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    GameRealtimeMessage,
    MatchStartIntent,
    PickupAccepted,
    PlayerHitAccepted,
    RemotePlayer,
    RtcLaneStatus,
} from '../../types.ts';
import type {
    ArenaAiStatus,
    ArenaConnectionState,
    DirectorAttemptSource,
    DirectorAttemptState,
} from '../arena-connection-contracts.ts';
import { useArenaAiDirectorLifecycle } from '../ai/use-arena-ai-director-lifecycle.ts';
import { useArenaMatchLifecycle } from './use-arena-match-lifecycle.ts';
import { useArenaTransportLifecycle } from './use-arena-transport-lifecycle.ts';

export interface ArenaConnectionLifecycleInput {
    readonly acceptDirectorOutput: (message: GameRealtimeMessage) => void;
    readonly acceptMatchStartIntent: (intent: MatchStartIntent) => Promise<void>;
    readonly acceptMotionMessage: (senderId: string, message: GameRealtimeMessage) => void;
    readonly acceptPickup: (accepted: PickupAccepted) => void;
    readonly acceptPlayerHit: (accepted: PlayerHitAccepted) => void;
    readonly acceptRealtimeMessage: (senderId: string, message: GameRealtimeMessage) => void;
    readonly activeMatchRoomIdRef: RefObject<string | undefined>;
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly bumpNetworkGeneration: () => number;
    readonly connectionState: ArenaConnectionState;
    readonly currentNetworkSignal: () => AbortSignal;
    readonly directorStatus: RallarDirectorStatus;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly isNetworkEnabled: () => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomId: string | undefined;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly rtcLanes: readonly RtcLaneStatus[];
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number,
    ) => void;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setAiError: Dispatch<SetStateAction<string | undefined>>;
    readonly setAiStatus: Dispatch<SetStateAction<ArenaAiStatus>>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setDirectorAttempt: Dispatch<SetStateAction<DirectorAttemptState>>;
    readonly setDirectorStatus: Dispatch<SetStateAction<RallarDirectorStatus>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
    readonly setRemotePlayers: Dispatch<SetStateAction<ReadonlyMap<string, RemotePlayer>>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
    readonly setRtcLanes: Dispatch<SetStateAction<readonly RtcLaneStatus[]>>;
    readonly setSession: Dispatch<SetStateAction<AuthSession | undefined>>;
    readonly snapshotLaneReadySyncKeyRef: RefObject<string | undefined>;
}

export interface ArenaConnectionLifecycle {
    readonly connect: () => Promise<void>;
    readonly attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>;
}

export function useArenaConnectionLifecycle(
    input: ArenaConnectionLifecycleInput,
): ArenaConnectionLifecycle {
    const { connect } = useArenaTransportLifecycle(input);
    const { attemptDirectorAppointment } = useArenaMatchLifecycle(input);
    useArenaAiDirectorLifecycle(input);
    return { connect, attemptDirectorAppointment };
}
