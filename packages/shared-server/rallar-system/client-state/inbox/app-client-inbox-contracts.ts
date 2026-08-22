import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest
} from '@shared/api/state-types.ts';
import type { IssuedAuthSession } from '../../repositories/AuthSessionRepository.ts';
import { AppInboxType } from '../../services/AppInboxService.ts';
import type { RegisterAuthorisedWsClientInput } from '../client-state-service-contracts.ts';

export type ClientPrincipalUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    request: UpsertClientPrincipalRequest;
}>;

export type ClientInstanceUpsertAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    request: UpsertClientInstanceRequest;
}>;

export type ClientSessionConnectAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: ConnectClientSessionRequest;
}>;

export type ClientSessionHeartbeatAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: HeartbeatClientSessionRequest;
}>;

export type ClientSessionDisconnectAppInboxPayload = Readonly<{
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    sessionId: string;
    request: DisconnectClientSessionRequest;
}>;

export type ClientAuthorisedWsSessionConnectAppInboxPayload = Readonly<{
    authSession: Omit<IssuedAuthSession, 'accessToken'>;
    generationId: string;
    generationStartedAtEpochMs: number;
    scope: StateScope;
    principalId: string;
    clientInstanceId: string;
    displayName: string;
    userAgent: string | null;
    platform: NonNullable<RegisterAuthorisedWsClientInput['platform']>;
    capabilities: readonly string[];
    expiresAtEpochMs: number;
}>;

export type ClientAuthorisedWsSessionDisconnectAppInboxPayload = Readonly<{
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    disconnectedAtEpochMs: number;
    reason: string;
}>;

export type ClientExpiredSessionsAppInboxPayload = Readonly<{ atEpochMs: number; }>;

export const CLIENT_STATE_INBOX_REGISTRATION_TYPES = [
    AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    AppInboxType.CLIENT_INSTANCE_UPSERT,
    AppInboxType.CLIENT_SESSION_CONNECT,
    AppInboxType.CLIENT_SESSION_HEARTBEAT,
    AppInboxType.CLIENT_SESSION_DISCONNECT,
    AppInboxType.CLIENT_AUTHORISED_WS_CONNECT,
    AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT,
    AppInboxType.CLIENT_EXPIRED_SESSIONS
] as const;
