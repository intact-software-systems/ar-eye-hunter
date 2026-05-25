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
    byPrincipalId?: PrincipalId;
    bySessionId?: SessionId;
    byServiceId?: string;
    reason?: string;
    traceId?: string;
    requestId?: string;
}>;

export type ClientScope = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
}>;

export type ClientPrincipalRef = ClientScope & Readonly<{
    principalId: PrincipalId;
}>;

export type ClientInstanceRef = ClientPrincipalRef & Readonly<{
    clientInstanceId: ClientInstanceId;
}>;

export type ClientSessionRef = ClientInstanceRef & Readonly<{
    sessionId: SessionId;
}>;

export type ClientPrincipal = ClientPrincipalRef & Readonly<{
    username: string;
    displayName?: string;
    avatarUrl?: string;
    status: ClientPrincipalStatus;
    authProvider?: string;
    externalSubjectId?: string;
    roles: readonly string[];
    metadata: Record<string, unknown>;

    snapshotVersion: number;
    profileVersion: number;
    presenceVersion: number;

    created: AuditStamp;
    updated: AuditStamp;
    disabled?: AuditStamp;
    deleted?: AuditStamp;

    lastSeenAtEpochMs?: number;
}>;

export type ClientInstance = ClientInstanceRef & Readonly<{
    status: ClientInstanceStatus;
    platform: ClientPlatform;
    deviceLabel?: string;
    appVersion?: string;
    userAgent?: string;
    capabilities: readonly string[];

    registered: AuditStamp;
    updated: AuditStamp;
    revoked?: AuditStamp;
}>;

export type ClientSession = ClientSessionRef & Readonly<{
    status: ClientSessionStatus;
    presenceState: ClientPresenceState;
    transport: ClientTransport;
    connectionId?: string;

    authenticatedAtEpochMs: number;
    connectedAtEpochMs: number;
    lastHeartbeatAtEpochMs: number;
    expiresAtEpochMs: number;

    disconnectedAtEpochMs?: number;
    disconnectReason?: string;
}>;

export type ClientPresenceSnapshot = ClientPrincipalRef & Readonly<{
    presenceVersion: number;
    isOnline: boolean;
    presenceState: ClientPresenceState;
    activeSessions: readonly ClientSession[];
    lastSeenAtEpochMs?: number;
}>;

export type ClientSnapshot = Readonly<{
    principal: ClientPrincipal;
    instances: readonly ClientInstance[];
    activeSessions: readonly ClientSession[];

    isOnline: boolean;
    activeSessionCount: number;
    lastSeenAtEpochMs?: number;
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

export type ClientEvent = ClientPrincipalRef & Readonly<{
    eventId: string;
    eventType: ClientEventType;
    snapshotVersion: number;
    clientInstanceId?: ClientInstanceId;
    sessionId?: SessionId;
    occurredAtEpochMs: number;
    actor: {
        principalId?: PrincipalId;
        sessionId?: SessionId;
        serviceId?: string;
    };
    reason?: string;
    traceId?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
}>;
