import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarDirectorStatus, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';

import type { AvatarProfile } from '../../avatarProfile.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaPresenceNotice } from '../../squadLink.ts';
import type {
    ArenaMatchDurationMs,
    ArenaSnapshot,
    MatchStartIntent,
    PickupAccepted,
    PickupIntent,
    PlayerHitAccepted,
    PlayerHitIntent,
    PlayerPose,
    PlayerShot,
    RtcLaneStatus,
    ShotAccepted,
} from '../../types.ts';
import type {
    ArenaConnection,
    ArenaConnectionState,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics,
    DirectorAttemptSource,
    DirectorAttemptState,
} from '../arena-connection-contracts.ts';
import { useArenaDiagnosticActions } from './use-arena-diagnostic-actions.ts';
import { useArenaGameActions } from '../game-actions/use-arena-game-actions.ts';
import { useArenaSessionActions } from './use-arena-session-actions.ts';

export interface ArenaActionsInput {
    readonly acceptMatchStartIntent: (intent: MatchStartIntent) => Promise<void>;
    readonly acceptPickup: (accepted: PickupAccepted) => void;
    readonly acceptPlayerHit: (accepted: PlayerHitAccepted) => void;
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>;
    readonly clearRoomScopedArenaState: () => void;
    readonly connect: () => Promise<void>;
    readonly connectionState: ArenaConnectionState;
    readonly currentNetworkSignal: () => AbortSignal;
    readonly diagnosticsRefreshRef: RefObject<Promise<void> | undefined>;
    readonly directorAttemptRef: RefObject<DirectorAttemptState>;
    readonly directorStatusRef: RefObject<RallarDirectorStatus>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly isNetworkEnabled: () => boolean;
    readonly localAvatarProfileRef: RefObject<AvatarProfile | undefined>;
    readonly networkGenerationRef: RefObject<number>;
    readonly poseSendBudget: RefObject<number>;
    readonly resetForSignedOutAuth: () => void;
    readonly roomId: string | undefined;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly rooms: readonly RallarRoomSummary[];
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number,
    ) => void;
    readonly scheduleReliableArenaSnapshot: (
        snapshot: ArenaSnapshot,
        generation: number,
    ) => void;
    readonly sessionRef: RefObject<AuthSession | undefined>;
    readonly setArenaSnapshot: Dispatch<SetStateAction<ArenaSnapshot | undefined>>;
    readonly setConnectionState: Dispatch<SetStateAction<ArenaConnectionState>>;
    readonly setError: Dispatch<SetStateAction<string | undefined>>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
    readonly setHttpDiagnostics: Dispatch<SetStateAction<ArenaHttpDiagnostics>>;
    readonly setPresenceNotices: Dispatch<SetStateAction<readonly ArenaPresenceNotice[]>>;
    readonly setRoomId: Dispatch<SetStateAction<string | undefined>>;
    readonly setRooms: Dispatch<SetStateAction<readonly RallarRoomSummary[]>>;
    readonly setRtcLanes: Dispatch<SetStateAction<readonly RtcLaneStatus[]>>;
    readonly setSession: Dispatch<SetStateAction<AuthSession | undefined>>;
    readonly setTransportDiagnostics: Dispatch<SetStateAction<ArenaTransportDiagnostics>>;
    readonly transportDiagnosticsRef: RefObject<ArenaTransportDiagnostics>;
}

export type ArenaActions = Pick<
    ArenaConnection,
    | 'login'
    | 'register'
    | 'logout'
    | 'refreshRooms'
    | 'createArenaRoom'
    | 'joinRoom'
    | 'appointSelfAsDirector'
    | 'refreshDiagnostics'
    | 'requestArenaSync'
    | 'dismissPresenceNotice'
    | 'sendPose'
    | 'sendShot'
    | 'sendPlayerHit'
    | 'sendPickupIntent'
    | 'startArenaMatch'
    | 'publishArenaSnapshot'
>;

export function useArenaActions(input: ArenaActionsInput): ArenaActions {
    return {
        ...useArenaSessionActions(input),
        ...useArenaDiagnosticActions(input),
        ...useArenaGameActions(input),
    };
}
