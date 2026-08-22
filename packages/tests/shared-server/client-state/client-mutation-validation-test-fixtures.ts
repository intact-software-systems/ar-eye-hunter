import type {
    ClientMutationAuthority,
    ClientMutationCommand,
    ClientMutationFacts,
    ClientMutationOperation,
    ClientMutationRead
} from '@shared-server/rallar-system/services/client-state-mutations.ts';

export const CLIENT_MUTATION_TEST_SCOPE = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
} as const;
export function clientMutationPrincipalRef(principalId: string) {
    return { ...CLIENT_MUTATION_TEST_SCOPE, principalId };
}

export function invalidSessionCommand(
    base: Readonly<Record<string, unknown>>,
    actor: Readonly<Record<string, unknown>>,
    operation: string,
    override: Readonly<Record<string, unknown>>
): unknown {
    const common = {
        ...base,
        operation,
        authority: validAuthority(operation as ClientMutationOperation, 'session-1'),
        clientInstanceId: 'browser',
        sessionId: 'session-1'
    };
    const operationInput = operation === 'expireSession'
        ? {
            ...actor,
            generationId: 'generation-1',
            generationVersion: 1,
            observedExpiresAtEpochMs: 2_000,
            expiresAtEpochMs: 2_000
        }
        : operation.includes('connect')
        ? {
            ...actor,
            generationId: 'generation-1',
            presenceState: 'online',
            transport: 'ws',
            connectionId: 'generation-1',
            authenticatedAtEpochMs: 1_000,
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000,
            instancePlatform: 'web',
            instanceUserAgent: null,
            instanceCapabilities: [],
            principalUsername: null,
            principalDisplayName: null,
            principalRoles: null
        }
        : operation.includes('heartbeat')
        ? {
            ...actor,
            generationId: 'generation-1',
            presenceState: 'online',
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        }
        : {
            ...actor,
            generationId: 'generation-1',
            disconnectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 2_000
        };
    return { ...common, input: { ...operationInput, ...override } };
}
export function validPrincipalCommand(): ClientMutationCommand {
    return {
        operation: 'upsertPrincipal',
        aggregateRef: clientMutationPrincipalRef('alice'),
        commandId: 'valid-command',
        requestId: 'valid-command',
        authority: validAuthority('upsertPrincipal'),
        facts: validFacts(),
        input: {
            username: 'alice',
            displayName: 'Alice',
            avatarUrl: null,
            status: 'active',
            authProvider: null,
            externalSubjectId: null,
            roles: [],
            metadata: {},
            lastSeenAtEpochMs: 1_000,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null,
            traceId: null
        }
    };
}

export function validFacts(): ClientMutationFacts {
    return {
        nowEpochMs: 1_000,
        serviceId: 'client-service',
        eventId: 'event-1',
        commandHash: `sha256:${'a'.repeat(64)}`,
        attemptCount: 1,
        expireAtEpochMs: 10_000,
        formationDamping: 'damped'
    };
}

export function emptyClientMutationRead(sessionId = 'session-1'): ClientMutationRead {
    return {
        authoritySession: validAuthoritySession(sessionId),
        idempotency: null,
        principal: null,
        instance: null,
        session: null,
        expiredSessionEntry: null,
        snapshot: null,
        receiptEvent: null
    };
}

export function validAuthority(
    operation: ClientMutationOperation,
    sessionId = 'authority-session'
): ClientMutationAuthority {
    if (operation === 'expireSession') {
        return {
            kind: 'system',
            version: 1,
            serviceId: 'client-service',
            operation
        };
    }
    return {
        kind: 'issued-session',
        version: 1,
        principalId: 'alice',
        sessionId,
        sessionIssuedAtEpochMs: 0,
        sessionExpiresAtEpochMs: 10_000,
        applicationId: CLIENT_MUTATION_TEST_SCOPE.applicationId,
        workspaceId: CLIENT_MUTATION_TEST_SCOPE.workspaceId,
        operation
    };
}

export function validAuthoritySession(sessionId = 'authority-session') {
    return {
        clientId: 'alice',
        accessTokenDigest: `sha256:${sessionId}-token`,
        username: 'alice',
        sessionId,
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 10_000
    } as const;
}

export function validPrincipalValue() {
    const audit = {
        atEpochMs: 1_000,
        byPrincipalId: 'alice',
        byServiceId: 'client-service'
    };
    return {
        ...clientMutationPrincipalRef('alice'),
        username: 'alice',
        status: 'active' as const,
        roles: [],
        metadata: {},
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit,
        updated: audit
    };
}
