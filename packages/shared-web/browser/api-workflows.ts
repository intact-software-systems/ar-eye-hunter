import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import type {
    AppointGroupDirectorRequest,
    StateScope,
} from '@shared/api/state-types.ts';
import {
    Command,
    type CommandOptions,
} from '@shared/cache/Command.ts';
import {
    CommandsOrchestrator,
    type CommandsOrchestratorPolicies,
    type OrchestratorResults,
} from '@shared/cache/CommandsOrchestrator.ts';
import {
    appointStateGroupDirector as appointStateGroupDirectorApi,
    connectStateClientSession,
    connectStateGroupPresenceSession,
    createStateGroup,
    defaultStateScope,
    disconnectStateGroupPresenceSession,
    findStateGroup,
    heartbeatStateClientSession,
    heartbeatStateGroupPresenceSession,
    listStateClients,
    listStateGroups,
    updateStateGroup,
    upsertStateGroupMember,
} from '@shared-web/browser/api-integration.ts';

export const DEFAULT_STATE_HEARTBEAT_TTL_MSECS = 120000;

export type StateSnapshots = Readonly<{
    clients: ClientStateSnapshot[];
    groups: GroupStateSnapshot[];
}>;

export type StateSnapshotsWorkflowValue =
    | ClientStateSnapshot[]
    | GroupStateSnapshot[];

export type StateGroupWorkflowValue = GroupStateSnapshot | undefined;

export type StateHeartbeatWorkflowValue =
    | ClientStateSnapshot
    | GroupStateSnapshot
    | undefined;

export type RefreshStateHeartbeatOptions = Readonly<{
    scope?: StateScope;
    authSession?: AuthSession;
    heartbeatAtEpochMs?: number;
    ttlMs?: number;
    policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
}>;

export type RefreshStateHeartbeatResult = Readonly<{
    client: ClientStateSnapshot;
    groups: GroupStateSnapshot[];
    missingGroups: GroupStateSnapshot[];
    heartbeatAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

type StateSnapshotsKey = 'clients' | 'groups';

type GroupWorkflowKey =
    | 'created'
    | 'read'
    | 'updated'
    | 'member'
    | 'joined'
    | 'disconnected'
    | 'left';

type StateHeartbeatKey = 'client' | `group:${string}`;

export async function refreshStateSnapshots(
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateSnapshotsWorkflowValue> = {},
): Promise<StateSnapshots> {
    const flow = CommandsOrchestrator.withPolicies<
        StateSnapshotsKey,
        StateSnapshotsWorkflowValue
    >(policies);

    const results = await flow
        .parallel(
            flow.commandStep(
                'clients',
                (signal) => listStateClients(scope, { signal }),
            ),
            flow.commandStep(
                'groups',
                (signal) => listStateGroups(scope, { signal }),
            ),
        )
        .run();

    return {
        clients: requireWorkflowResult(results, 'clients') as ClientStateSnapshot[],
        groups: requireWorkflowResult(results, 'groups') as GroupStateSnapshot[],
    };
}

export async function createAndJoinStateGroup(
    displayName: string,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
    requestedGroupId?: string,
): Promise<GroupStateSnapshot> {
    const groupId = requestedGroupId?.trim() || crypto.randomUUID();
    const createRequestId = toWorkflowRequestId('group-create', groupId);
    const presenceRequestId = toWorkflowRequestId(
        'group-presence-connect',
        groupId,
        sessionId,
    );
    const flow = CommandsOrchestrator.withPolicies<
        GroupWorkflowKey,
        StateGroupWorkflowValue
    >(policies);

    const results = await flow
        .sequential(
            flow.commandStep('created', (signal) =>
                createStateGroup(
                    {
                        groupId,
                        slug: toSlug(displayName),
                        displayName,
                        kind: 'room',
                        joinMode: 'invite-only',
                        createdByPrincipalId: principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                        requestId: createRequestId,
                        metadata: {},
                    },
                    scope,
                    { signal },
                )),
            flow.commandStep('joined', (signal) =>
                connectStateGroupPresenceSessionWithMembershipRepair(
                    groupId,
                    principalId,
                    sessionId,
                    {
                        principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                        requestId: presenceRequestId,
                    },
                    scope,
                    { signal },
                )),
        )
        .run();

    return requireWorkflowResult(results, 'joined');
}

export async function updateStateGroupMetadata(
    groupId: string,
    patch: Readonly<Record<string, unknown>>,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
    const requestId = toWorkflowRequestId(
        'group-metadata-update',
        groupId,
        sessionId,
    );
    const commandOptions = (policies.command ?? {}) as CommandOptions<
        GroupStateSnapshot
    >;
    const current = await new Command<GroupStateSnapshot>(
        (signal) => findStateGroup(groupId, scope, { signal }),
        commandOptions,
    ).run();

    return await new Command<GroupStateSnapshot>(
        (signal) =>
            updateStateGroup(
                groupId,
                {
                    metadata: {
                        ...current.group.metadata,
                        ...patch,
                    },
                    actorPrincipalId: principalId,
                    actorSessionId: sessionId,
                    requestId,
                },
                scope,
                { signal },
            ),
        commandOptions,
    ).run();
}

export async function appointStateGroupDirector(
    groupId: string,
    request: AppointGroupDirectorRequest,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
    const requestId = request.requestId ??
        toWorkflowRequestId('group-director-appoint', groupId, sessionId);
    const commandOptions = (policies.command ?? {}) as CommandOptions<
        GroupStateSnapshot
    >;

    return await new Command<GroupStateSnapshot>(
        (signal) =>
            appointStateGroupDirectorApi(
                groupId,
                {
                    ...request,
                    actorPrincipalId: principalId,
                    actorSessionId: sessionId,
                    requestId,
                },
                scope,
                { signal },
            ),
        commandOptions,
    ).run();
}

export async function joinStateGroup(
    groupId: string,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
    const memberRequestId = toWorkflowRequestId(
        'group-member-upsert',
        groupId,
        principalId,
    );
    const presenceRequestId = toWorkflowRequestId(
        'group-presence-connect',
        groupId,
        sessionId,
    );
    const flow = CommandsOrchestrator.withPolicies<
        GroupWorkflowKey,
        StateGroupWorkflowValue
    >(policies);

    const results = await flow
        .sequential(
            flow.commandStep('member', (signal) =>
                upsertStateGroupMember(
                    groupId,
                    principalId,
                    {
                        status: 'active',
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                        requestId: memberRequestId,
                    },
                    scope,
                    { signal },
                )),
            flow.commandStep('joined', (signal) =>
                connectStateGroupPresenceSessionWithMembershipRepair(
                    groupId,
                    principalId,
                    sessionId,
                    {
                        principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                        requestId: presenceRequestId,
                    },
                    scope,
                    { signal },
                )),
        )
        .run();

    return requireWorkflowResult(results, 'joined');
}

export async function leaveStateGroup(
    groupId: string,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
    const disconnectRequestId = toWorkflowRequestId(
        'group-presence-disconnect',
        groupId,
        sessionId,
    );
    const memberRequestId = toWorkflowRequestId(
        'group-member-upsert',
        groupId,
        principalId,
    );
    const flow = CommandsOrchestrator.withPolicies<
        GroupWorkflowKey,
        StateGroupWorkflowValue
    >(policies);

    const results = await flow
        .sequential(
            flow.commandStep(
                'disconnected',
                (signal) =>
                    disconnectStateGroupPresenceSession(
                        groupId,
                        sessionId,
                        {
                            principalId,
                            actorPrincipalId: principalId,
                            actorSessionId: sessionId,
                            reason: 'left-group',
                            requestId: disconnectRequestId,
                        },
                        scope,
                        { signal },
                    ),
                {
                    errorOnNull: false,
                    fallback: (error) => tolerateNotFound(error, undefined),
                },
            ),
            flow.commandStep('left', (signal) =>
                upsertStateGroupMember(
                    groupId,
                    principalId,
                    {
                        status: 'left',
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                        reason: 'left-group',
                        requestId: memberRequestId,
                    },
                    scope,
                    { signal },
                )),
        )
        .run();

    return requireWorkflowResult(results, 'left');
}

export async function refreshStateHeartbeat(
    clientData: ClientInfo,
    joinedGroups: readonly GroupStateSnapshot[],
    options: RefreshStateHeartbeatOptions = {},
): Promise<RefreshStateHeartbeatResult> {
    const scope = options.scope ?? defaultStateScope();
    const heartbeatAtEpochMs = options.heartbeatAtEpochMs ?? Date.now();
    const expiresAtEpochMs = heartbeatAtEpochMs +
        (options.ttlMs ?? DEFAULT_STATE_HEARTBEAT_TTL_MSECS);
    const clientHeartbeatRequestId = toWorkflowRequestId(
        'client-session-heartbeat',
        clientData.clientId,
        clientData.sessionId,
    );
    const flow = CommandsOrchestrator.withPolicies<
        StateHeartbeatKey,
        StateHeartbeatWorkflowValue
    >(options.policies ?? {});
    const commandPolicy = options.policies?.command;

    const results = await flow
        .sequential(
            flow.commandStep('client', (signal) =>
                heartbeatStateClientSessionWithPresenceRepair(
                    clientData,
                    {
                        actorPrincipalId: clientData.clientId,
                        actorSessionId: clientData.sessionId,
                        presenceState: 'online',
                        lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
                        expiresAtEpochMs,
                        requestId: clientHeartbeatRequestId,
                    },
                    scope,
                    {
                        signal,
                        authSession: options.authSession,
                    },
                ),
                {
                    shouldRetry: (error, attempt) =>
                        !isNotFoundApiError(error) &&
                        shouldRetryHeartbeatError(error, attempt, commandPolicy),
                },
            ),
        )
        .parallel(
            ...joinedGroups.map((snapshot) => {
                const groupHeartbeatRequestId = toWorkflowRequestId(
                    'group-presence-heartbeat',
                    snapshot.group.groupId,
                    clientData.sessionId,
                );

                return flow.commandStep(
                    `group:${snapshot.group.groupId}`,
                    (signal) =>
                        heartbeatStateGroupPresenceSession(
                            snapshot.group.groupId,
                            clientData.sessionId,
                            {
                                principalId: clientData.clientId,
                                actorPrincipalId: clientData.clientId,
                                actorSessionId: clientData.sessionId,
                                lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
                                expiresAtEpochMs,
                                requestId: groupHeartbeatRequestId,
                            },
                            scope,
                            {
                                signal,
                                authSession: options.authSession,
                            },
                        ),
                    {
                        errorOnNull: false,
                        shouldRetry: (error, attempt) =>
                            !isNotFoundApiError(error) &&
                            shouldRetryHeartbeatError(error, attempt, commandPolicy),
                        fallback: (error) => tolerateNotFound(error, undefined),
                    },
                );
            }),
        )
        .run();

    return {
        client: requireWorkflowResult(results, 'client') as ClientStateSnapshot,
        groups: joinedGroups
            .map((snapshot) =>
                results.get(`group:${snapshot.group.groupId}`) as
                    | GroupStateSnapshot
                    | undefined
            )
            .filter(isDefined),
        missingGroups: joinedGroups.filter((snapshot) =>
            results.get(`group:${snapshot.group.groupId}`) === undefined
        ),
        heartbeatAtEpochMs,
        expiresAtEpochMs,
    };
}

async function heartbeatStateClientSessionWithPresenceRepair(
    clientData: ClientInfo,
    request: Parameters<typeof heartbeatStateClientSession>[3],
    scope: StateScope,
    options: Parameters<typeof heartbeatStateClientSession>[5],
): Promise<ClientStateSnapshot> {
    try {
        return await heartbeatStateClientSession(
            clientData.clientId,
            clientData.clientId,
            clientData.sessionId,
            request,
            scope,
            options,
        );
    } catch (error) {
        if (!isNotFoundApiError(error)) {
            throw error;
        }
    }

    return await connectStateClientSession(
        clientData.clientId,
        clientData.clientId,
        clientData.sessionId,
        {
            actorPrincipalId: request.actorPrincipalId ?? clientData.clientId,
            actorSessionId: request.actorSessionId ?? clientData.sessionId,
            presenceState: request.presenceState ?? 'online',
            transport: 'ws',
            connectionId: clientData.sessionId,
            connectedAtEpochMs: request.lastHeartbeatAtEpochMs,
            lastHeartbeatAtEpochMs: request.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: request.expiresAtEpochMs,
            requestId: toWorkflowRequestId(
                'client-session-connect-repair',
                clientData.clientId,
                clientData.sessionId,
            ),
        },
        scope,
        options,
    );
}

async function connectStateGroupPresenceSessionWithMembershipRepair(
    groupId: string,
    principalId: string,
    sessionId: string,
    request: Parameters<typeof connectStateGroupPresenceSession>[2],
    scope: StateScope,
    options: Parameters<typeof connectStateGroupPresenceSession>[4],
): Promise<GroupStateSnapshot> {
    try {
        return await connectStateGroupPresenceSession(
            groupId,
            sessionId,
            request,
            scope,
            options,
        );
    } catch (error) {
        if (!isRepairableGroupPresenceForbidden(error)) {
            throw error;
        }
    }

    await upsertStateGroupMember(
        groupId,
        principalId,
        {
            status: 'active',
            actorPrincipalId: request.actorPrincipalId ?? principalId,
            actorSessionId: request.actorSessionId ?? sessionId,
            requestId: toWorkflowRequestId(
                'group-member-repair',
                groupId,
                principalId,
                sessionId,
            ),
        },
        scope,
        options,
    );

    return await connectStateGroupPresenceSession(
        groupId,
        sessionId,
        {
            ...request,
            requestId: toWorkflowRequestId(
                'group-presence-connect-retry',
                groupId,
                sessionId,
            ),
        },
        scope,
        options,
    );
}

function requireWorkflowResult<K, V>(
    results: OrchestratorResults<K, V>,
    key: K,
): NonNullable<V> {
    const value = results.get(key);
    if (value === undefined || value === null) {
        throw new Error(`Workflow step ${String(key)} did not produce a value.`);
    }

    return value as NonNullable<V>;
}

function tolerateNotFound<T>(error: unknown, value: T): T {
    if (isNotFoundApiError(error)) {
        return value;
    }

    throw error;
}

function isNotFoundApiError(error: unknown): boolean {
    if (readApiErrorStatus(error) === 404) {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes('404');
}

function shouldRetryHeartbeatError<T>(
    error: unknown,
    attempt: number,
    commandPolicy: CommandsOrchestratorPolicies<T>['command'] | undefined,
): boolean {
    if (readApiErrorStatus(error) === 401) {
        return false;
    }

    return commandPolicy?.shouldRetry?.(error, attempt) ?? true;
}

function isRepairableGroupPresenceForbidden(error: unknown): boolean {
    if (readApiErrorStatus(error) !== 403) {
        return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const bodyText = typeof error === 'object' && error !== null &&
            'bodyText' in error &&
            typeof (error as { bodyText?: unknown }).bodyText === 'string'
        ? (error as { bodyText: string }).bodyText
        : '';
    const text = `${message} ${bodyText}`;
    return text.includes('group member not found for presence session') ||
        text.includes('group member is not active for presence session');
}

function readApiErrorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('status' in error)) {
        return undefined;
    }

    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' && Number.isFinite(status)
        ? status
        : undefined;
}

function isDefined<T>(value: T | undefined | null): value is T {
    return value !== undefined && value !== null;
}

function toSlug(displayName: string): string {
    return displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function toWorkflowRequestId(
    operation: string,
    ...parts: readonly string[]
): string {
    return [operation, ...parts, crypto.randomUUID()].join(':');
}
