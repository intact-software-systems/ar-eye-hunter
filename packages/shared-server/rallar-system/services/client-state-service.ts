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
import { ClientStateRepository } from '../repositories/ClientStateRepository.ts';
import type { AuthSessionRepository } from '../repositories/AuthSessionRepository.ts';
import type { RuntimeStateTransactionalRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type { StateSyncPublisher } from '../state-sync-publisher.ts';
import { arrayEquals, isDefined, jsonEquals, } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

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

export type ClientMutationWritten = Readonly<{
    snapshot: ClientSnapshot;
    event?: ClientEvent;
}>;

export type ClientStateWritten = Readonly<{
    status: 'ok';
    result: Either<string, ClientMutationWritten>;
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
    ): Promise<ClientStateWritten>;
    upsertInstance(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        request: UpsertClientInstanceRequest,
    ): Promise<ClientStateWritten>;
    connectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: ConnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    heartbeatSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: HeartbeatClientSessionRequest,
    ): Promise<ClientStateWritten>;
    disconnectSession(
        scope: StateScope,
        principalId: string,
        clientInstanceId: string,
        sessionId: string,
        request: DisconnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    registerAuthorisedWsClientSession(
        authSession: AuthSession,
        input?: RegisterAuthorisedWsClientInput,
    ): Promise<ClientStateWritten>;
    disconnectAuthorisedWsClientSession(
        sessionId: string,
        reason?: string,
    ): Promise<ClientStateWritten>;
}>;

export type ClientStateServiceDependencies = Readonly<{
    runtimeRepository: RuntimeStateTransactionalRepositoryLike;
    syncPublisher: StateSyncPublisher;
    authSessionRepository?: Pick<AuthSessionRepository, 'findBySessionId'>;
    now?: () => number;
    serviceId: string;
}>;

export function createClientStateService(
    dependencies: ClientStateServiceDependencies,
): ClientStateService {
    const runtimeRepository = dependencies.runtimeRepository;
    const now = dependencies.now ?? (() => Date.now());
    const serviceId = dependencies.serviceId;

    const service: ClientStateService = {
        listSnapshots: async (scope) => {
            const repository = new ClientStateRepository(runtimeRepository);
            const principals = await repository.listPrincipals(scope);
            const snapshots = await Promise.all(
                principals.map(
                    async (principal) => await repository.readSnapshot(principal),
                ),
            );

            return snapshots.filter(isDefined);
        },
        readSnapshot: async (ref) => {
            return await new ClientStateRepository(runtimeRepository).readSnapshot(
                ref,
            );
        },
        readPresenceSnapshot: async (ref) => {
            return await new ClientStateRepository(
                runtimeRepository,
            ).readPresenceSnapshot(ref);
        },
        listEvents: async (ref) => {
            return await new ClientStateRepository(runtimeRepository).listEvents(ref);
        },
        upsertPrincipal: async (scope, principalId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const existing = await repository.findPrincipal(principalRef);
                const principal = toPrincipal(
                    scope,
                    principalId,
                    existing,
                    request,
                    now(),
                    serviceId,
                );

                if (existing && isSameClientPrincipalMutation(existing, principal)) {
                    return await addIdempotentClientMutationWritten(
                        repository,
                        principalRef,
                        request.requestId,
                        {
                            snapshot: await requireClientSnapshot(repository, existing),
                            event: undefined,
                        },
                    );
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

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                    {
                        snapshot: await requireClientSnapshot(repository, principal),
                        event,
                    },
                );
            });
        },
        upsertInstance: async (scope, principalId, clientInstanceId, request) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

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
                    return await addIdempotentClientMutationWritten(
                        repository,
                        principalRef,
                        request.requestId,
                        {
                            snapshot: await requireClientSnapshot(repository, principal),
                            event: undefined,
                        },
                    );
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

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                    {
                        snapshot: await requireClientSnapshot(
                            repository,
                            snapshotPrincipal,
                        ),
                        event,
                    },
                );
            });
        },
        connectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

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

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                    {
                        snapshot: await requireClientSnapshot(
                            repository,
                            snapshotPrincipal,
                        ),
                        event,
                    },
                );
            });
        },
        heartbeatSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const principal = await repository.findPrincipal(principalRef);
                if (!principal) {
                    throw new NonRetryableException(`Client principal not found: ${principalId}`);
                }

                const existing = await repository.findSession({
                    ...scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                });
                if (!existing) {
                    throw new NonRetryableException(`Client session not found: ${sessionId}`);
                }

                const heartbeatTimestamp = request.lastHeartbeatAtEpochMs ?? now();
                const presenceState = request.presenceState ?? existing.presenceState;
                const wasSemanticallyActive =
                    existing.status === 'active' &&
                    existing.presenceState === presenceState &&
                    existing.disconnectedAtEpochMs === undefined &&
                    existing.disconnectReason === undefined;
                const session: ClientSession = {
                    ...existing,
                    status: 'active',
                    presenceState,
                    lastHeartbeatAtEpochMs: heartbeatTimestamp,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ??
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

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                    {
                        snapshot: await requireClientSnapshot(repository, principal),
                        event,
                    },
                );
            });
        },
        disconnectSession: async (
            scope,
            principalId,
            clientInstanceId,
            sessionId,
            request,
        ) => {
            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

                const principal = await repository.findPrincipal(principalRef);
                if (!principal) {
                    throw new NonRetryableException(`Client principal not found: ${principalId}`);
                }

                const existing = await repository.findSession({
                    ...scope,
                    principalId,
                    clientInstanceId,
                    sessionId,
                });
                if (!existing) {
                    throw new NonRetryableException(`Client session not found: ${sessionId}`);
                }

                const disconnectedAtEpochMs = request.disconnectedAtEpochMs ?? now();
                const session: ClientSession = {
                    ...existing,
                    status: 'disconnected',
                    lastHeartbeatAtEpochMs:
                        request.lastHeartbeatAtEpochMs ?? existing.lastHeartbeatAtEpochMs,
                    expiresAtEpochMs:
                        request.expiresAtEpochMs ?? existing.expiresAtEpochMs,
                    disconnectedAtEpochMs,
                    disconnectReason:
                        request.reason ?? existing.disconnectReason ?? 'closed',
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

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    request.requestId,
                    {
                        snapshot: await requireClientSnapshot(
                            repository,
                            snapshotPrincipal,
                        ),
                        event,
                    },
                );
            });
        },
        registerAuthorisedWsClientSession: async (authSession, input = {}) => {
            const scope: StateScope = {
                applicationId: input.applicationId ?? DEFAULT_STATE_APPLICATION_ID,
                workspaceId: input.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            };
            const principalId = input.principalId ?? authSession.clientId;
            const clientInstanceId = input.clientInstanceId ?? authSession.clientId;
            const expiresAtEpochMs =
                input.expiresAtEpochMs ?? now() + DEFAULT_SESSION_TTL_MS;
            const requestId = toAuthorisedWsClientRequestId(
                'connect',
                authSession.sessionId,
            );

            return await runtimeRepository.begin(async (transactionRepository) => {
                const repository = new ClientStateRepository(transactionRepository);
                const principalRef = {
                    ...scope,
                    principalId,
                };
                const idempotentWritten = await findIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    requestId,
                );
                if (idempotentWritten) {
                    return idempotentWritten;
                }

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
                        requestId,
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
                        requestId,
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
                        requestId,
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
                            requestId,
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
                        requestId,
                    },
                    timestamp,
                    serviceId,
                    clientInstanceId,
                    authSession.sessionId,
                );
                await repository.appendEvent(event);

                return await addIdempotentClientMutationWritten(
                    repository,
                    principalRef,
                    requestId,
                    {
                        snapshot: await requireClientSnapshot(repository, principal),
                        event,
                    },
                );
            });
        },
        disconnectAuthorisedWsClientSession: async (
            sessionId,
            reason = 'websocket-closed',
        ) => {
            const authSessionRepository = dependencies.authSessionRepository;
            const issuedSession =
                await authSessionRepository?.findBySessionId(sessionId);
            const session = issuedSession
                ? undefined
                : await findClientSessionBySessionId(
                    runtimeRepository,
                    sessionId,
                );
            if (!issuedSession && !session) {
                throw new NonRetryableException(`Client session not found: ${sessionId}`);
            }

            const scope: StateScope = issuedSession
                ? {
                    applicationId: DEFAULT_STATE_APPLICATION_ID,
                    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                }
                : {
                    applicationId: session!.applicationId,
                    workspaceId: session!.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
                };
            const principalId = issuedSession?.clientId ?? session!.principalId;
            const clientInstanceId = issuedSession?.clientId ??
                session!.clientInstanceId;

            return await service.disconnectSession(
                scope,
                principalId,
                clientInstanceId,
                sessionId,
                {
                    reason,
                    actorPrincipalId: principalId,
                    actorSessionId: sessionId,
                    requestId: toAuthorisedWsClientRequestId('disconnect', sessionId),
                },
            );
        },
    };

    return service;
}

async function findClientSessionBySessionId(
    runtimeRepository: RuntimeStateTransactionalRepositoryLike,
    sessionId: string,
): Promise<ClientSession | undefined> {
    const repository = new ClientStateRepository(runtimeRepository);
    const sessions = await repository.listAllSessions();

    return sessions.find((session) =>
        session.sessionId === sessionId &&
        session.status === 'active' &&
        session.disconnectedAtEpochMs === undefined
    ) ?? sessions.find((session) => session.sessionId === sessionId);
}

async function findIdempotentClientMutationWritten(
    repository: ClientStateRepository,
    ref: ClientPrincipalRef,
    requestId: string | undefined,
): Promise<ClientStateWritten | undefined> {
    if (!requestId) {
        return undefined;
    }

    return await repository.findIdempotentClientStateWritten(ref, requestId);
}

async function addIdempotentClientMutationWritten(
    repository: ClientStateRepository,
    ref: ClientPrincipalRef,
    requestId: string | undefined,
    written: ClientMutationWritten,
): Promise<ClientStateWritten> {
    const clientStateWritten = toClientStateWritten(written);

    if (!requestId) {
        return clientStateWritten;
    }

    return await repository.addIdempotentClientStateWritten(
        ref,
        requestId,
        clientStateWritten,
    );
}

function toClientStateWritten(
    written: ClientMutationWritten,
): ClientStateWritten {
    return {
        status: 'ok',
        result: Either.ofRight(written),
    };
}

function toAuthorisedWsClientRequestId(
    operation: 'connect' | 'disconnect',
    sessionId: string,
): string {
    return `authorised-ws:${operation}:${sessionId}`;
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
        snapshotVersion: existing ? existing.snapshotVersion + 1 : 1,
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
        authenticatedAtEpochMs:
            request.authenticatedAtEpochMs ??
            existing?.authenticatedAtEpochMs ??
            timestamp,
        connectedAtEpochMs:
            request.connectedAtEpochMs ?? existing?.connectedAtEpochMs ?? timestamp,
        lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs ?? timestamp,
        expiresAtEpochMs:
            request.expiresAtEpochMs ?? timestamp + DEFAULT_SESSION_TTL_MS,
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
        snapshotVersion: principal.snapshotVersion + 1,
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
        snapshotVersion: principal.snapshotVersion + 1,
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
    if (
        (principal.lastSeenAtEpochMs ?? Number.NEGATIVE_INFINITY) >=
        lastSeenAtEpochMs
    ) {
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
    return (
        current.username === next.username &&
        current.displayName === next.displayName &&
        current.avatarUrl === next.avatarUrl &&
        current.status === next.status &&
        current.authProvider === next.authProvider &&
        current.externalSubjectId === next.externalSubjectId &&
        arrayEquals(current.roles, next.roles) &&
        jsonEquals(current.metadata, next.metadata) &&
        current.lastSeenAtEpochMs === next.lastSeenAtEpochMs
    );
}

function isSameClientInstanceMutation(
    current: ClientInstance,
    next: ClientInstance,
): boolean {
    return (
        current.status === next.status &&
        current.platform === next.platform &&
        current.deviceLabel === next.deviceLabel &&
        current.appVersion === next.appVersion &&
        current.userAgent === next.userAgent &&
        arrayEquals(current.capabilities, next.capabilities)
    );
}

function isSameActiveClientSession(
    current: ClientSession,
    next: ClientSession,
): boolean {
    return (
        current.status === 'active' &&
        next.status === 'active' &&
        current.presenceState === next.presenceState &&
        current.transport === next.transport &&
        current.connectionId === next.connectionId &&
        current.authenticatedAtEpochMs === next.authenticatedAtEpochMs &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectedAtEpochMs === undefined &&
        next.disconnectedAtEpochMs === undefined &&
        current.disconnectReason === undefined &&
        next.disconnectReason === undefined
    );
}

function isSameDisconnectedClientSession(
    current: ClientSession,
    next: ClientSession,
): boolean {
    return (
        current.status === 'disconnected' &&
        next.status === 'disconnected' &&
        current.presenceState === next.presenceState &&
        current.transport === next.transport &&
        current.connectionId === next.connectionId &&
        current.authenticatedAtEpochMs === next.authenticatedAtEpochMs &&
        current.connectedAtEpochMs === next.connectedAtEpochMs &&
        current.disconnectReason === next.disconnectReason
    );
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
