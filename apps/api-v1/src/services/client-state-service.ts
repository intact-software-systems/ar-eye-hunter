import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    ClientEvent,
    ClientInstance,
    ClientInstanceRef,
    ClientPlatform,
    ClientPresenceSnapshot,
    ClientPrincipal,
    ClientPrincipalRef,
    ClientScope,
    ClientSession,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    ConnectClientSessionRequest,
    DisconnectClientSessionRequest,
    HeartbeatClientSessionRequest,
    MutationActorInput,
    StateScope,
    UpsertClientInstanceRequest,
    UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, } from '@shared/api/state-types.ts';
import { myServerId } from '../config-repo.ts';
import { createAuthSessionRepository, createRuntimeStateRepository } from '../repository/createStateRepositories.ts';
import { ClientStateRepository } from '../repository/ClientStateRepository.ts';
import type { RuntimeStateTransactionalRepositoryLike, } from '../repository/RuntimeStateRepository.ts';
import { getWsStateSyncPublisher, type StateSyncPublisher } from './state-sync-service.ts';

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type RegisterAuthorisedWsClientInput = Readonly<{
    applicationId?: string;
    workspaceId?: string;
    principalId?: string;
    clientInstanceId?: string;
    displayName?: string;
    userAgent?: string;
    platform?: ClientPlatform;
    capabilities?: readonly string[];
    expiresAtEpochMs?: number;
}>;

export type ClientStateService = Readonly<{
    listSnapshots(scope: ClientScope): Promise<readonly ClientSnapshot[]>;
    readSnapshot(ref: ClientPrincipalRef): Promise<ClientSnapshot | undefined>;
    readPresenceSnapshot(
        ref: ClientPrincipalRef,
    ): Promise<ClientPresenceSnapshot | undefined>;
    listEvents(ref: ClientPrincipalRef): Promise<readonly ClientEvent[]>;
    upsertPrincipal(
        scope: StateScope,
        principalId: string,
        request: UpsertClientPrincipalRequest,
    ): Promise<ClientSnapshot>;
    upsertInstance(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        request: UpsertClientInstanceRequest,
    ): Promise<ClientSnapshot>;
    connectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: ConnectClientSessionRequest,
    ): Promise<ClientSnapshot>;
    heartbeatSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: HeartbeatClientSessionRequest,
    ): Promise<ClientSnapshot>;
    disconnectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: DisconnectClientSessionRequest,
    ): Promise<ClientSnapshot>;
    registerAuthorisedWsClientSession(
        authSession: AuthSession,
        input?: RegisterAuthorisedWsClientInput,
    ): Promise<ClientSnapshot>;
    disconnectAuthorisedWsClientSession(
        sessionId: string,
        reason?: string,
    ): Promise<ClientSnapshot>;
}>;

type ClientStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateTransactionalRepositoryLike;
    syncPublisher: StateSyncPublisher;
    now?: () => number;
    serviceId?: string;
}>;

export function createClientStateService(
    dependencies: ClientStateServiceDependencies,
): ClientStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const syncPublisher = dependencies.syncPublisher;
    const now = dependencies.now ?? (() => Date.now());
    const serviceId = dependencies.serviceId ?? myServerId;

    const service: ClientStateService = {
        listSnapshots: async (scope) => {
            const repository = new ClientStateRepository(runtimeRepository);
            const principals = await repository.listPrincipals(scope);
            const snapshots = await Promise.all(
                principals.map(async (principal) => await repository.readSnapshot(principal)),
            );

            return snapshots.filter(isDefined);
        },
        readSnapshot: async (ref) => {
            return await new ClientStateRepository(runtimeRepository).readSnapshot(
                ref,
            );
        },
        readPresenceSnapshot: async (ref) => {
            return await new ClientStateRepository(runtimeRepository)
                .readPresenceSnapshot(ref);
        },
        listEvents: async (ref) => {
            return await new ClientStateRepository(runtimeRepository).listEvents(ref);
        },
        upsertPrincipal: async (scope, principalId, request) => {
            const result = await runtimeRepository.begin(
                async (transactionRepository) => {
                    const repository = new ClientStateRepository(transactionRepository);
                    const existing = await repository.findPrincipal({
                        ...scope,
                        principalId,
                    });
                    const principal = toPrincipal(
                        scope,
                        principalId,
                        existing,
                        request,
                        now(),
                        serviceId,
                    );

                    if (existing && isSameClientPrincipalMutation(existing, principal)) {
                        return {
                            snapshot: await requireClientSnapshot(repository, existing),
                            event: undefined,
                        };
                    }

                    await repository.putPrincipal(principal);

                    const event = newClientEvent(
                        existing ? 'principal-updated' : 'principal-created',
                        principal,
                        request,
                        now(),
                        serviceId,
                    );

                    await repository.appendEvent(event);

                    return {
                        snapshot: await requireClientSnapshot(repository, principal),
                        event,
                    };
                },
            );

            if (result.event) {
                await publishClientMutation(
                    syncPublisher,
                    result.snapshot,
                    result.event,
                    serviceId,
                );
            }
            return result.snapshot;
        },
        upsertInstance: async (scope, principalId, clientInstanceId, request) => {
            const result = await runtimeRepository.begin(
                async (transactionRepository) => {
                    const repository = new ClientStateRepository(transactionRepository);
                    const existingPrincipal = await repository.findPrincipal({
                        ...scope,
                        principalId,
                    });
                    const principal = await ensurePrincipal(
                        repository,
                        scope,
                        principalId,
                        {
                            username: principalId,
                            displayName: principalId,
                            actorPrincipalId: request.actorPrincipalId ?? principalId,
                            actorSessionId: request.actorSessionId,
                            reason: request.reason,
                            traceId: request.traceId,
                            requestId: request.requestId,
                        },
                        now(),
                        serviceId,
                    );
                    const existing = await repository.findInstance({
                        ...scope,
                        principalId,
                        clientInstanceId,
                    });
                    const instance = toInstance(
                        principal,
                        clientInstanceId,
                        existing,
                        request,
                        now(),
                        serviceId,
                    );

                    if (existing && isSameClientInstanceMutation(existing, instance)) {
                        return {
                            snapshot: await requireClientSnapshot(repository, principal),
                            event: undefined,
                        };
                    }

                    await repository.putInstance(instance);
                    const snapshotPrincipal = existingPrincipal
                        ? bumpPrincipalProfile(principal, request, now(), serviceId)
                        : principal;
                    if (snapshotPrincipal !== principal) {
                        await repository.putPrincipal(snapshotPrincipal);
                    }

                    const event = newClientEvent(
                        request.status === 'revoked'
                            ? 'instance-revoked'
                            : existing
                                ? 'instance-updated'
                                : 'instance-registered',
                        snapshotPrincipal,
                        request,
                        now(),
                        serviceId,
                        instance.clientInstanceId,
                    );

                    await repository.appendEvent(event);

                    return {
                        snapshot: await requireClientSnapshot(repository, snapshotPrincipal),
                        event,
                    };
                },
            );

            if (result.event) {
                await publishClientMutation(
                    syncPublisher,
                    result.snapshot,
                    result.event,
                    serviceId,
                );
            }
            return result.snapshot;
        },
        connectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            const result = await runtimeRepository.begin(
                async (transactionRepository) => {
                    const repository = new ClientStateRepository(transactionRepository);
                    const principal = await ensurePrincipal(
                        repository,
                        scope,
                        principalId,
                        {
                            username: principalId,
                            displayName: principalId,
                            actorPrincipalId: request.actorPrincipalId ?? principalId,
                            actorSessionId: request.actorSessionId ?? sessionId,
                            reason: request.reason,
                            traceId: request.traceId,
                            requestId: request.requestId,
                        },
                        now(),
                        serviceId,
                    );

                    await ensureInstance(
                        repository,
                        principal,
                        clientInstanceId,
                        {
                            platform: 'unknown',
                            userAgent: undefined,
                            capabilities: request.transport ? [request.transport] : [],
                            actorPrincipalId: request.actorPrincipalId ?? principalId,
                            actorSessionId: request.actorSessionId ?? sessionId,
                            reason: request.reason,
                            traceId: request.traceId,
                            requestId: request.requestId,
                        },
                        now(),
                        serviceId,
                    );

                    const existing = await repository.findSession({
                        ...scope,
                        principalId,
                        clientInstanceId,
                        sessionId,
                    });
                    const session = toActiveSession(
                        principal,
                        clientInstanceId,
                        sessionId,
                        existing,
                        request,
                        now(),
                    );

                    await repository.putSession(session);

                    let event: ClientEvent | undefined;
                    let snapshotPrincipal = principal;
                    if (existing && isSameActiveClientSession(existing, session)) {
                        const nextPrincipal = rememberPrincipalLastSeen(
                            principal,
                            session.lastHeartbeatAtEpochMs,
                        );
                        if (nextPrincipal !== principal) {
                            await repository.putPrincipal(nextPrincipal);
                            snapshotPrincipal = nextPrincipal;
                        }
                    } else {
                        snapshotPrincipal = bumpPrincipalPresence(
                            principal,
                            session.lastHeartbeatAtEpochMs,
                            request,
                            now(),
                            serviceId,
                        );
                        await repository.putPrincipal(snapshotPrincipal);

                        event = newClientEvent(
                            'session-connected',
                            snapshotPrincipal,
                            request,
                            now(),
                            serviceId,
                            clientInstanceId,
                            sessionId,
                        );

                        await repository.appendEvent(event);
                    }

                    return {
                        snapshot: await requireClientSnapshot(repository, snapshotPrincipal),
                        event,
                    };
                },
            );

            if (result.event) {
                await publishClientMutation(
                    syncPublisher,
                    result.snapshot,
                    result.event,
                    serviceId,
                );
            }
            return result.snapshot;
        },
        heartbeatSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            const result = await runtimeRepository.begin(
                async (transactionRepository) => {
                    const repository = new ClientStateRepository(transactionRepository);
                    const principalRef = {
                        ...scope,
                        principalId,
                    };
                    const principal = await repository.findPrincipal(principalRef);
                    if (!principal) {
                        throw new Error(`Client principal not found: ${principalId}`);
                    }

                    const existing = await repository.findSession({
                        ...scope,
                        principalId,
                        clientInstanceId,
                        sessionId,
                    });
                    if (!existing) {
                        throw new Error(`Client session not found: ${sessionId}`);
                    }

                    const heartbeatTimestamp = request.lastHeartbeatAtEpochMs ?? now();
                    const presenceState = request.presenceState ??
                        existing.presenceState;
                    const wasSemanticallyActive = existing.status === 'active' &&
                        existing.presenceState === presenceState &&
                        existing.disconnectedAtEpochMs === undefined &&
                        existing.disconnectReason === undefined;
                    const session: ClientSession = {
                        ...existing,
                        status: 'active',
                        presenceState,
                        lastHeartbeatAtEpochMs: heartbeatTimestamp,
                        expiresAtEpochMs: request.expiresAtEpochMs ??
                            existing.expiresAtEpochMs ??
                            heartbeatTimestamp + DEFAULT_SESSION_TTL_MS,
                        disconnectedAtEpochMs: undefined,
                        disconnectReason: undefined,
                    };

                    await repository.putSession(session);

                    let event: ClientEvent | undefined;
                    if (wasSemanticallyActive) {
                        const nextPrincipal = rememberPrincipalLastSeen(
                            principal,
                            heartbeatTimestamp,
                        );
                        if (nextPrincipal !== principal) {
                            await repository.putPrincipal(nextPrincipal);
                        }
                    } else {
                        await repository.putPrincipal(
                            bumpPrincipalPresence(
                                principal,
                                heartbeatTimestamp,
                                request,
                                now(),
                                serviceId,
                            ),
                        );

                        event = newClientEvent(
                            'session-heartbeat',
                            principal,
                            request,
                            now(),
                            serviceId,
                            clientInstanceId,
                            sessionId,
                        );
                        await repository.appendEvent(event);
                    }

                    return {
                        snapshot: await requireClientSnapshot(repository, principal),
                        event,
                    };
                },
            );

            if (result.event) {
                await publishClientMutation(
                    syncPublisher,
                    result.snapshot,
                    result.event,
                    serviceId,
                );
            }
            return result.snapshot;
        },
        disconnectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            const result = await runtimeRepository.begin(
                async (transactionRepository) => {
                    const repository = new ClientStateRepository(transactionRepository);
                    const principalRef = {
                        ...scope,
                        principalId,
                    };
                    const principal = await repository.findPrincipal(principalRef);
                    if (!principal) {
                        throw new Error(`Client principal not found: ${principalId}`);
                    }

                    const existing = await repository.findSession({
                        ...scope,
                        principalId,
                        clientInstanceId,
                        sessionId,
                    });
                    if (!existing) {
                        throw new Error(`Client session not found: ${sessionId}`);
                    }

                    const disconnectedAtEpochMs = request.disconnectedAtEpochMs ?? now();
                    const session: ClientSession = {
                        ...existing,
                        status: 'disconnected',
                        lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ??
                            existing.lastHeartbeatAtEpochMs,
                        expiresAtEpochMs: request.expiresAtEpochMs ??
                            existing.expiresAtEpochMs,
                        disconnectedAtEpochMs,
                        disconnectReason: request.reason ?? existing.disconnectReason ??
                            'closed',
                    };

                    await repository.putSession(session);

                    let event: ClientEvent | undefined;
                    let snapshotPrincipal = principal;
                    if (isSameDisconnectedClientSession(existing, session)) {
                        const nextPrincipal = rememberPrincipalLastSeen(
                            principal,
                            session.lastHeartbeatAtEpochMs,
                        );
                        if (nextPrincipal !== principal) {
                            await repository.putPrincipal(nextPrincipal);
                            snapshotPrincipal = nextPrincipal;
                        }
                    } else {
                        snapshotPrincipal = bumpPrincipalPresence(
                            principal,
                            disconnectedAtEpochMs,
                            request,
                            now(),
                            serviceId,
                        );
                        await repository.putPrincipal(snapshotPrincipal);

                        event = newClientEvent(
                            'session-disconnected',
                            snapshotPrincipal,
                            request,
                            now(),
                            serviceId,
                            clientInstanceId,
                            sessionId,
                        );
                        await repository.appendEvent(event);
                    }

                    return {
                        snapshot: await requireClientSnapshot(repository, snapshotPrincipal),
                        event,
                    };
                },
            );

            if (result.event) {
                await publishClientMutation(
                    syncPublisher,
                    result.snapshot,
                    result.event,
                    serviceId,
                );
            }
            return result.snapshot;
        },
        registerAuthorisedWsClientSession: async (authSession, input = {}) => {
            const scope: StateScope = {
                applicationId: input.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
                workspaceId: input.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            };
            const principalId = input.principalId ?? authSession.clientId;
            const clientInstanceId = input.clientInstanceId ??
                authSession.clientId;
            const expiresAtEpochMs = input.expiresAtEpochMs ??
                now() + DEFAULT_SESSION_TTL_MS;

            const result = await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const timestamp = now();
                const principal = await ensurePrincipal(
                    repository,
                    scope,
                    principalId,
                    {
                        username: authSession.username,
                        displayName: input.displayName ?? authSession.username,
                        status: 'active',
                        roles: ['member'],
                        metadata: {},
                        actorPrincipalId: principalId,
                        actorSessionId: authSession.sessionId,
                    },
                    timestamp,
                    serviceId,
                );

                await ensureInstance(
                    repository,
                    principal,
                    clientInstanceId,
                    {
                        status: 'active',
                        platform: input.platform ?? 'web',
                        userAgent: input.userAgent,
                        capabilities: input.capabilities ?? ['ws'],
                        actorPrincipalId: principalId,
                        actorSessionId: authSession.sessionId,
                    },
                    timestamp,
                    serviceId,
                );

                const existing = await repository.findSession({
                    ...scope,
                    principalId,
                    clientInstanceId,
                    sessionId: authSession.sessionId,
                });
                const session = toActiveSession(
                    principal,
                    clientInstanceId,
                    authSession.sessionId,
                    existing,
                    {
                        presenceState: 'online',
                        transport: 'ws',
                        connectionId: authSession.sessionId,
                        authenticatedAtEpochMs: timestamp,
                        connectedAtEpochMs: timestamp,
                        lastHeartbeatAtEpochMs: timestamp,
                        expiresAtEpochMs,
                        actorPrincipalId: principalId,
                        actorSessionId: authSession.sessionId,
                    },
                    timestamp,
                );

                await repository.putSession(session);
                await repository.putPrincipal(
                    bumpPrincipalPresence(
                        principal,
                        session.lastHeartbeatAtEpochMs,
                        {
                            actorPrincipalId: principalId,
                            actorSessionId: authSession.sessionId,
                        },
                        timestamp,
                        serviceId,
                    ),
                );

                const event = newClientEvent(
                    'session-connected',
                    principal,
                    {
                        actorPrincipalId: principalId,
                        actorSessionId: authSession.sessionId,
                    },
                    timestamp,
                    serviceId,
                    clientInstanceId,
                    authSession.sessionId,
                );
                await repository.appendEvent(event);

                return {
                    snapshot: await requireClientSnapshot(repository, principal),
                    event,
                };
            });

            await publishClientMutation(
                syncPublisher,
                result.snapshot,
                result.event,
                serviceId,
            );
            return result.snapshot;
        },
        disconnectAuthorisedWsClientSession: async (
            sessionId,
            reason = 'websocket-closed',
        ) => {
            const issuedSession = await createAuthSessionRepository().findBySessionId(
                sessionId,
            );
            if (!issuedSession) {
                throw new Error(`Client not authorised: ${sessionId}`);
            }

            const scope: StateScope = {
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            };
            const principalId = issuedSession.clientId;
            const clientInstanceId = issuedSession.clientId;

            return await service.disconnectSession(
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                {
                    reason,
                    actorPrincipalId: principalId,
                    actorSessionId: sessionId,
                },
            );
        },
    };

    return service;
}

export function getClientStateService(): ClientStateService {
    return createClientStateService({
        runtimeRepository: createRuntimeStateRepository(),
        syncPublisher: getWsStateSyncPublisher(),
        serviceId: myServerId,
    });
}

async function publishClientMutation(
    syncPublisher: StateSyncPublisher,
    snapshot: ClientSnapshot,
    event: ClientEvent,
    serviceId: string,
): Promise<void> {
    await syncPublisher.publishClientSnapshot(snapshot, serviceId);
    await syncPublisher.publishClientEvent(event, serviceId);
}

async function ensurePrincipal(
    repository: ClientStateRepository,
    scope: StateScope,
    principalId: string,
    request: UpsertClientPrincipalRequest,
    timestamp: number,
    serviceId: string,
): Promise<ClientPrincipal> {
    const existing = await repository.findPrincipal({
        ...scope,
        principalId,
    });
    if (existing) {
        return existing;
    }

    const principal = toPrincipal(
        scope,
        principalId,
        undefined,
        request,
        timestamp,
        serviceId,
    );
    await repository.putPrincipal(principal);
    return principal;
}

async function ensureInstance(
    repository: ClientStateRepository,
    principal: ClientPrincipal,
    clientInstanceId: string,
    request: UpsertClientInstanceRequest,
    timestamp: number,
    serviceId: string,
): Promise<ClientInstance> {
    const ref: ClientInstanceRef = {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId,
    };
    const existing = await repository.findInstance(ref);
    if (existing) {
        return existing;
    }

    const instance = toInstance(
        principal,
        clientInstanceId,
        undefined,
        request,
        timestamp,
        serviceId,
    );
    await repository.putInstance(instance);
    return instance;
}

function toPrincipal(
    scope: StateScope,
    principalId: string,
    existing: ClientPrincipal | undefined,
    request: UpsertClientPrincipalRequest,
    timestamp: number,
    serviceId: string,
): ClientPrincipal {
    const updated = toAuditStamp(
        request,
        timestamp,
        serviceId,
        request.actorPrincipalId ?? principalId,
    );
    const status = request.status ?? existing?.status ?? 'active';

    return {
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        principalId,
        username: request.username,
        displayName: request.displayName ?? existing?.displayName,
        avatarUrl: request.avatarUrl ?? existing?.avatarUrl,
        status,
        authProvider: request.authProvider ?? existing?.authProvider,
        externalSubjectId: request.externalSubjectId ?? existing?.externalSubjectId,
        roles: request.roles ?? existing?.roles ?? [],
        metadata: request.metadata ?? existing?.metadata ?? {},
        profileVersion: existing ? existing.profileVersion + 1 : 1,
        presenceVersion: existing?.presenceVersion ?? 1,
        created: existing?.created ?? updated,
        updated,
        disabled: status === 'disabled' ? updated : existing?.disabled,
        deleted: status === 'deleted' ? updated : existing?.deleted,
        lastSeenAtEpochMs: request.lastSeenAtEpochMs ?? existing?.lastSeenAtEpochMs,
    };
}

function toInstance(
    principal: ClientPrincipal,
    clientInstanceId: string,
    existing: ClientInstance | undefined,
    request: UpsertClientInstanceRequest,
    timestamp: number,
    serviceId: string,
): ClientInstance {
    const updated = toAuditStamp(
        request,
        timestamp,
        serviceId,
        request.actorPrincipalId ?? principal.principalId,
    );
    const status = request.status ?? existing?.status ?? 'active';

    return {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId,
        status,
        platform: request.platform ?? existing?.platform ?? 'unknown',
        deviceLabel: request.deviceLabel ?? existing?.deviceLabel,
        appVersion: request.appVersion ?? existing?.appVersion,
        userAgent: request.userAgent ?? existing?.userAgent,
        capabilities: request.capabilities ?? existing?.capabilities ?? [],
        registered: existing?.registered ?? updated,
        updated,
        revoked: status === 'revoked' ? updated : existing?.revoked,
    };
}

function toActiveSession(
    principal: ClientPrincipal,
    clientInstanceId: string,
    sessionId: string,
    existing: ClientSession | undefined,
    request: ConnectClientSessionRequest,
    timestamp: number,
): ClientSession {
    return {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId,
        sessionId,
        status: 'active',
        presenceState: request.presenceState ?? existing?.presenceState ?? 'online',
        transport: request.transport ?? existing?.transport ?? 'unknown',
        connectionId: request.connectionId ?? existing?.connectionId,
        authenticatedAtEpochMs: request.authenticatedAtEpochMs ??
            existing?.authenticatedAtEpochMs ??
            timestamp,
        connectedAtEpochMs: request.connectedAtEpochMs ??
            existing?.connectedAtEpochMs ??
            timestamp,
        lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? timestamp,
        expiresAtEpochMs: request.expiresAtEpochMs ??
            timestamp + DEFAULT_SESSION_TTL_MS,
        disconnectedAtEpochMs: undefined,
        disconnectReason: undefined,
    };
}

function bumpPrincipalPresence(
    principal: ClientPrincipal,
    lastSeenAtEpochMs: number,
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
): ClientPrincipal {
    return {
        ...principal,
        presenceVersion: principal.presenceVersion + 1,
        updated: toAuditStamp(
            request,
            timestamp,
            serviceId,
            request.actorPrincipalId ?? principal.principalId,
        ),
        lastSeenAtEpochMs,
    };
}

function bumpPrincipalProfile(
    principal: ClientPrincipal,
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
): ClientPrincipal {
    return {
        ...principal,
        profileVersion: principal.profileVersion + 1,
        updated: toAuditStamp(
            request,
            timestamp,
            serviceId,
            request.actorPrincipalId ?? principal.principalId,
        ),
    };
}

function rememberPrincipalLastSeen(
    principal: ClientPrincipal,
    lastSeenAtEpochMs: number,
): ClientPrincipal {
    if ((principal.lastSeenAtEpochMs ?? Number.NEGATIVE_INFINITY) >= lastSeenAtEpochMs) {
        return principal;
    }

    return {
        ...principal,
        lastSeenAtEpochMs,
    };
}

function isSameClientPrincipalMutation(
    current: ClientPrincipal,
    next: ClientPrincipal,
): boolean {
    return current.username === next.username &&
        current.displayName === next.displayName &&
        current.avatarUrl === next.avatarUrl &&
        current.status === next.status &&
        current.authProvider === next.authProvider &&
        current.externalSubjectId === next.externalSubjectId &&
        arrayEquals(current.roles, next.roles) &&
        jsonEquals(current.metadata, next.metadata) &&
        current.lastSeenAtEpochMs === next.lastSeenAtEpochMs;
}

function isSameClientInstanceMutation(
    current: ClientInstance,
    next: ClientInstance,
): boolean {
    return current.status === next.status &&
        current.platform === next.platform &&
        current.deviceLabel === next.deviceLabel &&
        current.appVersion === next.appVersion &&
        current.userAgent === next.userAgent &&
        arrayEquals(current.capabilities, next.capabilities);
}

function isSameActiveClientSession(
    current: ClientSession,
    next: ClientSession,
): boolean {
    return current.status === 'active' &&
        next.status === 'active' &&
        current.presenceState === next.presenceState &&
        current.transport === next.transport &&
        current.connectionId === next.connectionId &&
        current.authenticatedAtEpochMs === next.authenticatedAtEpochMs &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectedAtEpochMs === undefined &&
        next.disconnectedAtEpochMs === undefined &&
        current.disconnectReason === undefined &&
        next.disconnectReason === undefined;
}

function isSameDisconnectedClientSession(
    current: ClientSession,
    next: ClientSession,
): boolean {
    return current.status === 'disconnected' &&
        next.status === 'disconnected' &&
        current.presenceState === next.presenceState &&
        current.transport === next.transport &&
        current.connectionId === next.connectionId &&
        current.authenticatedAtEpochMs === next.authenticatedAtEpochMs &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectReason === next.disconnectReason;
}

function newClientEvent(
    eventType: ClientEvent['eventType'],
    principal: ClientPrincipal,
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
    clientInstanceId?: string,
    sessionId?: string,
): ClientEvent {
    return {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        eventId: crypto.randomUUID(),
        eventType,
        clientInstanceId,
        sessionId,
        occurredAtEpochMs: timestamp,
        actor: {
            principalId: request.actorPrincipalId ?? principal.principalId,
            sessionId: request.actorSessionId,
            serviceId,
        },
        reason: request.reason,
        traceId: request.traceId,
        requestId: request.requestId,
    };
}

function toAuditStamp(
    request: MutationActorInput,
    timestamp: number,
    serviceId: string,
    defaultPrincipalId?: string,
): AuditStamp {
    return {
        atEpochMs: timestamp,
        byPrincipalId: request.actorPrincipalId ?? defaultPrincipalId,
        bySessionId: request.actorSessionId,
        byServiceId: serviceId,
        reason: request.reason,
        traceId: request.traceId,
        requestId: request.requestId,
    };
}

async function requireClientSnapshot(
    repository: ClientStateRepository,
    ref: ClientPrincipalRef,
): Promise<ClientSnapshot> {
    const snapshot = await repository.readSnapshot(ref);
    if (!snapshot) {
        throw new Error(`Client snapshot not found: ${ref.principalId}`);
    }

    return snapshot;
}

function arrayEquals<T>(
    left: readonly T[],
    right: readonly T[],
): boolean {
    return left.length === right.length &&
        left.every((value, index) => Object.is(value, right[index]));
}

function jsonEquals(left: unknown, right: unknown): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right);
}

function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toStableJson);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, toStableJson(entryValue)]),
    );
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
