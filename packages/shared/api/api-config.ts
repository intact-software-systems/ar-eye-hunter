import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { ApiJsonObject } from './api-json-value.ts';

export interface ApiConfig {
    readonly apiBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly endpoints: {
        readonly createWs: string;
    };
}

export interface AuthSession {
    readonly clientId: string;
    readonly accessToken: string;
    readonly username: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export const EnqueuedType = {
    WS_INBOX: 'WS_INBOX',
    WS_OUTBOX: 'WS_OUTBOX',
    RTC_INBOX: 'RTC_INBOX',
    RTC_OUTBOX: 'RTC_OUTBOX',
    APP_INBOX: 'APP_INBOX',
    APP_OUTBOX: 'APP_OUTBOX'
} as const;

export type EnqueuedType = (typeof EnqueuedType)[keyof typeof EnqueuedType];

export const AppTopics = {
    rtcSignaling: 'rtc-signaling',
    clientStateSnapshot: 'client-state.snapshot',
    clientStateEvent: 'client-state.event',
    groupStateSnapshot: 'group-state.snapshot',
    groupStateEvent: 'group-state.event',
    groupDirectorySnapshot: 'group-directory.snapshot',
    graphs: 'graphs',
    overlayTopology: 'overlay.topology',
    rtt: 'rtt'
} as const;

export type AppTopics = (typeof AppTopics)[keyof typeof AppTopics];

// TODO: Conflict free replicated data types, how to model?

export type PeerId = string;

export interface ClientInfo {
    readonly clientId: PeerId;
    readonly sessionId: string;
    readonly isOnline: boolean;
}

export interface IceConfig {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
}

export interface LoginRequest {
    readonly username: string;
    readonly password: string;
}

export interface RegisterRequest {
    readonly username: string;
    readonly password: string;
    readonly displayName?: string;
}

export interface LoginResponse {
    readonly clientId: PeerId;
    readonly accessToken: string;
    readonly username: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export interface RegisterResponse {
    readonly clientId: PeerId;
    readonly username: string;
    readonly displayName: string | null;
    readonly registeredAtEpochMs: number;
}

export interface LogoutResponse {
    readonly loggedOut: boolean;
}

export interface WebSocketTicketResponse extends ApiJsonObject {
    readonly ticket: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export interface AgentSessionTicketRequest {
    readonly agentIds: readonly string[];
}

export interface AgentSessionTicket {
    readonly agentId: string;
    readonly ticket: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export interface AgentSessionTicketResponse {
    readonly tickets: readonly AgentSessionTicket[];
}

export interface ConsumeAgentSessionTicketRequest {
    readonly ticket: string;
}

export type GroupId = string;

export type OverlayId = string;

/**
 * Where an overlay record came from. Server overlays are authoritative and
 * always supersede bootstrap overlays; a bootstrap overlay never replaces a
 * server overlay (group-formation Phase 1 admission rule).
 */
export type OverlayProvenance = 'server' | 'bootstrap';

export interface OverlayInfo {
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly provenance: OverlayProvenance;
    readonly state: 'active' | 'removed';
    readonly overlayId: OverlayId;
    readonly groupRef: GroupRef;
    readonly topology: 'star' | 'tree' | 'mesh';
    readonly name: string;
    readonly createdByClientId: string;
    readonly createdAtEpochMs: number;
    readonly nextHopSessionIds: readonly string[];
    readonly degreeLimit: number;
    readonly overlayVersion: number;
    readonly updatedAtEpochMs: number;
}

export interface RttMeasurementInfo {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
    readonly rttMs: number;
    readonly createdAtEpochMs: number;
    readonly version: number;
}
