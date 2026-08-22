import type { MutationActor } from './mutation-actor.ts';

export type ApplicationId = string;
export type WorkspaceId = string;
export type PrincipalId = string;
export type ClientInstanceId = string;
export type SessionId = string;
export type ActorId = string;

export type ClientPrincipalStatus =
    | 'active'
    | 'disabled'
    | 'deleted';

export type ClientInstanceStatus =
    | 'active'
    | 'revoked'
    | 'retired';

export type ClientSessionStatus =
    | 'active'
    | 'disconnected'
    | 'expired';

export type ClientPresenceState =
    | 'online'
    | 'offline'
    | 'away'
    | 'busy';

export type ClientPlatform =
    | 'web'
    | 'ios'
    | 'android'
    | 'desktop'
    | 'server'
    | 'unknown';

export type ClientTransport =
    | 'ws'
    | 'http'
    | 'rtc'
    | 'unknown';

export type AuditStamp = Readonly<{
    atEpochMs: number;
    actor: MutationActor;
    reason: string | null;
    traceId: string | null;
    requestId: string | null;
}>;

export type ClientScope = Readonly<{
    applicationId: ApplicationId;
    workspaceId: WorkspaceId;
}>;

export type ClientPrincipalRef =
    & ClientScope
    & Readonly<{
        principalId: PrincipalId;
    }>;

export type ClientInstanceRef =
    & ClientPrincipalRef
    & Readonly<{
        clientInstanceId: ClientInstanceId;
    }>;

export type ClientSessionRef =
    & ClientInstanceRef
    & Readonly<{
        sessionId: SessionId;
    }>;

type ClientPrincipalBase =
    & ClientPrincipalRef
    & Readonly<{
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
        authProvider: string | null;
        externalSubjectId: string | null;
        roles: readonly string[];
        metadata: Record<string, unknown>;

        snapshotVersion: number;
        profileVersion: number;
        presenceVersion: number;

        created: AuditStamp;
        updated: AuditStamp;
        lastSeenAtEpochMs: number | null;
    }>;

export type ClientPrincipal =
    & ClientPrincipalBase
    & (
        | Readonly<{
            status: 'active';
            disabled: null;
            deleted: null;
        }>
        | Readonly<{
            status: 'disabled';
            disabled: AuditStamp;
            deleted: null;
        }>
        | Readonly<{
            status: 'deleted';
            disabled: AuditStamp | null;
            deleted: AuditStamp;
        }>
    );

type ClientInstanceBase =
    & ClientInstanceRef
    & Readonly<{
        platform: ClientPlatform;
        deviceLabel: string | null;
        appVersion: string | null;
        userAgent: string | null;
        capabilities: readonly string[];

        registered: AuditStamp;
        updated: AuditStamp;
    }>;

export type ClientInstance =
    & ClientInstanceBase
    & (
        | Readonly<{ status: 'active'; revoked: null; }>
        | Readonly<{ status: 'revoked' | 'retired'; revoked: AuditStamp; }>
    );

type ClientSessionBase =
    & ClientSessionRef
    & Readonly<{
        generationId: string;
        generationVersion: number;
        presenceState: ClientPresenceState;
        transport: ClientTransport;
        connectionId: string | null;

        authenticatedAtEpochMs: number;
        connectedAtEpochMs: number;
        lastHeartbeatAtEpochMs: number;
        expiresAtEpochMs: number;
    }>;

export type ClientSession =
    & ClientSessionBase
    & (
        | Readonly<{
            status: 'active';
            disconnectedAtEpochMs: null;
            disconnectReason: null;
        }>
        | Readonly<{
            status: 'disconnected' | 'expired';
            disconnectedAtEpochMs: number;
            disconnectReason: string;
        }>
    );

export type ClientPresenceSnapshot =
    & ClientPrincipalRef
    & Readonly<{
        presenceVersion: number;
        isOnline: boolean;
        presenceState: ClientPresenceState;
        activeSessions: readonly ClientSession[];
        lastSeenAtEpochMs: number | null;
    }>;

export type ClientSnapshot = Readonly<{
    stateRevision: number;
    principal: ClientPrincipal;
    instances: readonly ClientInstance[];
    activeSessions: readonly ClientSession[];

    isOnline: boolean;
    activeSessionCount: number;
    lastSeenAtEpochMs: number | null;
}>;

export type ClientEventType =
    | 'principal-created'
    | 'principal-updated'
    | 'principal-disabled'
    | 'principal-deleted'
    | 'instance-registered'
    | 'instance-updated'
    | 'instance-revoked'
    | 'session-authenticated'
    | 'session-connected'
    | 'session-heartbeat'
    | 'session-disconnected'
    | 'session-expired';

export type ClientEvent =
    & ClientPrincipalRef
    & Readonly<{
        eventId: string;
        eventType: ClientEventType;
        snapshotVersion: number;
        clientInstanceId: ClientInstanceId | null;
        sessionId: SessionId | null;
        occurredAtEpochMs: number;
        actor: MutationActor;
        reason: string | null;
        traceId: string | null;
        requestId: string | null;
        payload: Record<string, unknown>;
    }>;
