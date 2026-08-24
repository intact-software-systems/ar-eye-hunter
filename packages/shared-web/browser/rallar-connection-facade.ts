import type { RallarApiClientConfig } from '@shared-web/browser/api-client-config.ts';
import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type {
    RallarOperationOptions,
    RallarOperationRetryPredicate
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarPeopleState } from '@shared-web/browser/rallar-people-contracts.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApplicationId, GroupRef, WorkspaceId } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestrator, CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import type { RtcDataChannelLaneConfig } from '@shared/services/WebRtcConnectionService.ts';

export type RallarConnectStatus = 'idle' | 'connecting' | 'connected';

export type RallarDefaults = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
    room?: Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }>;
    realtime?: Readonly<{
        laneId?: string;
        openTimeoutMs?: number;
    }>;
    rtc?: Readonly<{
        waitTimeoutMs?: number;
        connectOnWait?: boolean;
        dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
        maxPeerConnections?: number;
        rttReportingDegreeLimit?: number;
        bootstrapDegree?: number;
    }>;
    messages?: Readonly<{
        maxPayloadBytes?: number;
    }>;
    operations?: Readonly<{
        timeoutMs?: number;
        maxAttempts?: number;
        shouldRetry?: RallarOperationRetryPredicate;
    }>;
}>;

export type RallarScopedOperationOptions =
    & RallarOperationOptions
    & Readonly<{
        scope?: StateScope;
    }>;

export type RallarStartOptions =
    & RallarScopedOperationOptions
    & Readonly<{
        restoreSession?: boolean;
        connect?: boolean;
        refreshRooms?: boolean;
        refreshPeople?: boolean;
    }>;

export type RallarStartResult = Readonly<{
    session?: AuthSession;
    connected: boolean;
    middleware?: ApiMiddleware;
    roomState?: RallarRoomState;
    peopleState?: RallarPeopleState;
}>;

export type RallarSetupInput =
    & RallarApiClientConfig
    & RallarDefaults
    & Readonly<{
        start?: RallarStartOptions;
    }>;

export type RallarConnectionOperations = Readonly<{
    configure(config: RallarApiClientConfig): void;
    setDefaults(defaults?: RallarDefaults): void;
    defaults(): RallarDefaults | undefined;
    connect(options?: RallarScopedOperationOptions): Promise<ApiMiddleware>;
    disconnect(): Promise<void>;
    status(): RallarConnectStatus;
    isConnected(): boolean;
    session(): AuthSession | undefined;
    subscriptions(): RallarSubscriptionScope;
    flow<K, V>(policies?: CommandsOrchestratorPolicies<V>): CommandsOrchestrator<K, V>;
}>;

export type RallarConnectionFacade =
    & RallarConnectionOperations
    & Readonly<{
        start(options?: RallarStartOptions): Promise<RallarStartResult>;
    }>;
