import { GroupRef } from '@shared/api/group-types.ts';

export type ApiConfig = {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
};

export type AuthSession = {
    readonly clientId: string;
    readonly accessToken: string;
    readonly username: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
};

export enum EnqueuedType {
    WS_INBOX = 'WS_INBOX',
    WS_OUTBOX = 'WS_OUTBOX',
    RTC_INBOX = 'RTC_INBOX',
    RTC_OUTBOX = 'RTC_OUTBOX',
    APP_INBOX = 'APP_INBOX',
    APP_OUTBOX = 'APP_OUTBOX'
}

export enum AppTopics {
    chat = 'chat',
    rtcSignaling = 'rtc-signaling',
    clientStateSnapshot = 'client-state.snapshot',
    clientStateEvent = 'client-state.event',
    groupStateSnapshot = 'group-state.snapshot',
    groupStateEvent = 'group-state.event',
    groupDirectorySnapshot = 'group-directory.snapshot',
    graphs = 'graphs',
    overlayTopology = 'overlay.topology',
    rtt = 'rtt',
}

// TODO: Conflict free replicated data types, how to model?

export type PeerId = string;

export type ClientInfo = {
    readonly clientId: PeerId;
    readonly sessionId: string;
    readonly isOnline: boolean;
};

export type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};

export type LoginRequest = {
    username: string;
    password: string;
};

export type RegisterRequest = {
    username: string;
    password: string;
    displayName?: string;
};

export type LoginResponse = {
    clientId: PeerId;
    accessToken: string;
    username: string;
    sessionId: string;
    expiresAtEpochMs: number;
};

export type RegisterResponse = {
    clientId: PeerId;
    username: string;
    displayName?: string;
    registeredAtEpochMs: number;
};

export type LogoutResponse = {
    loggedOut: boolean;
};

export type WebSocketTicketResponse = {
    ticket: string;
    sessionId: string;
    expiresAtEpochMs: number;
};

export type AgentSessionTicketRequest = {
    readonly agentIds: readonly string[];
};

export type AgentSessionTicket = {
    readonly agentId: string;
    readonly ticket: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
};

export type AgentSessionTicketResponse = {
    readonly tickets: readonly AgentSessionTicket[];
};

export type ConsumeAgentSessionTicketRequest = {
    readonly ticket: string;
};

export type ConsumeAgentSessionTicketResponse = AuthSession;

export type GroupId = string;

export type OverlayId = string;

export type OverlayInfo = {
    readonly overlayId: OverlayId;
    readonly groupRef?: GroupRef;
    readonly topology?: 'star' | 'tree' | 'mesh';
    readonly name: string;
    readonly createdByClientId: string;
    readonly createdAtEpochMs: number;
    readonly nextHopSessionIds: readonly string[];
    readonly degreeLimit?: number;
    readonly overlayVersion: number;
    readonly updatedAtEpochMs: number;
};

export type RttMeasurementInfo = {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
    readonly rttMs: number;
    readonly createdAtEpochMs: number;
    readonly version: number;
};
