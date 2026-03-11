import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    CommandsOrchestrator,
    type CommandsOrchestratorPolicies,
    type OrchestratorResults,
} from '@shared/cache/CommandsOrchestrator.ts';
import {
    connectStateGroupPresenceSession,
    createStateGroup,
    defaultStateScope,
    disconnectStateGroupPresenceSession,
    heartbeatStateClientSession,
    heartbeatStateGroupPresenceSession,
    listStateClients,
    listStateGroups,
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
    heartbeatAtEpochMs?: number;
    ttlMs?: number;
    policies?: CommandsOrchestratorPolicies<StateHeartbeatWorkflowValue>;
}>;

export type RefreshStateHeartbeatResult = Readonly<{
    client: ClientStateSnapshot;
    groups: GroupStateSnapshot[];
    heartbeatAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

type StateSnapshotsKey = 'clients' | 'groups';

type GroupWorkflowKey =
    | 'created'
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
): Promise<GroupStateSnapshot> {
    const groupId = crypto.randomUUID();
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
                        metadata: {},
                    },
                    scope,
                    { signal },
                )),
            flow.commandStep('joined', (signal) =>
                connectStateGroupPresenceSession(
                    groupId,
                    sessionId,
                    {
                        principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
                    },
                    scope,
                    { signal },
                )),
        )
        .run();

    return requireWorkflowResult(results, 'joined');
}

export async function joinStateGroup(
    groupId: string,
    principalId: string,
    sessionId: string,
    scope: StateScope = defaultStateScope(),
    policies: CommandsOrchestratorPolicies<StateGroupWorkflowValue> = {},
): Promise<GroupStateSnapshot> {
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
                    },
                    scope,
                    { signal },
                )),
            flow.commandStep('joined', (signal) =>
                connectStateGroupPresenceSession(
                    groupId,
                    sessionId,
                    {
                        principalId,
                        actorPrincipalId: principalId,
                        actorSessionId: sessionId,
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
    const flow = CommandsOrchestrator.withPolicies<
        StateHeartbeatKey,
        StateHeartbeatWorkflowValue
    >(options.policies ?? {});

    const results = await flow
        .sequential(
            flow.commandStep('client', (signal) =>
                heartbeatStateClientSession(
                    clientData.clientId,
                    clientData.clientId,
                    clientData.sessionId,
                    {
                        actorPrincipalId: clientData.clientId,
                        actorSessionId: clientData.sessionId,
                        presenceState: 'online',
                        lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
                        expiresAtEpochMs,
                    },
                    scope,
                    { signal },
                )),
        )
        .parallel(
            ...joinedGroups.map((snapshot) =>
                flow.commandStep(
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
                            },
                            scope,
                            { signal },
                        ),
                    {
                        errorOnNull: false,
                        fallback: (error) => tolerateNotFound(error, undefined),
                    },
                )
            ),
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
        heartbeatAtEpochMs,
        expiresAtEpochMs,
    };
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
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('404');
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
