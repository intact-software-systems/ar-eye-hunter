export type BlackBoxRallarSessionIdentity = Readonly<{
    clientId: string;
    sessionId: string;
    username: string;
}>;

export type BlackBoxRallarAuthenticationIdentity = Readonly<{
    apiBaseUrl: string;
    username: string;
}>;

export type BlackBoxRallarConnectionTarget = Readonly<{
    apiBaseUrl: string;
    username: string;
    applicationId?: string;
    workspaceId?: string;
    roomId?: string;
    roomRef?: Readonly<{
        applicationId: string;
        workspaceId?: string;
        groupId: string;
    }>;
}>;

type AuthenticationConfig = Readonly<{
    apiBaseUrl: string;
    username?: string;
}>;

type ConnectionConfig = Readonly<{
    roomId?: string;
    roomRef?: BlackBoxRallarConnectionTarget['roomRef'];
    rallar: AuthenticationConfig &
        Readonly<{
            applicationId?: string;
            workspaceId?: string;
            roomRef?: BlackBoxRallarConnectionTarget['roomRef'];
        }>;
}>;

export type BlackBoxRallarLifecyclePolicyState = Readonly<{
    status: 'idle' | 'authenticating' | 'authenticated' | 'connecting' | 'connected' | 'closing' | 'faulted';
    activeTarget?: BlackBoxRallarConnectionTarget;
}>;

export type BlackBoxRallarLifecycleRequest = Readonly<{
    kind: 'authenticate' | 'connect';
    target: BlackBoxRallarConnectionTarget;
}>;

export type BlackBoxRallarLifecycleDecision =
    | Readonly<{ kind: 'allow' }>
    | Readonly<{ kind: 'reuse' }>
    | Readonly<{ kind: 'reject'; reason: string }>;

export function normalizeBlackBoxRallarApiBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

export function blackBoxRallarAuthenticationIdentityOf(
    config: AuthenticationConfig,
    restoredSession?: Pick<BlackBoxRallarSessionIdentity, 'username'>,
): BlackBoxRallarAuthenticationIdentity {
    return {
        apiBaseUrl: normalizeBlackBoxRallarApiBaseUrl(config.apiBaseUrl),
        username: config.username ?? restoredSession?.username ?? '',
    };
}

export function blackBoxRallarConnectionTargetOf(
    config: ConnectionConfig,
    restoredSession?: Pick<BlackBoxRallarSessionIdentity, 'username'>,
): BlackBoxRallarConnectionTarget {
    const identity = blackBoxRallarAuthenticationIdentityOf(config.rallar, restoredSession);
    const roomRef = config.roomRef ?? config.rallar.roomRef;
    return {
        ...identity,
        ...(config.rallar.applicationId ? { applicationId: config.rallar.applicationId } : {}),
        ...(config.rallar.workspaceId ? { workspaceId: config.rallar.workspaceId } : {}),
        ...(config.roomId ? { roomId: config.roomId } : {}),
        ...(roomRef ? { roomRef } : {}),
    };
}

export function isSameBlackBoxRallarSession(
    left: BlackBoxRallarSessionIdentity,
    right: BlackBoxRallarSessionIdentity,
): boolean {
    return left.clientId === right.clientId && left.sessionId === right.sessionId && left.username === right.username;
}

function isSameConnectionTarget(
    left: BlackBoxRallarConnectionTarget | undefined,
    right: BlackBoxRallarConnectionTarget,
): boolean {
    if (!left) {
        return false;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

export function decideBlackBoxRallarLifecycleRequest(
    state: BlackBoxRallarLifecyclePolicyState,
    request: BlackBoxRallarLifecycleRequest,
): BlackBoxRallarLifecycleDecision {
    if (state.status === 'closing' || state.status === 'faulted') {
        return {
            kind: 'reject',
            reason: 'Rallar lifecycle cleanup must complete before starting a new operation.',
        };
    }
    if (
        (state.status === 'authenticating' || state.status === 'connecting') &&
        isSameConnectionTarget(state.activeTarget, request.target)
    ) {
        return { kind: 'reuse' };
    }
    if (state.status === 'connected' && !isSameConnectionTarget(state.activeTarget, request.target)) {
        return {
            kind: 'reject',
            reason: 'Connected Rallar identity, scope, or room changes require close first.',
        };
    }
    return { kind: 'allow' };
}
