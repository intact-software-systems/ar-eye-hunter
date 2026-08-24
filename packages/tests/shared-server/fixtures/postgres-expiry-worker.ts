import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { DeleteGroupTopologyConfigInput, PutGroupTopologyConfigInput } from '@shared-server/rallar-system/topology/group-topology-management-contracts.ts';
import { fromCanonicalGroupTopologyConfigPatch, toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    BanGroupMemberRequest,
    ConnectClientSessionRequest,
    ConnectGroupPresenceSessionRequest,
    DisconnectClientSessionRequest,
    DisconnectGroupPresenceSessionRequest,
    HeartbeatClientSessionRequest,
    HeartbeatGroupPresenceSessionRequest,
    JoinGroupRequest,
    StateScope
} from '@shared/api/state-types.ts';
import postgres from 'postgres';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import {
    toClientMutationCommand,
    toConnectCommandInput,
    toDisconnectCommandInput,
    toHeartbeatCommandInput
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { type ClientMutationReceipt } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { GroupStateRepositoryReads } from '@shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';

import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';

import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import { type GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';

import {
    isAuthenticatedGroupMutationEnqueue,
    type AuthenticatedGroupMutationEnqueue
} from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import { requireGroupMutationReceipt } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result-codec.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { createPostgresAppInboxWorkerRuntime, toGroupAppInboxStorageCommandId, type PersistedAppInboxAttempt } from './postgres-app-inbox-worker-runtime.ts';
import { toPSqlSql } from './postgres-sql-adapter.ts';

import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

interface WorkerBarrier {
    readonly readyDirectoryPath: string;
    readonly releaseFilePath: string;
}

interface WorkerCommandBase {
    readonly scope: StateScope;
    readonly atEpochMs: number;
    readonly traceFilePath: string;
    readonly barrier: WorkerBarrier;
}

type WorkerMutationRequest<T> =
    & Omit<T, 'requestId'>
    & Readonly<{
        requestId: string;
    }>;

type ClientWorkerInput =
    & WorkerCommandBase
    & Readonly<{
        principalId: string;
        clientInstanceId: string;
        sessionId: string;
    }>
    & (
        | Readonly<{
            command: 'client-heartbeat';
            request: WorkerMutationRequest<HeartbeatClientSessionRequest>;
        }>
        | Readonly<{
            command: 'client-disconnect';
            request: WorkerMutationRequest<DisconnectClientSessionRequest>;
        }>
        | Readonly<{
            command: 'client-reconnect';
            request: WorkerMutationRequest<ConnectClientSessionRequest>;
        }>
    );

type GroupWorkerInput =
    & WorkerCommandBase
    & Readonly<{
        groupId: string;
    }>
    & (
        | Readonly<{
            command: 'group-join';
            request: WorkerMutationRequest<JoinGroupRequest>;
        }>
        | Readonly<{
            command: 'group-ban';
            targetPrincipalId: string;
            request: WorkerMutationRequest<BanGroupMemberRequest>;
        }>
        | Readonly<{
            command: 'group-presence-connect';
            sessionId: string;
            request: WorkerMutationRequest<ConnectGroupPresenceSessionRequest>;
        }>
        | Readonly<{
            command: 'group-presence-heartbeat';
            sessionId: string;
            request: WorkerMutationRequest<HeartbeatGroupPresenceSessionRequest>;
        }>
        | Readonly<{
            command: 'group-presence-disconnect';
            sessionId: string;
            request: WorkerMutationRequest<DisconnectGroupPresenceSessionRequest>;
        }>
    );

type TopologyWorkerInput =
    & Readonly<{
        groupRef: GroupRef;
        atEpochMs: number;
        traceFilePath: string;
        barrier: WorkerBarrier;
    }>
    & (
        | Readonly<{
            command: 'topology-config-put';
            request: WorkerMutationRequest<Omit<PutGroupTopologyConfigInput, 'groupRef'>>;
        }>
        | Readonly<{
            command: 'topology-config-delete';
            request: WorkerMutationRequest<Omit<DeleteGroupTopologyConfigInput, 'groupRef'>>;
        }>
    );

type StateMutationWorkerInput = ClientWorkerInput | GroupWorkerInput | TopologyWorkerInput;

interface CompactStateMutationWorkerOutput {
    readonly operation: StateMutationWorkerInput['command'];
    readonly requestId: string;
    readonly commandHash: string;
    readonly attemptCount: number;
    readonly acceptedStorageRevision: number | null;
    readonly acceptedCausalRevision: JsonWireObject | null;
    readonly acceptedVersion: number | null;
    readonly outboxIds: readonly string[];
    readonly domainStatus: 'applied' | 'no-op' | 'rejected';
}

interface WorkerTraceState {
    backendPid: number;
    barrierWaitCount: number;
    attempts: PersistedAppInboxAttempt[];
}

async function main(): Promise<void> {
    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required for postgres-expiry-worker');
    }

    const inputValue = readInputValue();
    const traceFilePath = readWorkerTraceFilePath(inputValue);
    const postgresSql = postgres(databaseUrl, { max: 2, idle_timeout: 1 });
    const sql = toPSqlSql(postgresSql);

    try {
        const [{ pid }] = await sql<{ pid: number; }[]>`
        select pg_backend_pid()::int as pid
    `;
        const trace: WorkerTraceState = {
            backendPid: pid,
            barrierWaitCount: 0,
            attempts: []
        };
        try {
            const input = decodeStateMutationWorkerInput(inputValue);
            console.log(JSON.stringify(await runStateMutationWorker(input, sql, trace)));
        }
        finally {
            await Deno.writeTextFile(traceFilePath, JSON.stringify(trace));
        }
    }
    finally {
        await postgresSql.end();
    }
}

async function runStateMutationWorker(
    input: StateMutationWorkerInput,
    sql: PSqlSql,
    trace: WorkerTraceState
): Promise<CompactStateMutationWorkerOutput> {
    requireRequestId(input.request.requestId);
    switch (input.command) {
        case 'client-heartbeat':
        case 'client-disconnect':
        case 'client-reconnect':
            return await runClientMutation(input, sql, trace);
        case 'group-join':
        case 'group-ban':
        case 'group-presence-connect':
        case 'group-presence-heartbeat':
        case 'group-presence-disconnect':
            return await runGroupMutation(input, sql, trace);
        case 'topology-config-put':
        case 'topology-config-delete':
            return await runTopologyMutation(input, sql, trace);
    }
}

async function runClientMutation(
    input: ClientWorkerInput,
    sql: PSqlSql,
    trace: WorkerTraceState
): Promise<CompactStateMutationWorkerOutput> {
    const requestId = requireRequestId(input.request.requestId);
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId: `postgres-state-worker-${Deno.pid}`,
        atEpochMs: input.atEpochMs,
        barrier: input.barrier,
        trace
    });
    const authoritySession: IssuedAuthSession = {
        clientId: input.principalId,
        accessToken: `${input.sessionId}-postgres-worker-token`,
        username: input.principalId,
        sessionId: input.sessionId,
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 4_102_444_800_000
    };
    await runtime.authSessions.putSession(authoritySession);
    runtime.armBarrier();
    const contextId = toAuthenticatedClientMutationContextId({
        scope: input.scope,
        principalId: input.principalId,
        callerClientId: authoritySession.clientId,
        callerSessionId: authoritySession.sessionId
    });
    const type = toClientAppInboxType(input.command);
    const data = {
        scope: input.scope,
        principalId: input.principalId,
        clientInstanceId: input.clientInstanceId,
        sessionId: input.sessionId,
        request: input.request
    };
    const result = await runtime.runUntilCompletion(() =>
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type,
                topicId: type,
                resourceId: requestId,
                contextId,
                senderId: input.principalId,
                data
            },
            authoritySession
        )
    );
    const written = result.fold(
        (error) => {
            throw new Error(error.message);
        },
        (value) => value
    );

    const stored = await new ClientStateRepository(
        new PSqlRuntimeStateRepository(sql),
        new PSqlClientStateEventRepository(sql)
    ).findIdempotentClientMutationReceipt(
        { ...input.scope, principalId: input.principalId },
        requestId
    );
    if (stored) {
        return compactClientReceipt(input.command, requestId, stored.receipt);
    }
    const mutation = written.result;
    if (!mutation || mutation.event !== null) {
        throw new Error(`Applied client mutation receipt not found: ${requestId}`);
    }
    const entry = await runtime.resourceInbox.entries.findAnyByKey(
        toAppQueueKey({
            topicId: type,
            resourceId: requestId,
            contextId
        })
    );
    if (!entry || entry.status !== 'COMPLETED') {
        throw new Error(`Completed client AppInbox entry not found: ${requestId}`);
    }
    const commandInput = toClientWorkerCommandInput(input);
    const command = await toClientMutationCommand(
        commandInput,
        {
            nowEpochMs: input.atEpochMs,
            serviceId: `postgres-state-worker-${Deno.pid}`,
            eventId: `postgres-client-event:${requestId}`,
            attemptCount: entry.dequeueAudit.attempts,
            expireAtEpochMs: Number(entry.audit.expiryTs.epochMilliseconds)
        },
        toClientMutationIssuedSessionAuthority(
            authoritySession,
            commandInput.aggregateRef,
            commandInput.operation
        )
    );
    return {
        operation: input.command,
        requestId,
        commandHash: command.facts.commandHash,
        attemptCount: entry.dequeueAudit.attempts,
        acceptedStorageRevision: null,
        acceptedCausalRevision: null,
        acceptedVersion: null,
        outboxIds: [],
        domainStatus: 'no-op'
    };
}

function toClientWorkerCommandInput(
    input: ClientWorkerInput
): Exclude<ClientMutationCommandInput, { readonly operation: 'expireSession'; }> {
    if (input.command === 'client-heartbeat') {
        const commandInput = toHeartbeatCommandInput(
            input.scope,
            input.principalId,
            input.clientInstanceId,
            input.sessionId,
            input.request,
            input.request.requestId
        );
        if (commandInput.operation !== 'heartbeatSession') {
            throw new TypeError(`Expected heartbeatSession, received ${commandInput.operation}`);
        }
        return commandInput;
    }
    if (input.command === 'client-disconnect') {
        const commandInput = toDisconnectCommandInput(
            'disconnectSession',
            input.scope,
            input.principalId,
            input.clientInstanceId,
            input.sessionId,
            input.request,
            input.request.requestId
        );
        if (commandInput.operation !== 'disconnectSession') {
            throw new TypeError(`Expected disconnectSession, received ${commandInput.operation}`);
        }
        return commandInput;
    }
    const commandInput = toConnectCommandInput(
        'connectSession',
        input.scope,
        input.principalId,
        input.clientInstanceId,
        input.sessionId,
        input.request,
        input.request.requestId,
        {}
    );
    if (commandInput.operation !== 'connectSession') {
        throw new TypeError(`Expected connectSession, received ${commandInput.operation}`);
    }
    return commandInput;
}

function toClientAppInboxType(command: ClientWorkerInput['command']): AppInboxType {
    if (command === 'client-heartbeat') {
        return AppInboxType.CLIENT_SESSION_HEARTBEAT;
    }
    if (command === 'client-disconnect') {
        return AppInboxType.CLIENT_SESSION_DISCONNECT;
    }
    return AppInboxType.CLIENT_SESSION_CONNECT;
}

function inboxContextId(...parts: string[]): string {
    return parts.map(encodeURIComponent).join(':');
}

async function runGroupMutation(
    input: GroupWorkerInput,
    sql: PSqlSql,
    trace: WorkerTraceState
): Promise<CompactStateMutationWorkerOutput> {
    const requestId = requireRequestId(input.request.requestId);
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId: `postgres-state-worker-${Deno.pid}`,
        atEpochMs: input.atEpochMs,
        barrier: input.barrier,
        trace
    });
    const actorPrincipalId = requireString(input.request.actorPrincipalId, 'actorPrincipalId');
    const actorSessionId = requireString(input.request.actorSessionId, 'actorSessionId');
    const authority: IssuedAuthSession = {
        clientId: actorPrincipalId,
        accessToken: `${actorSessionId}-postgres-worker-token`,
        username: actorPrincipalId,
        sessionId: actorSessionId,
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 4_102_444_800_000
    };
    await runtime.authSessions.putSession(authority);
    const data = toGroupAppInboxData(input);
    const type = toGroupAppInboxType(input.command);
    const enqueue = {
        type,
        resourceId: requestId,
        contextId: inboxContextId(input.scope.applicationId, input.scope.workspaceId, input.groupId),
        senderId: actorPrincipalId,
        data
    };
    if (!isAuthenticatedGroupMutationEnqueue(enqueue)) {
        throw new TypeError(`Authenticated group mutation type is required: ${enqueue.type}`);
    }
    runtime.armBarrier();
    const result = await runtime.runUntilCompletion(() => runtime.group.processAuthenticatedGroupEntryUntilCompletion(enqueue, authority));
    const durableResult = result.fold(
        (error) => {
            throw new Error(error.message);
        },
        (value) => value
    );

    const receipt = isGroupPresenceCommand(input.command)
        ? requireGroupMutationReceipt(durableResult)
        : (
            await new GroupStateRepositoryReads(
                new PSqlRuntimeStateRepository(sql)
            ).findIdempotentGroupMutationReceipt(
                { ...input.scope, groupId: input.groupId },
                await toGroupAppInboxStorageCommandId(enqueue, authority.clientId)
            )
        )?.receipt;
    if (!receipt) {
        throw new Error(`Group mutation receipt not found: ${requestId}`);
    }
    return compactGroupReceipt(input.command, requestId, receipt);
}

function toGroupAppInboxType(command: GroupWorkerInput['command']): AppInboxType {
    switch (command) {
        case 'group-join':
            return AppInboxType.GROUP_JOIN;
        case 'group-ban':
            return AppInboxType.GROUP_MEMBER_BAN;
        case 'group-presence-connect':
            return AppInboxType.GROUP_PRESENCE_CONNECT;
        case 'group-presence-heartbeat':
            return AppInboxType.GROUP_PRESENCE_HEARTBEAT;
        case 'group-presence-disconnect':
            return AppInboxType.GROUP_PRESENCE_DISCONNECT;
    }
}

function toGroupAppInboxData(input: GroupWorkerInput): AuthenticatedGroupMutationEnqueue['data'] {
    if (input.command === 'group-ban') {
        return {
            scope: input.scope,
            groupId: input.groupId,
            principalId: requireString(input.targetPrincipalId, 'targetPrincipalId'),
            request: input.request
        };
    }
    if (input.command === 'group-join') {
        return { scope: input.scope, groupId: input.groupId, request: input.request };
    }
    return {
        scope: input.scope,
        groupId: input.groupId,
        sessionId: requireString(input.sessionId, 'sessionId'),
        request: input.request
    };
}

function isGroupPresenceCommand(command: GroupWorkerInput['command']): boolean {
    return command.startsWith('group-presence-');
}

async function runTopologyMutation(
    input: TopologyWorkerInput,
    sql: PSqlSql,
    trace: WorkerTraceState
): Promise<CompactStateMutationWorkerOutput> {
    const requestId = requireRequestId(input.request.requestId);
    const runtime = createPostgresAppInboxWorkerRuntime({
        sql,
        serviceId: `postgres-state-worker-${Deno.pid}`,
        atEpochMs: input.atEpochMs,
        barrier: input.barrier,
        trace
    });
    const principalId = requireString(input.request.updatedByPrincipalId, 'updatedByPrincipalId');
    const authority: IssuedAuthSession = {
        clientId: principalId,
        accessToken: `${principalId}-topology-worker-token`,
        username: principalId,
        sessionId: `${principalId}-session`,
        issuedAtEpochMs: 0,
        expiresAtEpochMs: 4_102_444_800_000
    };
    await runtime.authSessions.putSession(authority);
    const data = await toTopologyAppInboxCommand({
        actor: { principalId, sessionId: authority.sessionId },
        groupRef: input.groupRef,
        requestId,
        capturedAtEpochMs: input.atEpochMs,
        payload: input.command === 'topology-config-put'
            ? { operation: 'putConfig', config: input.request.config }
            : { operation: 'deleteConfig', target: 'config' }
    });
    runtime.armBarrier();
    const result = await runtime.runUntilCompletion(() =>
        runtime.topology.processAuthenticatedEntryUntilCompletion(
            {
                type: input.command === 'topology-config-put'
                    ? AppInboxType.TOPOLOGY_CONFIG_PUT
                    : AppInboxType.TOPOLOGY_CONFIG_DELETE,
                resourceId: requestId,
                contextId: inboxContextId(
                    input.groupRef.applicationId,
                    input.groupRef.workspaceId,
                    input.groupRef.groupId
                ),
                senderId: principalId,
                data
            },
            authority
        )
    );
    const execution = result.fold(
        (error) => {
            throw new Error(error.message);
        },
        (value) => {
            if (!('receipt' in value)) {
                throw new TypeError('Expected topology config result');
            }
            return value;
        }
    );
    return compactTopologyReceipt(input.command, requestId, execution.receipt);
}

function compactClientReceipt(
    operation: ClientWorkerInput['command'],
    requestId: string,
    receipt: ClientMutationReceipt
): CompactStateMutationWorkerOutput {
    return {
        operation,
        requestId: requireMatchingRequestId(receipt.requestId, requestId),
        commandHash: receipt.commandHash,
        attemptCount: receipt.attemptCount,
        acceptedStorageRevision: receipt.acceptedStorageRevision,
        acceptedCausalRevision: {
            kind: 'client',
            stateRevision: receipt.stateRevision,
            snapshotVersion: receipt.snapshotVersion,
            presenceVersion: receipt.presenceVersion
        },
        acceptedVersion: null,
        outboxIds: [...receipt.outboxIds],
        domainStatus: receipt.outcome
    };
}

function compactGroupReceipt(
    operation: GroupWorkerInput['command'],
    requestId: string,
    receipt: GroupMutationReceipt
): CompactStateMutationWorkerOutput {
    return {
        operation,
        requestId: requireMatchingRequestId(receipt.requestId, requestId),
        commandHash: receipt.commandHash,
        attemptCount: receipt.attemptCount,
        acceptedStorageRevision: receipt.acceptedStorageRevision,
        acceptedCausalRevision: {
            kind: 'group',
            causalRevision: { ...receipt.causalRevision },
            snapshotVersion: receipt.snapshotVersion
        },
        acceptedVersion: null,
        outboxIds: [...receipt.outboxIds],
        domainStatus: receipt.outcome
    };
}

function compactTopologyReceipt(
    operation: TopologyWorkerInput['command'],
    requestId: string,
    receipt: GroupTopologyConfigMutationReceipt
): CompactStateMutationWorkerOutput {
    return {
        operation,
        requestId: requireMatchingRequestId(receipt.requestId, requestId),
        commandHash: receipt.commandHash,
        attemptCount: receipt.attemptCount,
        acceptedStorageRevision: receipt.acceptedStorageRevision,
        acceptedCausalRevision: receipt.acceptedCausalRevision === null ? null : {
            ...receipt.acceptedCausalRevision,
            causalRevision: { ...receipt.acceptedCausalRevision.causalRevision }
        },
        acceptedVersion: receipt.acceptedVersion,
        outboxIds: [...receipt.outboxIds],
        domainStatus: receipt.outcome
    };
}

function readInputValue(): JsonWireValue {
    const raw = Deno.env.get('RALLAR_EXPIRY_WORKER_INPUT');
    if (!raw) {
        throw new Error('RALLAR_EXPIRY_WORKER_INPUT is required');
    }
    return JSON.parse(raw);
}

function readWorkerTraceFilePath(value: JsonWireValue): string {
    if (!isRecord(value)) {
        throw new TypeError('State mutation worker input must be an object');
    }
    return requireString(value.traceFilePath, 'traceFilePath');
}

function decodeStateMutationWorkerInput(value: JsonWireValue): StateMutationWorkerInput {
    if (!isRecord(value) || !isRecord(value.request)) {
        throw new TypeError('State mutation worker input must contain a request object');
    }
    requireRequestId(value.request.requestId);
    if (!isStateMutationWorkerInput(value)) {
        throw new TypeError('State mutation worker input is invalid');
    }
    return value;
}

function isStateMutationWorkerInput(
    value: JsonWireValue
): value is StateMutationWorkerInput & JsonWireObject {
    if (!isRecord(value) || !hasWorkerRuntimeFields(value)) {
        return false;
    }
    switch (value.command) {
        case 'client-heartbeat':
            return hasClientWorkerFields(value) && isClientHeartbeatRequest(value.request);
        case 'client-disconnect':
            return hasClientWorkerFields(value) && isClientDisconnectRequest(value.request);
        case 'client-reconnect':
            return hasClientWorkerFields(value) && isClientReconnectRequest(value.request);
        case 'group-join':
            return hasGroupWorkerFields(value, false, false) && isGroupJoinRequest(value.request);
        case 'group-ban':
            return hasGroupWorkerFields(value, true, false) && isMutationActorRequest(value.request);
        case 'group-presence-connect':
            return (
                hasGroupWorkerFields(value, false, true) && isGroupPresenceConnectRequest(value.request)
            );
        case 'group-presence-heartbeat':
            return (
                hasGroupWorkerFields(value, false, true) && isGroupPresenceHeartbeatRequest(value.request)
            );
        case 'group-presence-disconnect':
            return (
                hasGroupWorkerFields(value, false, true) && isGroupPresenceDisconnectRequest(value.request)
            );
        case 'topology-config-put':
            return hasTopologyWorkerFields(value) && isTopologyPutRequest(value.request);
        case 'topology-config-delete':
            return hasTopologyWorkerFields(value) && isTopologyDeleteRequest(value.request);
        default:
            return false;
    }
}

function hasWorkerRuntimeFields(value: JsonWireObject): boolean {
    return (
        typeof value.command === 'string' &&
        Number.isSafeInteger(value.atEpochMs) &&
        Number(value.atEpochMs) >= 0 &&
        isNonEmptyString(value.traceFilePath) &&
        isWorkerBarrier(value.barrier) &&
        isRecord(value.request)
    );
}

function hasClientWorkerFields(value: JsonWireObject): boolean {
    return (
        hasOnlyKeys(value, [
            'command',
            'scope',
            'atEpochMs',
            'traceFilePath',
            'barrier',
            'principalId',
            'clientInstanceId',
            'sessionId',
            'request'
        ]) &&
        isStateScope(value.scope) &&
        isNonEmptyString(value.principalId) &&
        isNonEmptyString(value.clientInstanceId) &&
        isNonEmptyString(value.sessionId)
    );
}

function hasGroupWorkerFields(
    value: JsonWireObject,
    hasTargetPrincipalId: boolean,
    hasSessionId: boolean
): boolean {
    const conditionalKeys = [
        ...(hasTargetPrincipalId ? ['targetPrincipalId'] : []),
        ...(hasSessionId ? ['sessionId'] : [])
    ];
    return (
        hasOnlyKeys(value, [
            'command',
            'scope',
            'groupId',
            'atEpochMs',
            'traceFilePath',
            'barrier',
            'request',
            ...conditionalKeys
        ]) &&
        isStateScope(value.scope) &&
        isNonEmptyString(value.groupId) &&
        (!hasTargetPrincipalId || isNonEmptyString(value.targetPrincipalId)) &&
        (!hasSessionId || isNonEmptyString(value.sessionId))
    );
}

function hasTopologyWorkerFields(value: JsonWireObject): boolean {
    return (
        hasOnlyKeys(value, [
            'command',
            'groupRef',
            'atEpochMs',
            'traceFilePath',
            'barrier',
            'request'
        ]) && isGroupRef(value.groupRef)
    );
}

function isClientHeartbeatRequest(
    value: JsonWireValue
): value is ClientWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'generationId',
            'presenceState',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isNonEmptyString(value.generationId) &&
        isOptionalOneOf(value.presenceState, ['online', 'offline', 'away', 'busy']) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isClientDisconnectRequest(
    value: JsonWireValue
): value is ClientWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'generationId',
            'disconnectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isNonEmptyString(value.generationId) &&
        isOptionalEpoch(value.disconnectedAtEpochMs) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isClientReconnectRequest(
    value: JsonWireValue
): value is ClientWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'generationId',
            'presenceState',
            'transport',
            'connectionId',
            'authenticatedAtEpochMs',
            'connectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isNonEmptyString(value.generationId) &&
        isOptionalOneOf(value.presenceState, ['online', 'offline', 'away', 'busy']) &&
        isOptionalOneOf(value.transport, ['ws', 'http', 'rtc', 'unknown']) &&
        isOptionalString(value.connectionId) &&
        isOptionalEpoch(value.authenticatedAtEpochMs) &&
        isOptionalEpoch(value.connectedAtEpochMs) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isGroupJoinRequest(
    value: JsonWireValue
): value is GroupWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [...MUTATION_ACTOR_KEYS, 'inviteToken', 'joinCode']) &&
        isOptionalString(value.inviteToken) &&
        isOptionalString(value.joinCode)
    );
}

function isGroupPresenceConnectRequest(
    value: JsonWireValue
): value is GroupWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'principalId',
            'generationId',
            'connectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isNonEmptyString(value.principalId) &&
        isNonEmptyString(value.generationId) &&
        isOptionalEpoch(value.connectedAtEpochMs) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isGroupPresenceHeartbeatRequest(
    value: JsonWireValue
): value is GroupWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'principalId',
            'generationId',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isOptionalString(value.principalId) &&
        isNonEmptyString(value.generationId) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isGroupPresenceDisconnectRequest(
    value: JsonWireValue
): value is GroupWorkerInput['request'] & JsonWireObject {
    return (
        isMutationActorRequest(value) &&
        hasOnlyKeys(value, [
            ...MUTATION_ACTOR_KEYS,
            'principalId',
            'generationId',
            'disconnectedAtEpochMs',
            'lastHeartbeatAtEpochMs',
            'expiresAtEpochMs'
        ]) &&
        isOptionalString(value.principalId) &&
        isNonEmptyString(value.generationId) &&
        isOptionalEpoch(value.disconnectedAtEpochMs) &&
        isOptionalEpoch(value.lastHeartbeatAtEpochMs) &&
        isOptionalEpoch(value.expiresAtEpochMs)
    );
}

function isTopologyPutRequest(
    value: JsonWireValue
): value is TopologyWorkerInput['request'] & JsonWireObject {
    return (
        isTopologyRequest(value) &&
        hasOnlyKeys(value, ['requestId', 'updatedByPrincipalId', 'config']) &&
        isTopologyConfigPatch(value.config)
    );
}

function isTopologyDeleteRequest(
    value: JsonWireValue
): value is TopologyWorkerInput['request'] & JsonWireObject {
    return isTopologyRequest(value) && hasOnlyKeys(value, ['requestId', 'updatedByPrincipalId']);
}

const MUTATION_ACTOR_KEYS = [
    'actorPrincipalId',
    'actorSessionId',
    'reason',
    'traceId',
    'requestId'
] as const;

function isMutationActorRequest(value: JsonWireValue): value is JsonWireObject & {
    requestId: string;
} {
    return (
        isRecord(value) &&
        isNonEmptyString(value.requestId) &&
        isOptionalString(value.actorPrincipalId) &&
        isOptionalString(value.actorSessionId) &&
        isOptionalString(value.reason) &&
        isOptionalString(value.traceId)
    );
}

function isTopologyRequest(value: JsonWireValue): value is JsonWireObject & {
    requestId: string;
    updatedByPrincipalId: string;
} {
    return (
        isRecord(value) &&
        isNonEmptyString(value.requestId) &&
        isNonEmptyString(value.updatedByPrincipalId)
    );
}

function isTopologyConfigPatch(value: JsonWireValue): boolean {
    try {
        fromCanonicalGroupTopologyConfigPatch(toCanonicalGroupTopologyConfigPatch(value));
        return true;
    }
    catch {
        return false;
    }
}

function isStateScope(value: JsonWireValue): value is StateScope & JsonWireObject {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ['applicationId', 'workspaceId']) &&
        isNonEmptyString(value.applicationId) &&
        isNonEmptyString(value.workspaceId)
    );
}

function isGroupRef(value: JsonWireValue): value is GroupRef & JsonWireObject {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ['applicationId', 'workspaceId', 'groupId']) &&
        isNonEmptyString(value.applicationId) &&
        isNonEmptyString(value.workspaceId) &&
        isNonEmptyString(value.groupId)
    );
}

function isWorkerBarrier(value: JsonWireValue): value is WorkerBarrier & JsonWireObject {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ['readyDirectoryPath', 'releaseFilePath']) &&
        isNonEmptyString(value.readyDirectoryPath) &&
        isNonEmptyString(value.releaseFilePath)
    );
}

function isRecord(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonWireObject, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function isOptionalString(value: JsonWireValue | undefined): boolean {
    return value === undefined || typeof value === 'string';
}

function isOptionalEpoch(value: JsonWireValue | undefined): boolean {
    return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isOptionalOneOf(value: JsonWireValue | undefined, values: readonly string[]): boolean {
    return value === undefined || (typeof value === 'string' && values.includes(value));
}

function isNonEmptyString(value: JsonWireValue): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function requireRequestId(requestId: JsonWireValue): string {
    return requireString(requestId, 'requestId');
}

function requireMatchingRequestId(actual: string | null, expected: string): string {
    if (actual !== expected) {
        throw new Error(`Mutation receipt requestId differs: expected ${expected}`);
    }
    return actual;
}

function requireString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} is required`);
    }
    return value;
}

await main();
