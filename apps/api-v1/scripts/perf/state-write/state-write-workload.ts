import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    StateScope
} from '@shared/api/state-types.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { mapWithConcurrency } from '../map-with-concurrency.ts';
import {
    toStateWriteBenchmarkGroupContextId,
    toStateWriteBenchmarkSessionId
} from './api-v1-state-write-app-inbox-evidence.ts';
export const CLIENT_COUNT = 100;
const BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS = 1_700_000_000_000;
const BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS = 4_102_444_800_000;
export const MUTATION_MIX = [
    'profile-instance',
    'membership',
    'presence-connect',
    'presence-heartbeat',
    'presence-disconnect',
    'config',
    'topology-source'
] as const;
export const WORKLOADS = [
    { name: 'uncontended', clients: CLIENT_COUNT, groups: 100 },
    { name: 'shared', clients: CLIENT_COUNT, groups: 5 },
    { name: 'hot', clients: CLIENT_COUNT, groups: 1 }
] as const;

export interface StateWriteBenchmarkCommand {
    readonly commandId: string;
    readonly kind:
        | 'profile-instance'
        | 'membership'
        | 'presence-connect'
        | 'presence-heartbeat'
        | 'presence-disconnect'
        | 'config'
        | 'topology-source';
    readonly latencyMs: number;
    readonly stackIndex: number;
    readonly status: 'accepted' | 'exhausted';
}

export interface MutationCommand {
    kind: (typeof MUTATION_MIX)[number];
    clientIndex: number;
    groupIndex: number;
}

export function createBenchmarkAuthSession(
    scope: StateScope,
    principalId: string,
    sessionLabel: string
): IssuedAuthSession {
    const scopeIdentity = [scope.applicationId, scope.workspaceId].map(
        encodeURIComponent
    ).join(':');
    const principalIdentity = encodeURIComponent(principalId);
    const sessionIdentity = encodeURIComponent(sessionLabel);
    return {
        clientId: principalId,
        username: principalId,
        sessionId: toStateWriteBenchmarkSessionId(scope, principalId, sessionLabel),
        accessToken: `state-write-benchmark:${scopeIdentity}:${principalIdentity}:${sessionIdentity}`,
        issuedAtEpochMs: BENCHMARK_SESSION_ISSUED_AT_EPOCH_MS,
        expiresAtEpochMs: BENCHMARK_SESSION_EXPIRES_AT_EPOCH_MS
    };
}

export interface StateWriteWorkloadRuntime {
    readonly client: Pick<AppClientInboxService, 'processAuthenticatedEntryUntilCompletion'>;
    readonly group: Pick<GroupStateInboxService, 'processAuthenticatedGroupEntryUntilCompletion'>;
    readonly topology: Pick<TopologyInboxService, 'processAuthenticatedEntryUntilCompletion'>;
    readonly inbox: Pick<InboxQueueReader, 'dequeueInbox'>;
    readonly resilience: ResourceInboxResilience;
}

export interface StateWriteCommandBoundary {
    readonly commandId: string;
    readonly startedAtMonotonicMs: number;
    readonly endedAtMonotonicMs: number | 'unavailable';
}

export interface StateWriteDiagnosticCommand
    extends Pick<StateWriteBenchmarkCommand, 'commandId' | 'kind' | 'stackIndex'> {
    readonly status: 'accepted' | 'exhausted' | 'operation-failed';
}

export class StateWriteCommandCapture {
    private readonly boundaries: StateWriteCommandBoundary[] = [];
    private readonly commands: StateWriteDiagnosticCommand[] = [];

    retain(command: StateWriteDiagnosticCommand, boundary: StateWriteCommandBoundary): void {
        this.commands.push(command);
        this.boundaries.push(boundary);
    }

    getBoundaries(): readonly StateWriteCommandBoundary[] {
        return this.boundaries;
    }
    getCommands(): readonly StateWriteDiagnosticCommand[] {
        return this.commands;
    }
}

interface MeasuredWorkloadInput {
    readonly commands: readonly MutationCommand[];
    readonly runtimes: readonly StateWriteWorkloadRuntime[];
    readonly capture: StateWriteCommandCapture | undefined;
    readonly scope: StateScope;
    readonly concurrency: number;
}

export async function executeMeasuredWorkload(
    { commands, runtimes, scope, concurrency, capture }: MeasuredWorkloadInput
): Promise<StateWriteBenchmarkCommand[]> {
    const rawCommands: StateWriteBenchmarkCommand[] = [];
    for (const kind of MUTATION_MIX) {
        const phaseCommands = commands.filter((command) => command.kind === kind);
        const phaseResults = await mapWithConcurrency(
            phaseCommands,
            concurrency,
            async (command, commandIndex) => {
                const stackIndex = selectServiceStack(commandIndex, runtimes.length);
                const runtime = runtimes[stackIndex];
                if (!runtime) {
                    throw new Error(`Missing service runtime at stack ${stackIndex}`);
                }
                const commandId = commandIdentifier(scope, command);
                const commandStartedAt = performance.now();
                try {
                    await executeMeasuredCommand({ runtime, scope, command, requestId: commandId });
                }
                catch (error) {
                    capture?.retain({ commandId, kind, stackIndex, status: 'operation-failed' }, {
                        commandId,
                        startedAtMonotonicMs: commandStartedAt,
                        endedAtMonotonicMs: 'unavailable'
                    });
                    throw error;
                }
                const commandEndedAt = performance.now();
                const result: StateWriteBenchmarkCommand = {
                    commandId,
                    kind,
                    latencyMs: commandEndedAt - commandStartedAt,
                    stackIndex,
                    status: 'accepted'
                };
                capture?.retain(result, {
                    commandId,
                    startedAtMonotonicMs: commandStartedAt,
                    endedAtMonotonicMs: commandEndedAt
                });
                return result;
            }
        );
        rawCommands.push(...phaseResults);
    }
    return rawCommands;
}

interface ExecuteMeasuredCommandInput {
    readonly runtime: StateWriteWorkloadRuntime;
    readonly scope: StateScope;
    readonly command: MutationCommand;
    readonly requestId: string;
}

async function executeMeasuredCommand({
    runtime,
    scope,
    command,
    requestId
}: ExecuteMeasuredCommandInput): Promise<void> {
    const prepared = {
        requestId,
        principalId: `client-${command.clientIndex}`,
        instanceId: `instance-${command.clientIndex}`,
        clientAuthority: createBenchmarkAuthSession(
            scope,
            `client-${command.clientIndex}`,
            `client-session-${command.clientIndex}`
        ),
        ownerAuthority: createBenchmarkAuthSession(
            scope,
            `owner-${command.groupIndex}`,
            `owner-session-${command.groupIndex}`
        ),
        groupId: `group-${command.groupIndex}`,
        ownerId: `owner-${command.groupIndex}`,
        timestamp: Date.now() + command.clientIndex
    };
    const preparedWithPresenceIdentity = {
        ...prepared,
        sessionId: prepared.clientAuthority.sessionId,
        generationId: `${prepared.clientAuthority.sessionId}:generation-1`
    };
    await executeMutation({
        runtime,
        scope,
        kind: command.kind,
        command: preparedWithPresenceIdentity
    });
}

interface ExecuteMutationInput {
    readonly runtime: StateWriteWorkloadRuntime;
    readonly scope: StateScope;
    readonly kind: (typeof MUTATION_MIX)[number];
    readonly command: Readonly<{
        requestId: string;
        principalId: string;
        instanceId: string;
        sessionId: string;
        groupId: string;
        ownerId: string;
        timestamp: number;
        generationId: string;
        clientAuthority: IssuedAuthSession;
        ownerAuthority: IssuedAuthSession;
    }>;
}

interface RoutedBenchmarkMutation extends ExecuteMutationInput {
    readonly clientContextId: string;
    readonly groupContextId: string;
}

async function executeMutation(input: ExecuteMutationInput): Promise<void> {
    const { scope, command } = input;
    const routed: RoutedBenchmarkMutation = {
        ...input,
        clientContextId: toAuthenticatedClientMutationContextId({
            scope,
            principalId: command.principalId,
            callerClientId: command.clientAuthority.clientId,
            callerSessionId: command.clientAuthority.sessionId
        }),
        groupContextId: toStateWriteBenchmarkGroupContextId(scope, command.groupId)
    };
    switch (input.kind) {
        case 'profile-instance':
            await runMeasuredProfileMutation(routed);
            await runMeasuredInstanceMutation(routed);
            return;
        case 'membership':
            await runMeasuredMembershipMutation(routed);
            return;
        case 'presence-connect':
            await runMeasuredPresenceConnect(routed);
            return;
        case 'presence-heartbeat':
            await runMeasuredPresenceHeartbeat(routed);
            return;
        case 'presence-disconnect':
            await runMeasuredPresenceDisconnect(routed);
            return;
        case 'config':
            await runMeasuredConfigMutation(routed);
            return;
        case 'topology-source':
            await runMeasuredTopologyMutation(routed);
            return;
    }
}

async function runMeasuredProfileMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, clientContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: `${command.requestId}-profile`,
                contextId: clientContextId,
                senderId: command.principalId,
                data: {
                    scope,
                    principalId: command.principalId,
                    request: {
                        username: command.principalId,
                        displayName: `${command.principalId}-measured`,
                        metadata: { source: 'state-write-benchmark' },
                        actorPrincipalId: command.principalId,
                        requestId: `${command.requestId}-profile`
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredInstanceMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, clientContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                resourceId: `${command.requestId}-instance`,
                contextId: clientContextId,
                senderId: command.principalId,
                data: {
                    scope,
                    principalId: command.principalId,
                    clientInstanceId: command.instanceId,
                    request: {
                        status: 'active',
                        platform: 'web',
                        appVersion: 'task-12',
                        capabilities: ['state-write-benchmark'],
                        actorPrincipalId: command.principalId,
                        requestId: `${command.requestId}-instance`
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredMembershipMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_MEMBER_UPSERT,
                topicId: AppInboxType.GROUP_MEMBER_UPSERT,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.principalId,
                data: {
                    scope,
                    groupId: command.groupId,
                    principalId: command.principalId,
                    request: {
                        status: 'active',
                        actorPrincipalId: command.principalId,
                        requestId: command.requestId
                    }
                }
            },
            command.clientAuthority
        )
    );
}

async function runMeasuredPresenceConnect(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            connectedAtEpochMs: command.timestamp,
            lastHeartbeatAtEpochMs: command.timestamp,
            expiresAtEpochMs: command.timestamp + 60_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredPresenceHeartbeat(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            lastHeartbeatAtEpochMs: command.timestamp + 1_000,
            expiresAtEpochMs: command.timestamp + 61_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredPresenceDisconnect(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runGroupPresenceMutation({
        runtime,
        command,
        scope,
        contextId: groupContextId,
        type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        request: {
            principalId: command.principalId,
            generationId: command.generationId,
            disconnectedAtEpochMs: command.timestamp + 2_000,
            lastHeartbeatAtEpochMs: command.timestamp + 1_000,
            expiresAtEpochMs: command.timestamp + 61_000,
            actorPrincipalId: command.principalId,
            actorSessionId: command.sessionId,
            requestId: command.requestId
        }
    });
}

async function runMeasuredConfigMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_UPDATE,
                topicId: AppInboxType.GROUP_UPDATE,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.ownerId,
                data: {
                    scope,
                    groupId: command.groupId,
                    request: {
                        metadata: { benchmarkConfigSource: command.requestId },
                        actorPrincipalId: command.ownerId,
                        requestId: command.requestId
                    }
                }
            },
            command.ownerAuthority
        )
    );
}

async function runMeasuredTopologyMutation(
    input: RoutedBenchmarkMutation
): Promise<void> {
    const { runtime, scope, command, groupContextId } = input;
    const data = await toTopologyAppInboxCommand({
        actor: {
            principalId: command.ownerId,
            sessionId: command.ownerAuthority.sessionId
        },
        groupRef: { ...scope, groupId: command.groupId },
        requestId: command.requestId,
        capturedAtEpochMs: command.timestamp,
        payload: {
            operation: 'putConfig',
            config: {
                topologyKind: command.timestamp % 2 === 0 ? 'tree' : 'mesh',
                degreeLimit: 5,
                treeMinSize: 5,
                meshMinSize: 16,
                meshParamK: 2
            }
        }
    });
    await runAppInboxMutation(
        runtime,
        runtime.topology.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                topicId: AppInboxType.TOPOLOGY_CONFIG_PUT,
                resourceId: command.requestId,
                contextId: groupContextId,
                senderId: command.ownerId,
                data
            },
            command.ownerAuthority
        )
    );
}

interface RunGroupPresenceMutationInputBase {
    readonly runtime: StateWriteWorkloadRuntime;
    readonly command: ExecuteMutationInput['command'];
    readonly scope: StateScope;
    readonly contextId: string;
}

type RunGroupPresenceMutationInput =
    & RunGroupPresenceMutationInputBase
    & (
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_CONNECT;
            request: ConnectGroupPresenceSessionRequest;
        }>
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_HEARTBEAT;
            request: HeartbeatGroupPresenceSessionRequest;
        }>
        | Readonly<{
            type: typeof AppInboxType.GROUP_PRESENCE_DISCONNECT;
            request: DisconnectGroupPresenceSessionRequest;
        }>
    );

async function runGroupPresenceMutation(
    input: RunGroupPresenceMutationInput
): Promise<void> {
    await runAppInboxMutation(
        input.runtime,
        input.runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            toGroupPresenceEnqueue(input),
            input.command.clientAuthority
        )
    );
}

function toGroupPresenceEnqueue(
    input: RunGroupPresenceMutationInput
): AuthenticatedGroupMutationEnqueue {
    const command = input.command;
    const shared = {
        topicId: input.type,
        resourceId: command.requestId,
        contextId: input.contextId,
        senderId: command.principalId
    };
    const data = {
        scope: input.scope,
        groupId: command.groupId,
        sessionId: command.sessionId
    };

    switch (input.type) {
        case AppInboxType.GROUP_PRESENCE_CONNECT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
        case AppInboxType.GROUP_PRESENCE_HEARTBEAT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
        case AppInboxType.GROUP_PRESENCE_DISCONNECT:
            return {
                ...shared,
                type: input.type,
                data: { ...data, request: input.request }
            };
    }
}

export async function runAppInboxMutation<Failure extends string | Readonly<{ message: string; }>, Result>(
    runtime: StateWriteWorkloadRuntime,
    operation: Promise<Either<Failure, Result>>
): Promise<void> {
    let settled = false;
    const pending = operation.then(
        (value) => {
            settled = true;
            return { status: 'fulfilled' as const, value };
        },
        (reason: unknown) => {
            settled = true;
            return {
                status: 'rejected' as const,
                reason: reason instanceof Error ? reason : new Error(String(reason))
            };
        }
    );
    while (!settled) {
        await runtime.inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            runtime.resilience
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const completion = await pending;
    if (completion.status === 'rejected') {
        throw completion.reason;
    }
    completion.value.fold(
        (error) => {
            throw new Error(typeof error === 'string' ? error : error.message);
        },
        () => undefined
    );
}

export function createCommands(
    workload: (typeof WORKLOADS)[number]
): MutationCommand[] {
    return MUTATION_MIX.flatMap((kind) =>
        Array.from({ length: workload.clients }, (_, clientIndex) => ({
            kind,
            clientIndex,
            groupIndex: clientIndex % workload.groups
        }))
    );
}

function commandIdentifier(
    scope: StateScope,
    command: MutationCommand
): string {
    return `${scope.applicationId}:${command.kind}:${command.clientIndex}`;
}

function selectServiceStack(commandIndex: number, stackCount: number): number {
    if (!Number.isInteger(commandIndex) || commandIndex < 0) {
        throw new Error('commandIndex must be a non-negative integer');
    }
    if (!Number.isInteger(stackCount) || stackCount < 1) {
        throw new Error('stackCount must be a positive integer');
    }
    return commandIndex % stackCount;
}
