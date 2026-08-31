import type { RallarApiClientConfig } from '@shared-web/browser/api-client-config.ts';
import type { RallarPeopleState } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type {
    RallarOperationOptions,
    RallarOperationRetryPredicate
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    ApplicationId,
    GroupRef,
    WorkspaceId
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type { CommandsOrchestrator, CommandsOrchestratorPolicies } from '@shared/cache/CommandsOrchestrator.ts';
import type { WebRtcOverlayMulticastManager } from '@shared/multicast/WebRtcOverlayMulticastManager.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import type { WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import type { RtcDataChannelLaneConfig, WebRtcConnectionService } from '@shared/services/WebRtcConnectionService.ts';
import type { WsQueueBoxClientService } from '@shared/services/WsQueueBoxClientService.ts';

/** Controls the single active heartbeat for a connected browser session. */
export interface RallarSessionHeartbeat {
    readonly sessionId: string;
    readonly generationId: string;
    stop(): void;
}

/** Connected browser transport resources exposed through the advanced facade. */
export interface RallarBrowserMiddleware {
    readonly qboxEngine: InboxOutboxEngine;
    readonly webSocketQueueBox: WsQueueBoxClientService;
    readonly webRtcConnectionService: WebRtcConnectionService;
    readonly rtcRxStreamer: WebRtcRxStreamerService;
    readonly webRtcGroupManager: WebRtcGroupManager;
    readonly webRtcOverlayMulticastManager: WebRtcOverlayMulticastManager;
    readonly heartbeat: RallarSessionHeartbeat;
}

/** Authenticated browser connection returned by setup and connect operations. */
export interface ApiMiddleware {
    readonly session: AuthSession;
    readonly authFetch: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>;
    readonly middleware: RallarBrowserMiddleware;
}

export type RallarConnectStatus = 'idle' | 'connecting' | 'connected';

interface RallarRoomDefaults {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

interface RallarRealtimeDefaults {
    readonly laneId?: string;
    readonly openTimeoutMs?: number;
}

interface RallarRtcDefaults {
    readonly waitTimeoutMs?: number;
    readonly connectOnWait?: boolean;
    readonly dataChannelLanes?: readonly RtcDataChannelLaneConfig[];
    readonly maxPeerConnections?: number;
    readonly rttReportingDegreeLimit?: number;
    readonly bootstrapDegree?: number;
}

interface RallarMessageDefaults {
    readonly maxPayloadBytes?: number;
}

interface RallarOperationDefaults {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly shouldRetry?: RallarOperationRetryPredicate;
}

export interface RallarDefaults {
    readonly applicationId: ApplicationId;
    readonly workspaceId?: WorkspaceId;
    readonly room?: RallarRoomDefaults;
    readonly realtime?: RallarRealtimeDefaults;
    readonly rtc?: RallarRtcDefaults;
    readonly messages?: RallarMessageDefaults;
    readonly operations?: RallarOperationDefaults;
}

export interface RallarScopedOperationOptions extends RallarOperationOptions {
    readonly scope?: StateScope;
}

export interface RallarStartOptions extends RallarScopedOperationOptions {
    readonly restoreSession?: boolean;
    readonly connect?: boolean;
    readonly refreshRooms?: boolean;
    readonly refreshPeople?: boolean;
}

export interface RallarStartResult {
    readonly session?: AuthSession;
    readonly connected: boolean;
    readonly middleware?: ApiMiddleware;
    readonly roomState?: RallarRoomState;
    readonly peopleState?: RallarPeopleState;
}

export interface RallarSetupInput extends RallarApiClientConfig, RallarDefaults {
    readonly start?: RallarStartOptions;
}

export interface RallarConnectionOperations {
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
}

export interface RallarConnectionFacade extends RallarConnectionOperations {
    start(options?: RallarStartOptions): Promise<RallarStartResult>;
}
